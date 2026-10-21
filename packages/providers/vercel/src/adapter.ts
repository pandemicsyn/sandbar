import { z } from "zod";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { pack } from "tar-stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AdapterError,
  AdapterFilesystemError,
  type AdapterErrorCode,
  type FileTransferContext,
  type Mutation,
  type CreateInput,
  type CreateValue,
  type SnapshotProfile,
  type SnapshotInfo,
  ResourceReference,
  resolveSnapshot,
  defineAdapter,
  assertResourceScope,
  assertResourceIdentity,
  sandboxReference,
  smallestSize,
  defaultLifetime,
  ResourceMinimums,
  unknownSandboxFacts,
  type Fact,
  type SandboxResources,
  type Sandbox,
  type SandboxReference,
  type SandboxInfo,
  type ReadContext,
  type ProcessObservationFailure,
  Preserve,
  PreserveSchema,
} from "@sandbar-sdk/adapter";
import {
  boundedBody,
  VercelClient,
  VercelRequestRejected,
  type VercelTransport,
} from "./transport";
import { startVercelProcess, reopenVercelProcess } from "./process-native";
import { filesystemHelper, filesystemValue, directorySchema, fileStat } from "./filesystem";
import { captureHelper, captureSpec, decodeReceipt } from "./capture";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const policy = z.enum(["blocked", "internet", "vercel-deny-all", "vercel-allow-all"]);

/** Deprecated native spellings, resolved to portable names for config and SDK inputs. */
const networkPolicyAliases = {
  "vercel-deny-all": "blocked",
  "vercel-allow-all": "internet",
} as const;

const portablePolicy = (value: z.infer<typeof policy>): "blocked" | "internet" =>
  value === "blocked" || value === "internet" ? value : networkPolicyAliases[value];

/**
 * Vercel sizes, smallest first: 1 or an even count up to 32 vCPUs, each with 2 GiB of memory.
 * Vercel itself rejects a size above the team's plan limit.
 */
const SIZES = [1, ...Array.from({ length: 16 }, (_, index) => (index + 1) * 2)].map((vcpus) => ({
  vcpus,
  memoryMiB: vcpus * 2048,
}));

/** Vercel's longest plan limit (Pro and Enterprise, 24 hours); Vercel enforces lower plan limits itself. */
const MAX_SESSION_SECONDS = 86_400;

/** Vercel's shortest session timeout is one minute; shorter lifetimes round up to it. */
function sessionLifetime(seconds: number): number {
  return Math.max(60, seconds);
}

export const vercelConfig = z.strictObject({
  teamId: id,
  projectId: id,
  region: z
    .enum([
      "iad1",
      "sfo1",
      "cle1",
      "cdg1",
      "fra1",
      "arn1",
      "sin1",
      "pdx1",
      "lhr1",
      "icn1",
      "bom1",
      "cpt1",
      "dub1",
      "gru1",
      "hkg1",
      "syd1",
      "yul1",
      "hnd1",
      "kix1",
    ])
    .default("iad1"),
  /** Minimum size; the smallest vCPU count that meets it is used (2 GiB of memory per vCPU). */
  resources: ResourceMinimums.optional(),
  /** @deprecated Use `resources: { vcpus }`. */
  vcpus: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional(),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .max(15)
    .refine((ports) => new Set(ports).size === ports.length, "Ports must be unique")
    .default([]),
  image: z
    .enum([
      "vercel/sandbox/node:22",
      "vercel/sandbox/node:24",
      "vercel/sandbox/node:26",
      "vercel/sandbox/universal:latest",
    ])
    .default("vercel/sandbox/universal:latest"),
  lifecycle: z
    .strictObject({
      /** Session lifetime; under a minute rounds up to Vercel's minimum of 60 seconds. */
      lifetimeSeconds: z.number().int().positive().max(MAX_SESSION_SECONDS).optional(),
    })
    .optional(),
  /** @deprecated Use `lifecycle: { lifetimeSeconds }`. */
  timeoutSeconds: z.number().int().min(60).max(MAX_SESSION_SECONDS).optional(),
  persistent: z.boolean().default(false),
  snapshots: z
    .strictObject({
      /** Vercel snapshots keep the filesystem only; `filesystem+memory` rejects at connect. */
      preserve: PreserveSchema.optional(),
      /**
       * Seconds Vercel keeps each `snapshot()` capture after its last use; `0` never expires.
       * Omitted keeps Vercel's 30-day default. Applies to disposable mode, where capture runs.
       */
      retentionSeconds: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
  network: policy.optional(),
  /** @deprecated Use `network`. */
  networkPolicy: policy.optional(),
});

const sessionSchema = z.object({
  id,
  region: z.string(),
  status: z.enum([
    "pending",
    "running",
    "stopping",
    "stopped",
    "failed",
    "aborted",
    "snapshotting",
  ]),
  networkPolicy: z.object({ mode: z.string() }).optional(),
  startedAt: z.number().optional(),
  timeout: z.number().optional(),
  sourceSnapshotId: id.optional(),
  vcpus: z.number().optional(),
});

/** Vercel reports the session's vCPUs; memory is fixed at 2 GiB per vCPU. */
function sessionSize(session: z.infer<typeof sessionSchema>): Fact<SandboxResources> {
  return session.vcpus !== undefined && Number.isInteger(session.vcpus) && session.vcpus > 0
    ? { status: "known", value: { vcpus: session.vcpus, memoryMiB: session.vcpus * 2048 } }
    : { status: "unknown", reason: "Vercel did not report the session size" };
}

const nativeBox = z.object({
  name: z.string(),
  currentSessionId: id,
  persistent: z.boolean(),
  createdAt: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  currentSnapshotId: id.optional(),
  image: z.string().optional(),
  mounts: z.record(z.string(), z.json()).optional(),
  region: z.string().optional(),
  status: sessionSchema.shape.status,
  networkPolicy: z.object({ mode: z.string() }).optional(),
});

const page = z.object({
  sandboxes: z.array(nativeBox).max(100),
  pagination: z.object({ next: z.string().nullable() }),
});

const command = z.object({
  command: z.object({ id, sessionId: id, exitCode: z.number().int().nullable() }),
});

const createToken = z.strictObject({
  version: z.literal(1),
  sessionId: id,
  validated: z.boolean(),
  reference: ResourceReference.extend({ kind: z.literal("sandbox") }).optional(),
  imageIdentity: z.string().optional(),
  sourceSnapshotId: id.optional(),
});

const execToken = z.strictObject({
  version: z.literal(1),
  sessionId: id,
  reference: ResourceReference.optional(),
  commandId: id.optional(),
  stdinPath: z
    .string()
    .regex(/^\/tmp\/sandbar-stdin-[0-9a-f-]{36}$/)
    .optional(),
  maxBytes: z.number().int().min(0).max(1048576),
  confirmedExit: z.strictObject({ exitCode: z.number().int() }).optional(),
});

type NativeRetention = { keepLastSnapshots?: { count: number; deleteEvicted: boolean } };

const maxBytes = 1048576;

// Statuses Vercel returns before it accepts a sandbox. A 409 can mean an earlier
// attempt already owns the persistent name, so it stays uncertain.
const createRejections = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [402, "CAPACITY"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
]);

function state(
  status: z.infer<typeof sessionSchema>["status"],
): "running" | "destroyed" | "unknown" {
  if (status === "running") return "running";

  if (status === "stopped" || status === "aborted") return "destroyed";

  return "unknown";
}

function path(value: string) {
  if (
    !value.startsWith("/") ||
    (value !== "/" && value.endsWith("/")) ||
    value.includes("\0") ||
    value.split("/").some((s) => s === "." || s === "..") ||
    value.length > 4096
  )
    throw new AdapterError("INVALID_ARGUMENT", "Expected an absolute file path");

  return value;
}

async function archive(file: string, bytes: Uint8Array) {
  const tar = pack();
  const chunks: Buffer[] = [];

  const consuming = (async () => {
    for await (const chunk of tar) chunks.push(z.instanceof(Buffer).parse(chunk));
  })();

  tar.entry(
    { name: posix.basename(file), size: bytes.length, mode: 0o600, mtime: new Date(0) },
    Buffer.from(bytes),
  );
  tar.finalize();
  await consuming;

  return gzipSync(Buffer.concat(chunks));
}

function readSignal(ctx: ReadContext) {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))]);
}

/** Transport injection is host-owned and must retain single-attempt dispatch. */
export function createVercelAdapter(
  factory: () => VercelTransport = () => ({ fetch: (url, init) => fetch(url, init) }),
) {
  return defineAdapter({
    name: "vercel",
    displayName: "Vercel Sandbox",
    config: vercelConfig,
    credentials: z.strictObject({ token: z.string().min(1) }),
    async connect({ config, credentials, host }) {
      if (config.snapshots?.preserve === Preserve.FILESYSTEM_AND_MEMORY)
        throw new AdapterError(
          "UNSUPPORTED",
          "Vercel snapshots keep the filesystem only; memory snapshots are not supported",
        );

      const retentionSeconds = config.snapshots?.retentionSeconds;

      if (retentionSeconds !== undefined && config.persistent)
        throw new AdapterError(
          "UNSUPPORTED",
          "snapshots.retentionSeconds applies to snapshot(), which needs disposable mode",
        );

      if (config.network !== undefined && config.networkPolicy !== undefined)
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "Supply network or the deprecated networkPolicy, not both",
        );

      if (config.resources !== undefined && config.vcpus !== undefined)
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "Supply resources or the deprecated vcpus, not both",
        );

      if (config.lifecycle?.lifetimeSeconds !== undefined && config.timeoutSeconds !== undefined)
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "Supply lifecycle.lifetimeSeconds or the deprecated timeoutSeconds, not both",
        );

      const lifetimeSeconds = sessionLifetime(
        config.lifecycle?.lifetimeSeconds ??
          config.timeoutSeconds ??
          defaultLifetime(MAX_SESSION_SECONDS),
      );

      // A persistent sandbox's resumed sessions are checked against the setup lifetime.
      const createLifetime = config.persistent
        ? undefined
        : { minSeconds: 1, maxSeconds: MAX_SESSION_SECONDS };

      const networkPolicy = portablePolicy(config.network ?? config.networkPolicy ?? "blocked");

      // Unmet minimums reject before any provider IO; the native default is 2 vCPUs.
      const vcpus = config.resources
        ? smallestSize("Vercel", SIZES, config.resources).vcpus
        : (config.vcpus ?? 2);

      const transport = factory();
      host.onClose(() => transport.close?.());
      const client = new VercelClient(transport, credentials.token, config.teamId);
      const signal = AbortSignal.any([host.signal, AbortSignal.timeout(30000)]);
      const team = await client.json(`/v2/teams/${config.teamId}`, signal, z.object({ id }));

      const project = await client.json(
        `/v2/projects/${config.projectId}`,
        signal,
        z.object({ id, accountId: id }),
      );

      if (
        team.id !== config.teamId ||
        project.id !== config.projectId ||
        project.accountId !== team.id
      )
        throw new AdapterError("UNAUTHENTICATED", "Vercel project/team identity mismatch");
      await client.json(`/v2/sandboxes?project=${project.id}&limit=1`, signal, page);
      const image = config.image;
      const mode = networkPolicy === "blocked" ? "deny-all" : "allow-all";
      const route = (sandboxId: string) => `/v2/sandboxes/sessions/${id.parse(sandboxId)}`;

      const scope = {
        authority: { kind: "vercel-team", id: team.id },
        partition: { projectId: project.id, region: config.region },
      };

      const reference = (sessionId: string): SandboxReference => ({
        version: 1,
        kind: "sandbox",
        provider: "vercel",
        scope,
        nativeId: sessionId,
        ownership: "unknown",
      });

      const observedImages = new Map<string, string>();

      const checkReference = (box: Sandbox) => {
        if (!box.reference) return;
        assertResourceScope(box.reference, { provider: "vercel", scope });

        if (
          box.reference.kind !== "sandbox" ||
          box.reference.nativeId !== box.id ||
          (!config.persistent && box.reference.generation !== undefined)
        )
          throw new AdapterError(
            "CONFLICT",
            "Vercel sandbox reference lacks the configured resource identity",
          );
      };

      const verifiedSessions = new Set<string>();

      const verifySession = async (sandboxId: string, signal: AbortSignal) => {
        if (verifiedSessions.has(sandboxId)) return;
        let cursor: string | undefined;

        for (let count = 0; count < 100; count++) {
          const query = new URLSearchParams({ project: project.id, limit: "100" });

          if (cursor) query.set("cursor", cursor);

          const result = await client.json(
            `/v2/sandboxes/sessions?${query}`,
            signal,
            z.object({
              sessions: z.array(sessionSchema).max(100),
              pagination: z.object({ next: z.string().nullable() }),
            }),
          );

          if (
            result.sessions.some(
              (value) => value.id === sandboxId && value.region === config.region,
            )
          ) {
            verifiedSessions.add(sandboxId);

            return;
          }

          if (!result.pagination.next) break;
          cursor = result.pagination.next;
        }

        throw new AdapterError("NOT_FOUND", "Session not found in verified Vercel project/region");
      };

      const get = async (sandboxId: string, signal: AbortSignal) => {
        await verifySession(sandboxId, signal);

        const result = await client.json(
          route(sandboxId),
          signal,
          z.object({ session: sessionSchema }),
        );

        if (result.session.id !== sandboxId || result.session.region !== config.region)
          throw new AdapterError("CONFLICT", "Native session identity/routing mismatch");

        return result.session;
      };

      const namedRoute = (name: string, resume = false) =>
        `/v2/sandboxes/${encodeURIComponent(id.parse(name))}?projectId=${project.id}&resume=${resume}`;

      const namedSchema = z.object({
        sandbox: nativeBox,
        session: sessionSchema,
        resumed: z.boolean().optional(),
        routes: z.array(z.object({ port: z.number() })).max(15),
      });

      const generation = (value: z.infer<typeof nativeBox>) => {
        if (value.createdAt === undefined || !value.tags?.sandbarSubmission)
          throw new AdapterError("CONFLICT", "Persistent sandbox creation evidence is unavailable");

        return JSON.stringify([value.createdAt, value.tags.sandbarSubmission]);
      };

      const checkNamed = (box: Sandbox, value: z.infer<typeof namedSchema>) => {
        checkReference(box);

        if (
          !box.reference ||
          value.sandbox.name !== box.id ||
          generation(value.sandbox) !== box.reference.generation ||
          !value.sandbox.persistent ||
          value.sandbox.currentSessionId !== value.session.id ||
          value.session.region !== config.region ||
          value.session.vcpus !== vcpus ||
          value.sandbox.mounts === undefined ||
          Object.keys(value.sandbox.mounts).length !== 0 ||
          !new RegExp(`^${image.split(":")[0]}@sha256:[a-f0-9]{64}$`).test(
            value.sandbox.image ?? "",
          ) ||
          JSON.stringify(value.routes.map((v) => v.port).sort((a, b) => a - b)) !==
            JSON.stringify([...config.ports].sort((a, b) => a - b)) ||
          value.sandbox.networkPolicy?.mode !== mode ||
          value.session.networkPolicy?.mode !== mode
        )
          throw new AdapterError("CONFLICT", "Persistent sandbox identity or routing changed");
      };

      const named = async (box: Sandbox, signal: AbortSignal) => {
        checkReference(box);
        const value = await client.json(namedRoute(box.id), signal, namedSchema);
        checkNamed(box, value);
        verifiedSessions.add(value.session.id);

        return value;
      };

      // A pinned target has no public reference and is used only within one operation.
      const pin = async (box: Sandbox, signal: AbortSignal): Promise<Sandbox> => {
        if (!config.persistent || !box.reference?.generation) return box;
        const value = await named(box, signal);

        if (value.session.status !== "running")
          throw new AdapterError(
            "CONFLICT",
            "Sandbox is inactive; resume explicitly before guest IO",
          );

        return { id: value.session.id };
      };

      const expiry = (
        value: z.infer<typeof sessionSchema>,
        persistent = false,
      ): SandboxInfo["expires"] => {
        if (value.startedAt === undefined || value.timeout === undefined)
          return { status: "unknown", reason: "Native deadline is unavailable" };

        return {
          status: "known",
          at: new Date(value.startedAt + value.timeout).toISOString(),
          action: persistent ? "suspend" : "destroy",
          scope: "running-session",
        };
      };

      // Listing never sees the creating operation, so references carry native generation evidence
      // where the binding needs it, but no creation receipt and no ownership claim.
      const listPage = async (input: { cursor?: string; limit: number }, ctx: ReadContext) => {
        const query = new URLSearchParams({
          project: project.id,
          limit: String(Math.min(input.limit, 100)),
        });

        if (input.cursor) query.set("cursor", input.cursor);
        const result = await client.json(`/v2/sandboxes?${query}`, readSignal(ctx), page);

        return {
          items: result.sandboxes
            .filter((box) => box.persistent === config.persistent && box.region === config.region)
            .filter(
              (box) =>
                !config.persistent ||
                (box.createdAt !== undefined && box.tags?.sandbarSubmission !== undefined),
            )
            .map((box) => {
              const id = config.persistent ? box.name : box.currentSessionId;

              return {
                id,
                state:
                  config.persistent && ["stopped", "aborted"].includes(box.status)
                    ? ("unknown" as const)
                    : state(box.status),
                reference: config.persistent
                  ? { ...reference(id), generation: generation(box) }
                  : reference(id),
              };
            }),
          nextCursor: result.pagination.next ?? undefined,
        };
      };

      const inspection = async (box: Sandbox, signal: AbortSignal): Promise<SandboxInfo> => {
        checkReference(box);

        const logical =
          config.persistent && box.reference?.generation ? await named(box, signal) : undefined;

        const value = logical?.session ?? (await get(box.id, signal));
        let saved = false;

        if (logical?.sandbox.currentSnapshotId && ["stopped", "aborted"].includes(value.status)) {
          try {
            const snapshot = await getSnapshot(
              snapshotReference(logical.sandbox.currentSnapshotId),
              { signal, deadline: Date.now() + 30000 },
            );

            saved = snapshot.status === "created" && snapshot.sourceSessionId === value.id;
          } catch (cause) {
            if (!(cause instanceof AdapterError) || cause.code !== "NOT_FOUND") throw cause;
          }
        }

        return {
          reference: box.reference ?? reference(value.id),
          state:
            logical && ["stopped", "aborted"].includes(value.status)
              ? saved
                ? "suspended"
                : "stopped"
              : state(value.status),
          nativeState: value.status,
          observedAt: new Date().toISOString(),
          ...unknownSandboxFacts(),
          expires: expiry(value, Boolean(logical)),
          execution: { status: "known", value: { nativeId: value.id } },
          resources: sessionSize(value),
        };
      };

      const read = async (
        sandboxId: string,
        file: string,
        signal: AbortSignal,
        limit = maxBytes,
      ) => {
        await verifySession(sandboxId, signal);

        const response = await client.request(
          route(sandboxId) + "/fs/read",
          signal,
          JSON.stringify({ path: path(file), cwd: "/" }),
        );

        if (!response.headers.get("content-type")?.includes("application/octet-stream")) {
          void response.body?.cancel().catch(() => {});
          throw new AdapterError("UNAVAILABLE", "Expected binary file response");
        }

        return boundedBody(response, limit, signal);
      };

      const collect = async (
        token: z.infer<typeof execToken>,
        signal: AbortSignal,
        onConfirmedExit?: (exit: { exitCode: number }) => Promise<void>,
      ) => {
        if (!token.commandId)
          throw new AdapterError(
            "UNAVAILABLE",
            "Command acknowledgement unavailable; retain staged input identity",
          );
        const commandPath = route(token.sessionId) + `/cmd/${token.commandId}`;
        const finished = await client.json(commandPath + "?wait=true", signal, command);

        if (
          finished.command.id !== token.commandId ||
          finished.command.sessionId !== token.sessionId ||
          finished.command.exitCode !== 0
        )
          throw new AdapterError("UNAVAILABLE", "Capture helper did not complete successfully");
        // Only the helper writes stdout: a private receipt path. Ordinary guest output never enters logs.
        const logs = await client.request(commandPath + "/logs", signal);

        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await boundedBody(logs, 16384, signal),
        );

        let output = "";

        for (const line of text.split("\n").filter(Boolean)) {
          const log = z
            .object({ stream: z.enum(["stdout", "stderr"]), data: z.string() })
            .parse(JSON.parse(line));

          if (log.stream === "stdout") output += log.data;
        }

        const records = output.trim().split("\n");
        const receiptPath = records[0];
        let confirmedExit: { exitCode: number } | undefined;

        if (records.length === 2) {
          const marker = z
            .strictObject({ sandbarExit: z.literal(1), exitCode: z.number().int() })
            .safeParse(JSON.parse(records[1]!));

          if (!marker.success)
            throw new AdapterError("UNAVAILABLE", "Invalid capture exit evidence");
          confirmedExit = { exitCode: marker.data.exitCode };
        }

        if (
          !receiptPath ||
          records.length > 2 ||
          !/^\/tmp\/sandbar-exec-[A-Za-z0-9]+\/receipt\.json$/.test(receiptPath)
        )
          throw new AdapterError(
            "UNAVAILABLE",
            "Missing or invalid capture receipt path; command must not be replayed",
          );

        if (
          token.confirmedExit &&
          confirmedExit &&
          token.confirmedExit.exitCode !== confirmedExit.exitCode
        )
          throw new AdapterError("UNAVAILABLE", "Fresh capture exit conflicts with saved evidence");

        if (confirmedExit && onConfirmedExit) await onConfirmedExit(confirmedExit);

        try {
          const bytes = await read(
            token.sessionId,
            receiptPath,
            signal,
            Math.ceil(token.maxBytes / 3) * 4 + 1024,
          );

          const result = decodeReceipt(bytes, token.maxBytes);

          if (
            (confirmedExit && result.exitCode !== confirmedExit.exitCode) ||
            (token.confirmedExit && result.exitCode !== token.confirmedExit.exitCode)
          )
            throw new AdapterError("UNAVAILABLE", "Capture receipt conflicts with confirmed exit");

          return result;
        } catch (cause) {
          const error: ProcessObservationFailure =
            cause instanceof AdapterError
              ? cause
              : new AdapterError(
                  "UNAVAILABLE",
                  "Capture output retrieval failed; command must not be replayed",
                );

          if (confirmedExit) error.confirmedExit = confirmedExit;
          throw error;
        }
      };

      const upload = async (
        sandboxId: string,
        file: string,
        bytes: Uint8Array,
        signal: AbortSignal,
      ) => {
        const response = await client.request(
          route(sandboxId) + "/fs/write",
          signal,
          await archive(file, bytes),
          { "content-type": "application/gzip", "x-cwd": posix.dirname(file) },
        );

        void response.body?.cancel().catch(() => {});
      };

      const executeControl = async (
        box: Sandbox,
        executable: string,
        args: string[],
        ctx: ReadContext,
      ) => {
        const signal = readSignal(ctx);
        box = await pin(box, signal);
        checkReference(box);
        await verifySession(box.id, signal);

        // Supervisor RPC emits bounded ASCII JSON containing base64, never raw guest output.
        const launched = await client.json(route(box.id) + "/cmd", signal, command, {
          command: executable,
          args,
          sudo: false,
          env: {},
          timeout: 30000,
        });

        if (launched.command.sessionId !== box.id)
          throw new AdapterError("UNAVAILABLE", "Process control session mismatch");
        const commandPath = route(box.id) + `/cmd/${launched.command.id}`;
        const finished = await client.json(commandPath + "?wait=true", signal, command);

        if (
          finished.command.sessionId !== box.id ||
          finished.command.id !== launched.command.id ||
          finished.command.exitCode !== 0
        )
          throw new AdapterError("UNAVAILABLE", "Process control did not complete");
        const response = await client.request(commandPath + "/logs", signal);

        const lines = new TextDecoder("utf-8", { fatal: true }).decode(
          await boundedBody(response, maxBytes, signal),
        );

        let output = "";

        for (const line of lines.split("\n").filter(Boolean)) {
          const frame = z
            .object({ stream: z.enum(["stdout", "stderr"]), data: z.string() })
            .parse(JSON.parse(line));

          if (frame.stream === "stdout") output += frame.data;
        }

        return output;
      };

      const executeProcess = (box: Sandbox) => (script: string, ctx: ReadContext) =>
        executeControl(box, "/bin/sh", ["-c", script], ctx);

      const fsCall = async (
        box: Sandbox,
        op: string,
        file: string,
        ctx: ReadContext,
        destination = "",
        flag = false,
        stage = "",
      ) => {
        box = await pin(box, readSignal(ctx));
        checkReference(box);
        path(file);

        if (destination) path(destination);
        const signal = readSignal(ctx);
        await verifySession(box.id, signal);

        const output = await executeControl(
          box,
          "node",
          ["-e", filesystemHelper, JSON.stringify({ op, path: file, destination, flag, stage })],
          ctx,
        );

        return filesystemValue(new TextEncoder().encode(output));
      };

      const transfer = async (
        input: { sandbox: Sandbox; source: string; destination: string; overwrite: boolean },
        ctx: FileTransferContext,
        op: "copy" | "move",
      ) => {
        input = { ...input, sandbox: await pin(input.sandbox, readSignal(ctx)) };
        path(input.source);
        path(input.destination);

        if (input.source === input.destination || input.source === "/" || input.destination === "/")
          throw new AdapterError("INVALID_ARGUMENT", "Transfer requires distinct non-root paths");

        if (op === "move" && !input.overwrite && config.image !== "vercel/sandbox/universal:latest")
          throw new AdapterError(
            "UNSUPPORTED",
            "No-clobber directory rename requires a native rename predicate",
          );

        const stage = posix.join(
          posix.dirname(input.destination),
          `.sandbar-${crypto.randomUUID()}`,
        );

        if (op === "copy") ctx.retain?.({ temporaryPaths: [stage] });

        try {
          await fsCall(
            input.sandbox,
            op,
            input.source,
            ctx,
            input.destination,
            input.overwrite,
            stage,
          );
          ctx.retain?.({ effect: "applied", temporaryPaths: [] });

          return { acknowledged: true as const };
        } catch (cause) {
          const temporaryPaths =
            cause instanceof AdapterFilesystemError
              ? (cause.details.temporaryPaths ?? (op === "copy" ? [stage] : []))
              : op === "copy"
                ? [stage]
                : [];

          ctx.retain?.({ temporaryPaths });

          if (cause instanceof AdapterFilesystemError && cause.details.effect === "applied")
            ctx.retain?.({ effect: "applied" });
          throw new AdapterFilesystemError(
            cause instanceof AdapterError ? cause.code : "UNAVAILABLE",
            "Filesystem transfer could not complete",
            {
              effect: cause instanceof AdapterFilesystemError ? cause.details.effect : "possible",
              source: input.source,
              destination: input.destination,
              temporaryPaths,
            },
          );
        }
      };

      const createOutcome = (
        sessionId: string,
        attempt: { operationId: string; submissionId: string },
        sourceSnapshotId?: string,
      ): import("@sandbar-sdk/adapter").OperationOutcome =>
        sourceSnapshotId
          ? {
              kind: "snapshot_restore",
              status: "unknown",
              sandbox: sandboxReference("vercel", scope, sessionId, {
                operation: attempt.operationId,
                submission: attempt.submissionId,
              }),
              mounts: [],
            }
          : {
              kind: "create",
              status: "partial",
              sandbox: sandboxReference("vercel", scope, sessionId, {
                operation: attempt.operationId,
                submission: attempt.submissionId,
              }),
              setup: { expiry: "unconfirmed", readiness: "unconfirmed" },
            };

      const creationName = (submissionId: string) =>
        `sandbar-${createHash("sha256").update(submissionId).digest("hex")}`;

      const makeCreation = (sourceSnapshotId?: string) => {
        const creation: Extract<
          Mutation<CreateInput, CreateValue, CreateInput, z.infer<typeof createToken>, undefined>,
          { submit: unknown }
        > = {
          recovery: { version: 1, token: createToken },
          async prepare(input) {
            if (
              input.image.kind !== "prepared" ||
              input.image.value !== image ||
              input.networkPolicy !== networkPolicy ||
              (input.region && input.region !== config.region) ||
              input.mounts?.length
            )
              throw new AdapterError("UNSUPPORTED", "Unsupported Vercel creation option");

            if (input.requirements?.snapshot) {
              if (config.persistent)
                throw new AdapterError("UNSUPPORTED", "Reusable capture requires disposable mode");

              const plan = resolveSnapshot(
                {
                  status: "supported",
                  value: { profiles: [profile], defaultProfileId: profile.id },
                },
                input.requirements.snapshot,
                "running",
              );

              if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);
            }

            if (Object.keys(input.labels ?? {}).length > 4)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Vercel supports at most four user labels",
              );

            if (Object.keys(input.labels ?? {}).some((key) => key.startsWith("sandbar")))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved correlation label");

            return input;
          },
          async submit(input, ctx) {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);

            const requestedLifetime =
              input.lifetimeSeconds === undefined
                ? lifetimeSeconds
                : sessionLifetime(input.lifetimeSeconds);

            const requestedName = config.persistent
              ? creationName(ctx.submissionId)
              : `sandbar-${crypto.randomUUID()}`;

            const retention: NativeRetention = {};

            if (config.persistent) retention.keepLastSnapshots = { count: 1, deleteEvicted: true };

            const requestBody = {
              ...retention,
              projectId: project.id,
              name: requestedName,
              image: sourceSnapshotId ? undefined : image,
              mounts: {},
              source: sourceSnapshotId
                ? { type: "snapshot", snapshotId: sourceSnapshotId }
                : undefined,
              region: config.region,
              persistent: config.persistent,
              timeout: requestedLifetime * 1000,
              resources: { vcpus },
              ports: config.ports,
              failoverRegions: [],
              networkPolicy: { mode },
              tags: { ...input.labels, sandbarSubmission: ctx.submissionId },
              // Native session defaults; every command inherits them unless its own env overrides.
              env: input.env && Object.keys(input.env).length ? input.env : undefined,
            };

            let acknowledgement;

            try {
              acknowledgement = await client.json(
                "/v3/sandboxes",
                signal,
                z.object({ session: z.object({ id }).passthrough() }).passthrough(),
                requestBody,
                undefined,
                // Create-time environment values may be secrets; a native echo never reaches a message.
                Object.values(input.env ?? {}),
              );
            } catch (error) {
              if (!(error instanceof VercelRequestRejected)) throw error;

              const detail = error.detail ?? "";

              const message = `Vercel rejected sandbox creation (HTTP ${error.status})${detail ? `: ${detail}` : ""}`;
              const code = createRejections.get(error.status);

              return code
                ? ctx.reject(code, message)
                : ctx.unknown(`${message}; observe without replay`);
            }

            const acknowledgedToken: z.infer<typeof createToken> = {
              version: 1,
              sessionId: acknowledgement.session.id,
              validated: false,
            };

            if (sourceSnapshotId) acknowledgedToken.sourceSnapshotId = sourceSnapshotId;
            await ctx.checkpoint(acknowledgedToken);

            const parsed = z
              .object({ session: sessionSchema, sandbox: nativeBox })
              .safeParse(acknowledgement);

            if (!parsed.success)
              return ctx.unknown(
                "Acknowledged session has incomplete configuration evidence",
                createOutcome(acknowledgement.session.id, ctx, sourceSnapshotId),
              );
            const result = parsed.data;

            const validated =
              result.sandbox.name === requestedName &&
              result.sandbox.persistent === config.persistent &&
              (!config.persistent ||
                (result.sandbox.createdAt !== undefined &&
                  result.sandbox.tags?.sandbarSubmission === ctx.submissionId)) &&
              result.sandbox.currentSessionId === result.session.id &&
              result.session.region === config.region &&
              result.session.vcpus === vcpus &&
              result.session.timeout === requestedLifetime * 1000 &&
              new RegExp(`^${image.split(":")[0]}@sha256:[a-f0-9]{64}$`).test(
                result.sandbox.image ?? "",
              ) &&
              result.sandbox.mounts !== undefined &&
              Object.keys(result.sandbox.mounts).length === 0 &&
              z.array(z.object({ port: z.number() })).safeParse(acknowledgement.routes).success &&
              JSON.stringify(
                z
                  .array(z.object({ port: z.number() }))
                  .parse(acknowledgement.routes)
                  .map((v) => v.port)
                  .sort((a, b) => a - b),
              ) === JSON.stringify([...config.ports].sort((a, b) => a - b)) &&
              (!sourceSnapshotId || result.session.sourceSnapshotId === sourceSnapshotId) &&
              result.session.networkPolicy?.mode === mode &&
              result.sandbox.networkPolicy?.mode === mode;

            const token: z.infer<typeof createToken> = {
              version: 1,
              sessionId: result.session.id,
              validated,
              imageIdentity: result.sandbox.image,
            };

            if (config.persistent && validated)
              token.reference = {
                ...sandboxReference("vercel", scope, result.sandbox.name, {
                  operation: ctx.operationId,
                  submission: ctx.submissionId,
                }),
                generation: generation(result.sandbox),
              };

            if (sourceSnapshotId) token.sourceSnapshotId = sourceSnapshotId;
            await ctx.checkpoint(token);

            if (!validated)
              return ctx.unknown(
                "Acknowledged Vercel session failed configuration validation; retain recovery identity",
                createOutcome(token.sessionId, ctx, sourceSnapshotId),
              );
            verifiedSessions.add(token.sessionId);

            if (token.imageIdentity) observedImages.set(token.sessionId, token.imageIdentity);

            if (result.session.status === "pending")
              return ctx.pending(token, { pollAfterMs: 250 });

            return {
              id: token.reference?.nativeId ?? token.sessionId,
              reference: token.reference ?? reference(token.sessionId),
              state: result.session.status === "running" ? "running" : "unknown",
            };
          },
          async observe(attempt, ctx) {
            if (!attempt.token && config.persistent) {
              const name = creationName(attempt.submissionId);

              const value = await client.json(
                namedRoute(name),
                readSignal(ctx),
                namedSchema.extend({ routes: z.array(z.object({ port: z.number() })).max(15) }),
              );

              if (
                value.sandbox.name !== name ||
                value.sandbox.tags?.sandbarSubmission !== attempt.submissionId ||
                !value.sandbox.persistent ||
                value.sandbox.currentSessionId !== value.session.id ||
                value.session.region !== config.region ||
                value.session.vcpus !== vcpus ||
                value.session.timeout !== lifetimeSeconds * 1000 ||
                value.session.networkPolicy?.mode !== mode ||
                value.sandbox.networkPolicy?.mode !== mode ||
                !new RegExp(`^${image.split(":")[0]}@sha256:[a-f0-9]{64}$`).test(
                  value.sandbox.image ?? "",
                ) ||
                value.sandbox.mounts === undefined ||
                Object.keys(value.sandbox.mounts).length !== 0 ||
                JSON.stringify(value.routes.map((v) => v.port).sort((a, b) => a - b)) !==
                  JSON.stringify([...config.ports].sort((a, b) => a - b)) ||
                (sourceSnapshotId && value.session.sourceSnapshotId !== sourceSnapshotId)
              )
                return ctx.unknown(
                  "Created persistent sandbox lacks exact configuration/correlation evidence",
                );

              const ref: SandboxReference = {
                ...sandboxReference("vercel", scope, name, {
                  operation: attempt.operationId,
                  submission: attempt.submissionId,
                }),
                generation: generation(value.sandbox),
              };

              verifiedSessions.add(value.session.id);

              if (value.sandbox.image) observedImages.set(value.session.id, value.sandbox.image);

              return {
                id: name,
                reference: ref,
                state:
                  value.session.status === "running" ? ("running" as const) : ("unknown" as const),
              };
            }

            if (!attempt.token) return null;
            const token = createToken.parse(attempt.token);

            if (!token.validated)
              return ctx.unknown(
                "Acknowledged configuration mismatch; manual session cleanup required",
                createOutcome(token.sessionId, attempt, token.sourceSnapshotId),
              );

            if (token.imageIdentity) observedImages.set(token.sessionId, token.imageIdentity);

            if (config.persistent && token.reference)
              await named(
                { id: token.reference.nativeId, reference: token.reference },
                readSignal(ctx),
              );
            const value = await get(token.sessionId, readSignal(ctx));

            if (
              value.networkPolicy?.mode !== mode ||
              (token.sourceSnapshotId && value.sourceSnapshotId !== token.sourceSnapshotId)
            )
              return ctx.unknown("Acknowledged session network policy mismatch");

            if (value.status === "pending") return ctx.pending(token, { pollAfterMs: 250 });

            return {
              id: token.reference?.nativeId ?? value.id,
              reference: token.reference ?? reference(value.id),
              state: value.status === "running" ? "running" : "unknown",
            };
          },
        };

        return creation;
      };

      const sourceMetadata = async (sessionId: string, ctx: ReadContext) => {
        let cursor: string | undefined;

        for (let count = 0; count < 100; count++) {
          const query = new URLSearchParams({ project: project.id, limit: "100" });

          if (cursor) query.set("cursor", cursor);
          const result = await client.json(`/v2/sandboxes?${query}`, readSignal(ctx), page);
          const found = result.sandboxes.find((v) => v.currentSessionId === sessionId);

          if (found) return found;

          if (!result.pagination.next) break;
          cursor = result.pagination.next;
        }

        throw new AdapterError("NOT_FOUND", "Original session metadata unavailable");
      };

      const profile: SnapshotProfile = {
        id: "vercel-filesystem",
        preserve: Preserve.FILESYSTEM,
        sourceStates: ["running"],
        interruption: "terminate",
        sourceAfter: "destroyed",
        connections: "dropped",
        consistency: "unknown",
        restoreExecution: "fresh",
        mountHandling: "none",
      };

      // Expiry counts from last use, so a capture lasts at least this long.
      if (retentionSeconds !== undefined)
        profile.minimumRetentionSeconds =
          retentionSeconds === 0 ? Number.MAX_SAFE_INTEGER : retentionSeconds;

      const snapshotSchema = z.object({
        id,
        sourceSessionId: id,
        region: z.string(),
        regions: z.array(z.string()).optional(),
        status: z.enum(["created", "deleted", "failed"]),
        createdAt: z.number(),
      });

      const snapshotReference = (
        nativeId: string,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference & { kind: "snapshot" } => ({
        version: 1,
        kind: "snapshot",
        provider: "vercel",
        scope,
        nativeId,
        ownership,
      });

      const checkSnapshot = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "vercel", scope });

        if (ref.kind !== "snapshot" || ref.generation !== undefined)
          throw new AdapterError("CONFLICT", "Invalid Vercel snapshot identity");
        id.parse(ref.nativeId);
      };

      const snapshotInfo = (
        value: z.infer<typeof snapshotSchema>,
        mountFree = false,
        consistency: SnapshotInfo["consistency"] = "unknown",
        ownership: ResourceReference["ownership"] = "unknown",
      ): SnapshotInfo => {
        const ref = snapshotReference(value.id, ownership);

        if (mountFree)
          ref.history = {
            mountHandling: "none",
            image,
            sourceSessionId: value.sourceSessionId,
            consistency,
          };

        return {
          reference: ref,
          preserve: "filesystem",
          restoreExecution: "fresh",
          consistency,
          source: { id: value.sourceSessionId, class: "vercel-session" },
          state: value.status === "created" ? "ready" : "unknown",
          createdAt: new Date(value.createdAt).toISOString(),
          expiration: "unknown",
          excludedPaths: null,
          mounts: [],
          mountHandling: mountFree ? "none" : "unknown",
          restore: {
            networkPolicies: [networkPolicy],
            resources: false,
            mounts: false,
            independentLifecycle: true,
          },
          dependencies: [],
          nativeDependencies: null,
        };
      };

      const snapshotPage = z.object({
        snapshots: z.array(snapshotSchema).max(100),
        pagination: z.object({ next: z.string().nullable() }),
      });

      const getSnapshot = async (ref: ResourceReference, ctx: ReadContext) => {
        checkSnapshot(ref);
        const signal = readSignal(ctx);
        let cursor: string | undefined;
        let found = false;

        for (let count = 0; count < 100; count++) {
          const query = new URLSearchParams({ project: project.id, limit: "100" });

          if (cursor) query.set("cursor", cursor);

          const result = await client.json(
            `/v2/sandboxes/snapshots?${query}`,
            signal,
            snapshotPage,
          );

          if (result.snapshots.some((v) => v.id === ref.nativeId)) {
            found = true;
            break;
          }

          if (!result.pagination.next) break;
          cursor = result.pagination.next;
        }

        if (!found) throw new AdapterError("NOT_FOUND", "Snapshot not found in verified project");

        const result = await client.json(
          `/v2/sandboxes/snapshots/${ref.nativeId}`,
          signal,
          z.object({ snapshot: snapshotSchema }),
        );

        if (
          result.snapshot.id !== ref.nativeId ||
          !(result.snapshot.regions ?? [result.snapshot.region]).includes(config.region)
        )
          throw new AdapterError("CONFLICT", "Snapshot identity/region mismatch");

        return result.snapshot;
      };

      const processes: import("@sandbar-sdk/adapter").AdapterSession["processes"] =
        config.image === "vercel/sandbox/universal:latest"
          ? {
              supports: {
                sustainedOutput: true as const,
                binaryOutput: true as const,
                signals: ["SIGTERM", "SIGKILL"] as const,
                terminal: true as const,
                reopen: true as const,
                stdin: "bytes" as const,
                status: true as const,
                execCapture: "bytes" as const,
              },
              start: async (
                input: import("@sandbar-sdk/adapter").ProcessStartInput,
                ctx: import("@sandbar-sdk/adapter").ProcessStartContext,
              ) =>
                startVercelProcess(
                  executeProcess(await pin(input.sandbox, readSignal(ctx))),
                  input,
                  ctx,
                ),
              reopen: async (
                input: import("@sandbar-sdk/adapter").ProcessReopenInput,
                ctx: import("@sandbar-sdk/adapter").ProcessStartContext,
              ) =>
                reopenVercelProcess(
                  executeProcess(await pin(input.sandbox, readSignal(ctx))),
                  input,
                  ctx,
                ),
            }
          : undefined;

      return {
        scope,
        defaultImage: { kind: "prepared", value: image },
        defaultNetworkPolicy: networkPolicy,
        networkPolicyAliases,
        supports: {
          images: ["prepared"],
          network: [networkPolicy],
          exec: { commands: ["argv", "shell"], maxOutputBytes: maxBytes },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
          lifetime: createLifetime,
        },
        suspensionCapabilities: async () =>
          config.persistent
            ? {
                status: "supported" as const,
                value: {
                  preserve: "filesystem" as const,
                  processes: "terminated" as const,
                  connections: "dropped" as const,
                },
              }
            : {
                status: "unsupported" as const,
                reason: "Enable persistent mode in adapter configuration",
              },
        resumeCapabilities: async () =>
          config.persistent
            ? {
                status: "supported" as const,
                value: { sourceStates: ["suspended" as const], setsSessionTimeout: true },
              }
            : {
                status: "unsupported" as const,
                reason: "Enable persistent mode in adapter configuration",
              },
        suspend: {
          recovery: {
            version: 1,
            token: z.strictObject({ reference: ResourceReference, sessionId: id }),
          },
          prepare: async (input, ctx) => {
            if (!config.persistent || !input.sandbox.reference.generation)
              throw new AdapterError(
                "UNSUPPORTED",
                "Suspension requires a persistent sandbox reference",
              );
            const value = await named(input.sandbox, readSignal(ctx));

            if (value.session.status !== "running")
              throw new AdapterError("CONFLICT", "Suspension requires running compute");

            return {
              ...input,
              intent: { action: "suspend" as const, preserve: "filesystem" as const },
            };
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            const before = await named(input.sandbox, signal);

            if (before.session.status !== "running")
              return ctx.reject("CONFLICT", "Sandbox is no longer running");
            await ctx.checkpoint({
              reference: input.sandbox.reference,
              sessionId: before.session.id,
            });

            const response = await client.json(
              route(before.session.id) + "/stop",
              signal,
              z.object({
                session: sessionSchema,
                sandbox: nativeBox.optional(),
                snapshot: z.object({ id }).optional(),
              }),
              {},
            );

            if (response.session.id !== before.session.id)
              return ctx.unknown("Stop acknowledgement identity mismatch");

            for (let count = 0; count < 120; count++) {
              const value = await named(input.sandbox, signal);

              if (value.session.id !== before.session.id)
                return ctx.unknown("Execution changed during suspension");

              if (
                ["stopped", "aborted"].includes(value.session.status) &&
                value.sandbox.currentSnapshotId
              ) {
                const saved = await getSnapshot(
                  snapshotReference(value.sandbox.currentSnapshotId),
                  { signal, deadline: Date.now() + 30000 },
                );

                if (saved.sourceSessionId !== before.session.id || saved.status !== "created")
                  return ctx.unknown(
                    "Stopped compute has no confirmed checkpoint from this execution",
                  );
                const observation = await inspection(input.sandbox, signal);

                return {
                  reference: input.sandbox.reference,
                  preserve: "filesystem" as const,
                  processes: "terminated" as const,
                  connections: "dropped" as const,
                  observation,
                };
              }

              await delay(250, undefined, { signal });
            }

            return ctx.unknown("Filesystem checkpoint is not confirmed; never replay suspension");
          },
          observe: async (attempt, ctx) => {
            if (!attempt.sandbox?.reference) return null;
            const observation = await inspection(attempt.sandbox, readSignal(ctx));

            return ctx.unknown("Suspension acknowledgement unavailable; never replay", {
              kind: "sandbox_suspend",
              status: "unknown",
              reference: attempt.sandbox.reference,
              acknowledged: false,
              observation,
            });
          },
        },
        resume: {
          recovery: {
            version: 1,
            token: z.strictObject({ reference: ResourceReference, sessionId: id }),
          },
          prepare: async (input, ctx) => {
            if (!config.persistent || !input.sandbox.reference.generation)
              throw new AdapterError(
                "UNSUPPORTED",
                "Resume requires a persistent sandbox reference",
              );
            const value = await named(input.sandbox, readSignal(ctx));

            if (
              !["stopped", "aborted"].includes(value.session.status) ||
              !value.sandbox.currentSnapshotId
            )
              throw new AdapterError(
                "CONFLICT",
                "Resume requires a saved filesystem checkpoint and inactive compute",
              );

            const saved = await getSnapshot(
              snapshotReference(value.sandbox.currentSnapshotId),
              ctx,
            );

            if (saved.sourceSessionId !== value.session.id || saved.status !== "created")
              throw new AdapterError(
                "CONFLICT",
                "Saved checkpoint does not belong to the inactive execution",
              );

            return { ...input, intent: { action: "resume" as const } };
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            const before = await named(input.sandbox, signal);

            if (
              !["stopped", "aborted"].includes(before.session.status) ||
              !before.sandbox.currentSnapshotId
            )
              return ctx.reject("CONFLICT", "Sandbox is no longer suspended");
            const snapshotId = before.sandbox.currentSnapshotId;

            const checkpoint = await getSnapshot(snapshotReference(snapshotId), {
              signal,
              deadline: Date.now() + 30000,
            });

            if (checkpoint.status !== "created" || checkpoint.sourceSessionId !== before.session.id)
              return ctx.reject(
                "CONFLICT",
                "Saved checkpoint no longer matches the inactive execution",
              );
            await ctx.checkpoint({
              reference: input.sandbox.reference,
              sessionId: before.session.id,
            });

            // This is an explicit mutation despite Vercel exposing it as GET. Never retry.
            const result = await client.json(
              namedRoute(input.sandbox.id, true),
              signal,
              namedSchema,
            );

            checkNamed(input.sandbox, result);

            if (
              result.resumed !== true ||
              result.session.id === before.session.id ||
              result.session.sourceSnapshotId !== snapshotId ||
              result.session.timeout !== lifetimeSeconds * 1000 ||
              result.session.status !== "running"
            )
              return ctx.unknown(
                "Fresh execution acknowledgement is incomplete; never replay resume",
              );
            verifiedSessions.add(result.session.id);
            const observation = await inspection(input.sandbox, signal);

            if (
              observation.execution.status !== "known" ||
              observation.execution.value.nativeId !== result.session.id
            )
              return ctx.unknown("Execution changed after resume acknowledgement");

            return {
              reference: input.sandbox.reference,
              execution: "fresh" as const,
              executionIdentity: observation.execution,
              connections: "dropped" as const,
              observation,
            };
          },
          observe: async (attempt, ctx) => {
            if (!attempt.sandbox?.reference) return null;
            const observation = await inspection(attempt.sandbox, readSignal(ctx));

            return ctx.unknown("Resume acknowledgement unavailable; never replay", {
              kind: "sandbox_resume",
              status: "unknown",
              reference: attempt.sandbox.reference,
              acknowledged: false,
              observation,
            });
          },
        },
        renewCapabilities: async (target, ctx) => {
          if (target.sandbox) {
            checkReference(target.sandbox);

            if ((await inspection(target.sandbox, readSignal(ctx))).state !== "running")
              return { status: "unavailable" as const, reason: "Only running sessions can renew" };
          }

          return {
            status: "supported" as const,
            value: {
              minSeconds: 1,
              maxSeconds: MAX_SESSION_SECONDS,
              stepSeconds: 1,
              scope: "running-session" as const,
            },
          };
        },
        renew: {
          recovery: {
            version: 1,
            token: z.strictObject({
              reference: ResourceReference,
              forSeconds: z.number().int().min(1).max(MAX_SESSION_SECONDS),
            }),
          },
          prepare: async (input) => {
            checkReference(input.sandbox);
            const forSeconds = input.forSeconds ?? lifetimeSeconds;

            if (forSeconds < 1 || forSeconds > MAX_SESSION_SECONDS || !Number.isInteger(forSeconds))
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Renewal window must be 1–${MAX_SESSION_SECONDS} seconds`,
              );

            return { ...input, forSeconds };
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            const publicReference = input.sandbox.reference;
            const pinned = await pin(input.sandbox, signal);
            const before = await get(pinned.id, signal);

            if (before.status !== "running")
              return ctx.reject("CONFLICT", "Only running sessions can renew");
            await ctx.checkpoint({
              reference: publicReference ?? reference(input.sandbox.id),
              forSeconds: input.forSeconds,
            });

            const result = await client.json(
              route(pinned.id) + "/extend-timeout",
              signal,
              z.object({ session: sessionSchema }),
              { duration: input.forSeconds * 1000 },
            );

            if (result.session.id !== pinned.id || result.session.region !== config.region)
              return ctx.unknown("Renewal session mismatch");

            return {
              reference: publicReference ?? reference(input.sandbox.id),
              requested: { forSeconds: input.forSeconds },
              acknowledged: true as const,
              observation: {
                reference: publicReference ?? reference(input.sandbox.id),
                state: state(result.session.status),
                nativeState: result.session.status,
                observedAt: new Date().toISOString(),
                ...unknownSandboxFacts(),
                execution: { status: "known" as const, value: { nativeId: pinned.id } },
                expires: expiry(
                  result.session,
                  config.persistent && publicReference.generation !== undefined,
                ),
              },
            };
          },
          observe: async (attempt, ctx) => {
            if (!attempt.token || !attempt.sandbox?.reference) return null;

            const token = z
              .strictObject({
                reference: ResourceReference,
                forSeconds: z.number().int().min(1).max(MAX_SESSION_SECONDS),
              })
              .parse(attempt.token);

            assertResourceIdentity(token.reference, attempt.sandbox.reference);
            let observation: SandboxInfo | null = null;

            try {
              observation = await inspection(attempt.sandbox, readSignal(ctx));
            } catch {
              /* No fresh observation is proof of the additive ACK. */
            }

            return ctx.unknown("Additive renewal acknowledgement unavailable; never replay", {
              kind: "sandbox_renew",
              status: "unknown",
              reference: attempt.sandbox.reference,
              requested: { forSeconds: token.forSeconds },
              observation,
            });
          },
        },
        preview: async (input, ctx) => {
          input = { ...input, sandbox: await pin(input.sandbox, readSignal(ctx)) };
          checkReference(input.sandbox);

          if (!config.ports.includes(input.port))
            throw new AdapterError(
              "UNSUPPORTED",
              "Preview port must be exposed in adapter configuration",
            );
          const signal = readSignal(ctx);
          await verifySession(input.sandbox.id, signal);

          const result = await client.json(
            route(input.sandbox.id),
            signal,
            z.object({
              session: sessionSchema,
              routes: z.array(z.object({ port: z.number(), subdomain: z.string() })).max(32),
            }),
          );

          if (
            result.session.id !== input.sandbox.id ||
            result.session.region !== config.region ||
            result.session.status !== "running"
          )
            throw new AdapterError("CONFLICT", "Preview requires the original running session");
          const previewRoute = result.routes.find((v) => v.port === input.port);

          if (!previewRoute || !/^[a-zA-Z0-9-]+$/.test(previewRoute.subdomain))
            throw new AdapterError("UNAVAILABLE", "Missing or malformed preview route");

          return { access: "public" as const, url: `https://${previewRoute.subdomain}.vercel.run` };
        },
        snapshotProfiles: async () =>
          config.persistent
            ? {
                status: "unsupported" as const,
                reason:
                  "Use suspension for persistent filesystem checkpoints; reusable capture requires disposable mode",
              }
            : {
                status: "supported" as const,
                value: { profiles: [profile], defaultProfileId: profile.id },
              },
        resourceCapabilities: async () => ({
          restore: {
            status: "supported" as const,
            value: {
              networkPolicies: [networkPolicy],
              resources: false,
              mounts: false,
              independentLifecycle: true,
            },
          },
          volumes: {
            status: "unsupported" as const,
            reason: "Drive mutations use reusable names without a generation predicate",
          },
          mounts: {
            status: "unsupported" as const,
            reason: "Drive mount selectors use reusable names without a generation predicate",
          },
        }),
        snapshotCapture: {
          recovery: {
            version: 1,
            token: z.strictObject({ snapshotId: id, sessionId: id, snapshot: ResourceReference }),
          },
          prepare: async (input, ctx) => {
            if (config.persistent)
              throw new AdapterError(
                "UNSUPPORTED",
                "Reusable snapshot capture requires disposable mode",
              );
            checkReference(input.sandbox);
            const source = await get(input.sandbox.id, readSignal(ctx));
            const metadata = await sourceMetadata(input.sandbox.id, ctx);

            if (
              metadata.persistent ||
              metadata.mounts === undefined ||
              Object.keys(metadata.mounts).length ||
              observedImages.get(input.sandbox.id) !== metadata.image ||
              !observedImages.has(input.sandbox.id)
            )
              throw new AdapterError(
                "UNSUPPORTED",
                "Snapshot requires a mount-free disposable managed Node image source",
              );

            const plan = resolveSnapshot(
              { status: "supported", value: { profiles: [profile], defaultProfileId: profile.id } },
              input.request,
              state(source.status),
            );

            if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

            if (input.request.retention?.cleanupAfterSeconds !== undefined)
              throw new AdapterError(
                "UNSUPPORTED",
                "Set Vercel snapshot expiry with snapshots.retentionSeconds in adapter setup",
              );

            return input;
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);

            const ack = await client.json(
              route(input.sandbox.id) + "/snapshot",
              signal,
              z.object({ snapshot: z.object({ id }).passthrough() }).passthrough(),
              retentionSeconds === undefined ? {} : { expiration: retentionSeconds * 1000 },
            );

            const token = {
              snapshotId: ack.snapshot.id,
              sessionId: input.sandbox.id,
              snapshot: snapshotReference(ack.snapshot.id, "verified-created"),
            };

            await ctx.checkpoint(token);

            const parsed = z
              .object({ snapshot: snapshotSchema, session: sessionSchema })
              .safeParse(ack);

            const partial = {
              kind: "snapshot_capture" as const,
              status: "unknown" as const,
              snapshot: token.snapshot,
            };

            if (!parsed.success)
              return ctx.unknown("Acknowledged snapshot metadata is incomplete", partial);
            const result = parsed.data;

            if (
              result.snapshot.sourceSessionId !== input.sandbox.id ||
              result.session.id !== input.sandbox.id ||
              result.snapshot.status !== "created" ||
              state(result.session.status) !== "destroyed" ||
              !(result.snapshot.regions ?? [result.snapshot.region]).includes(config.region)
            )
              return ctx.unknown(
                "Snapshot acknowledged; capture/source lifecycle evidence incomplete",
                partial,
              );

            return {
              snapshot: snapshotInfo(
                result.snapshot,
                true,
                input.expectation?.profile.consistency,
                "verified-created",
              ),
              capture: {
                preserve: "filesystem" as const,
                interruption: "terminate" as const,
                restoreExecution: "fresh" as const,
              },
              source: { state: "destroyed" as const, connections: "dropped" as const },
              retainedResources: [token.snapshot],
            };
          },
          observe: async (attempt, ctx) => {
            if (!attempt.token || !attempt.sandbox) return null;

            const token = z
              .object({ snapshotId: id, sessionId: id, snapshot: ResourceReference })
              .parse(attempt.token);

            checkReference(attempt.sandbox);

            if (token.sessionId !== attempt.sandbox.id)
              return ctx.unknown("Capture source identity mismatch");
            const snapshot = await getSnapshot(snapshotReference(token.snapshotId), ctx);
            const source = await get(token.sessionId, readSignal(ctx));

            if (
              snapshot.sourceSessionId !== token.sessionId ||
              snapshot.status !== "created" ||
              state(source.status) !== "destroyed"
            )
              return ctx.unknown("Capture/source state unconfirmed");

            return {
              snapshot: snapshotInfo(
                snapshot,
                attempt.capture?.profile.mountHandling === "none",
                attempt.capture?.profile.consistency,
                "verified-created",
              ),
              capture: {
                preserve: "filesystem" as const,
                interruption: "terminate" as const,
                restoreExecution: "fresh" as const,
              },
              source: { state: "destroyed" as const, connections: "dropped" as const },
              retainedResources: [snapshotReference(snapshot.id, "verified-created")],
            };
          },
        },
        snapshotDelete: {
          recovery: { version: 1, token: z.strictObject({ reference: ResourceReference }) },
          prepare: async (ref, ctx) => {
            await getSnapshot(ref, ctx);

            return ref;
          },
          submit: async (ref, ctx) => {
            await ctx.checkpoint({ reference: ref });

            const result = await client.json(
              `/v2/sandboxes/snapshots/${ref.nativeId}`,
              AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
              z.object({ snapshot: snapshotSchema }),
              undefined,
              "DELETE",
            );

            if (result.snapshot.id !== ref.nativeId || result.snapshot.status !== "deleted")
              return ctx.unknown("Snapshot deletion unconfirmed");

            return { deleted: true as const, reference: ref };
          },
          observe: async (attempt, ctx) => {
            if (!attempt.token) return null;

            const ref = z
              .strictObject({ reference: ResourceReference })
              .parse(attempt.token).reference;

            checkSnapshot(ref);

            if (!attempt.resource) return ctx.unknown("Snapshot deletion resource unavailable");
            assertResourceIdentity(ref, attempt.resource);

            const result = await client.json(
              `/v2/sandboxes/snapshots/${ref.nativeId}`,
              readSignal(ctx),
              z.object({ snapshot: snapshotSchema }),
            );

            return result.snapshot.id === ref.nativeId && result.snapshot.status === "deleted"
              ? { deleted: true as const, reference: ref }
              : ctx.unknown("Snapshot deletion unconfirmed");
          },
        },
        snapshotInspect: async (ref, ctx) => {
          const value = await getSnapshot(ref, ctx);

          const provenance = z
            .strictObject({
              mountHandling: z.literal("none"),
              image: z.literal(image),
              sourceSessionId: id,
              consistency: z.enum(["unknown", "caller-quiesced", "crash-consistent"]),
            })
            .safeParse(ref.history);

          return snapshotInfo(
            value,
            provenance.success && provenance.data.sourceSessionId === value.sourceSessionId,
            provenance.success && provenance.data.sourceSessionId === value.sourceSessionId
              ? provenance.data.consistency
              : "unknown",
            ref.ownership,
          );
        },
        snapshotListCoverage: "provider-scope",
        snapshotList: async (input, ctx) => {
          const query = new URLSearchParams({ project: project.id, limit: String(input.limit) });

          if (input.cursor) query.set("cursor", input.cursor);

          const result = await client.json(
            `/v2/sandboxes/snapshots?${query}`,
            readSignal(ctx),
            snapshotPage,
          );

          return {
            items: result.snapshots
              .filter(
                (v) => v.status !== "deleted" && (v.regions ?? [v.region]).includes(config.region),
              )
              .map((value) => snapshotInfo(value)),
            nextCursor: result.pagination.next ?? undefined,
            coverage: "provider-scope" as const,
          };
        },
        snapshotRestore: {
          recovery: { version: 1, token: createToken },
          // A restore boots a new session from the filesystem snapshot, so options apply as on create.
          options: { env: true, labels: true, lifetime: createLifetime },
          prepare: async (input, ctx) => {
            checkSnapshot(input.snapshot);
            const labels = Object.keys(input.request.labels ?? {});

            if (labels.length > 4)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Vercel supports at most four user labels",
              );

            if (labels.some((key) => key.startsWith("sandbar")))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved correlation label");

            if (
              input.request.networkPolicy !== networkPolicy ||
              input.request.resources ||
              input.request.mounts?.length
            )
              throw new AdapterError("UNSUPPORTED", "Unsupported restore configuration");
            const value = await getSnapshot(input.snapshot, ctx);

            if (value.status !== "created")
              throw new AdapterError("CONFLICT", "Snapshot is not ready");

            const provenance = z
              .object({
                mountHandling: z.literal("none"),
                image: z.literal(image),
                sourceSessionId: z.literal(value.sourceSessionId),
              })
              .safeParse(input.snapshot.history);

            if (!provenance.success)
              throw new AdapterError(
                "UNSUPPORTED",
                "Restore requires retained mount-free capture provenance for the configured image",
              );

            return input;
          },
          submit: async (input, ctx) => {
            const mutation = makeCreation(input.snapshot.nativeId);

            return mutation.submit(
              {
                image: { kind: "prepared", value: image },
                networkPolicy,
                labels: input.request.labels,
                env: input.request.env,
                lifetimeSeconds: input.request.lifetimeSeconds,
              },
              ctx,
            );
          },
          observe: async (attempt, ctx) => {
            if (!attempt.resource) return null;
            checkSnapshot(attempt.resource);
            const token = attempt.token ? createToken.parse(attempt.token) : undefined;

            if (token && token.sourceSnapshotId !== attempt.resource.nativeId)
              return ctx.unknown("Restore snapshot resource mismatch");

            if (!token && !config.persistent) return null;
            const mutation = makeCreation(attempt.resource.nativeId);

            if (!mutation.observe) return null;

            return mutation.observe(
              {
                ...attempt,
                sandbox: undefined,
                token: attempt.token ? createToken.parse(attempt.token) : undefined,
              },
              ctx,
            );
          },
        },
        create: makeCreation(),
        destroy: {
          recovery: {
            version: 1,
            token: z.strictObject({
              reference: ResourceReference,
              sessionId: id,
              retainedResources: z.array(id).max(128),
              computeStopped: z.boolean(),
            }),
          },
          async submit(box, ctx) {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            checkReference(box);

            if (config.persistent && box.reference?.generation) {
              const logical = await named(box, signal);
              await ctx.checkpoint({
                reference: box.reference,
                sessionId: logical.session.id,
                retainedResources: [],
                computeStopped: false,
              });

              if (!["stopped", "aborted"].includes(logical.session.status)) {
                const stopped = await client.request(
                  route(logical.session.id) + "/stop",
                  signal,
                  "",
                );

                void stopped.body?.cancel().catch(() => {});
              }

              for (let count = 0; count < 120; count++) {
                const current = await named(box, signal);

                if (current.session.id !== logical.session.id)
                  return ctx.unknown("Execution changed during destroy");

                if (["stopped", "aborted"].includes(current.session.status)) break;

                if (count === 119) return ctx.unknown("Persistent compute termination unconfirmed");
                await delay(250, undefined, { signal });
              }

              const retained: string[] = [];
              let cursor: string | undefined;

              for (let count = 0; count < 100; count++) {
                const query = new URLSearchParams({
                  project: project.id,
                  name: box.id,
                  limit: "100",
                });

                if (cursor) query.set("cursor", cursor);

                const result = await client.json(
                  `/v2/sandboxes/snapshots?${query}`,
                  signal,
                  snapshotPage,
                );

                for (const snapshot of result.snapshots) {
                  if (snapshot.status !== "deleted") retained.push(snapshot.id);
                }

                if (retained.length > 128)
                  return ctx.unknown(
                    "Compute stopped; too many retained snapshot identities to delete metadata safely",
                  );
                cursor = result.pagination.next ?? undefined;

                if (!cursor) break;

                if (count === 99)
                  return ctx.unknown(
                    "Compute stopped; snapshot inventory exceeds the supported bound",
                  );
              }

              const guarded = await named(box, signal);

              if (
                guarded.session.id !== logical.session.id ||
                !["stopped", "aborted"].includes(guarded.session.status)
              )
                return ctx.unknown("Execution changed before named deletion");
              await ctx.checkpoint({
                reference: box.reference,
                sessionId: logical.session.id,
                retainedResources: retained,
                computeStopped: true,
              });

              const deleted = await client.json(
                namedRoute(box.id),
                signal,
                z.object({ sandbox: nativeBox }),
                undefined,
                "DELETE",
              );

              if (
                deleted.sandbox.name !== box.id ||
                generation(deleted.sandbox) !== box.reference.generation ||
                deleted.sandbox.currentSessionId !== logical.session.id
              )
                return ctx.unknown("Named deletion acknowledgement identity mismatch");

              try {
                await named(box, signal);

                return ctx.unknown("Named sandbox deletion unconfirmed");
              } catch (cause) {
                if (!(cause instanceof AdapterError) || cause.code !== "NOT_FOUND") throw cause;
              }

              for (const snapshotId of retained) {
                const retainedSnapshot = await client.json(
                  `/v2/sandboxes/snapshots/${snapshotId}`,
                  signal,
                  z.object({ snapshot: snapshotSchema }),
                );

                if (
                  retainedSnapshot.snapshot.id !== snapshotId ||
                  retainedSnapshot.snapshot.status === "deleted"
                )
                  return ctx.unknown(
                    "Named sandbox deleted; retained snapshot state is unconfirmed",
                  );
              }

              return { computeStopped: true, retainedResources: retained };
            }

            const before = await get(box.id, signal);

            if (state(before.status) !== "destroyed") {
              const response = await client.request(route(box.id) + "/stop", signal, "");
              void response.body?.cancel().catch(() => {});
            }

            for (let count = 0; count < 120; count++) {
              const value = await get(box.id, signal);

              if (state(value.status) === "destroyed")
                return {
                  computeStopped: true,
                  retainedResources: ["vercel-named-sandbox-metadata"],
                };
              await delay(250, undefined, { signal: signal });
            }

            return ctx.unknown("Original Vercel session termination unconfirmed");
          },
          async observe(attempt, ctx) {
            if (!attempt.sandbox) return null;
            checkReference(attempt.sandbox);

            if (config.persistent && attempt.sandbox.reference?.generation) {
              if (!attempt.token)
                return ctx.unknown("Persistent deletion has no saved storage custody");

              const token = z
                .strictObject({
                  reference: ResourceReference,
                  sessionId: id,
                  retainedResources: z.array(id).max(128),
                  computeStopped: z.boolean(),
                })
                .parse(attempt.token);

              assertResourceIdentity(token.reference, attempt.sandbox.reference);
              const signal = readSignal(ctx);

              if (!token.computeStopped) {
                const current = await named(attempt.sandbox, signal);

                if (
                  current.session.id !== token.sessionId ||
                  !["stopped", "aborted"].includes(current.session.status)
                )
                  return ctx.unknown("Original compute stop is unconfirmed");
              }

              try {
                await named(attempt.sandbox, signal);

                return ctx.unknown("Named sandbox still exists; deletion will not be replayed");
              } catch (cause) {
                if (!(cause instanceof AdapterError) || cause.code !== "NOT_FOUND") throw cause;
              }

              for (const snapshotId of token.retainedResources) {
                const value = await client.json(
                  `/v2/sandboxes/snapshots/${snapshotId}`,
                  signal,
                  z.object({ snapshot: snapshotSchema }),
                );

                if (value.snapshot.id !== snapshotId || value.snapshot.status === "deleted")
                  return ctx.unknown("Retained snapshot state is unconfirmed");
              }

              return { computeStopped: true, retainedResources: token.retainedResources };
            }

            const value = await get(attempt.sandbox.id, readSignal(ctx));

            return state(value.status) === "destroyed"
              ? { computeStopped: true, retainedResources: ["vercel-named-sandbox-metadata"] }
              : ctx.unknown("Original session still unconfirmed");
          },
        },
        async reopen(ref, ctx) {
          return inspection({ id: ref.nativeId, reference: ref }, readSignal(ctx));
        },
        async inspect(box, ctx) {
          return { id: box.id, ...(await inspection(box, readSignal(ctx))) };
        },
        async inventory(input, ctx) {
          const result = await listPage(input, ctx);

          return {
            items: result.items.map((item) => ({ id: item.id, state: item.state })),
            nextCursor: result.nextCursor,
          };
        },
        async sandboxList(input, ctx) {
          const result = await listPage(input, ctx);

          return {
            // Persistent bindings list only sandboxes tagged with a Sandbar submission; session
            // bindings list every session-mode sandbox in the project and region.
            coverage: config.persistent
              ? ("sandbar-managed" as const)
              : ("provider-scope" as const),
            items: result.items,
            nextCursor: result.nextCursor,
          };
        },
        processes,
        exec: {
          finiteStdin: "bytes",
          recovery: { version: 1, token: execToken },
          async prepare(input) {
            if (input.stdin && input.stdin.length > maxBytes)
              throw new AdapterError("INVALID_ARGUMENT", "Finite stdin exceeds byte bound");
            checkReference(input.sandbox);
            const argv = captureSpec(input).argv;

            if (
              !argv[0] ||
              [...argv, input.cwd ?? "", ...Object.values(input.env ?? {})].some((value) =>
                value.includes("\0"),
              )
            )
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Command arguments, cwd and environment must be non-NUL strings with a nonempty executable",
              );

            return input;
          },
          async submit(input, ctx) {
            const signal = AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout((input.deadlineSeconds + 10) * 1000),
            ]);

            const publicReference = input.sandbox.reference;
            input = { ...input, sandbox: await pin(input.sandbox, signal) };
            checkReference(input.sandbox);
            await verifySession(input.sandbox.id, signal);

            let stdinPath: string | undefined;

            if (input.stdin !== undefined) {
              stdinPath = `/tmp/sandbar-stdin-${crypto.randomUUID()}`;
              await ctx.checkpoint({
                version: 1,
                sessionId: input.sandbox.id,
                maxBytes: input.maxOutputBytes,
                reference: publicReference ?? reference(input.sandbox.id),
                stdinPath,
              });

              try {
                await fsCall(input.sandbox, "reserve", stdinPath, {
                  signal,
                  deadline: Date.now() + 30000,
                });
              } catch (cause) {
                if (cause instanceof AdapterFilesystemError && cause.details.effect === "none")
                  return ctx.reject(cause.code, cause.message);
                throw cause;
              }

              const response = await client.request(
                route(input.sandbox.id) + "/fs/write",
                signal,
                await archive(stdinPath, input.stdin),
                { "content-type": "application/gzip", "x-cwd": "/tmp" },
              );

              void response.body?.cancel().catch(() => {});
            }

            const launched = await client.json(route(input.sandbox.id) + "/cmd", signal, command, {
              command: "node",
              args: ["-e", captureHelper, JSON.stringify({ ...captureSpec(input), stdinPath })],
              sudo: false,
              env: {},
              timeout: (input.deadlineSeconds + 5) * 1000,
            });

            if (launched.command.sessionId !== input.sandbox.id)
              return ctx.unknown("Command session mismatch");

            const token: z.infer<typeof execToken> = {
              version: 1,
              sessionId: input.sandbox.id,
              commandId: launched.command.id,
              maxBytes: input.maxOutputBytes,
              reference: publicReference ?? reference(input.sandbox.id),
            };

            if (stdinPath) token.stdinPath = stdinPath;
            await ctx.checkpoint(token);

            return collect(token, signal, (confirmedExit) =>
              ctx.checkpoint({ ...token, confirmedExit }),
            );
          },
          async observe(attempt, ctx) {
            if (!attempt.token || !attempt.sandbox) return null;
            checkReference(attempt.sandbox);
            const token = execToken.parse(attempt.token);

            if (!config.persistent && token.sessionId !== attempt.sandbox.id)
              return ctx.unknown("Execution recovery session mismatch");

            if (config.persistent && attempt.sandbox.reference?.generation) {
              if (!token.reference)
                return ctx.unknown("Saved logical command identity is unavailable");
              assertResourceIdentity(token.reference, attempt.sandbox.reference);
              await named(attempt.sandbox, readSignal(ctx));
            }

            const signal = readSignal(ctx);
            await verifySession(token.sessionId, signal);

            return collect(token, signal);
          },
        },
        files: {
          maxBytes,
          readDirectory: async (input, ctx) => ({
            ...directorySchema.parse(await fsCall(input.sandbox, "list", input.path, ctx)),
            observedAt: new Date().toISOString(),
          }),
          list: async (input, ctx) =>
            directorySchema.parse(await fsCall(input.sandbox, "list", input.path, ctx)).entries,
          stat: async (input, ctx) =>
            fileStat(
              await fsCall(input.sandbox, "stat", input.path, ctx, "", input.followSymlinks),
            ),
          exists: async (input, ctx) => {
            try {
              await fsCall(input.sandbox, "stat", input.path, ctx);

              return true;
            } catch (cause) {
              if (cause instanceof AdapterFilesystemError && cause.code === "NOT_FOUND")
                return false;
              throw cause;
            }
          },
          copy: (input, ctx) => transfer(input, ctx, "copy"),
          move: (input, ctx) => transfer(input, ctx, "move"),
          makeDirectory: {
            prepare: async (input) => {
              path(input.path);

              if (input.path === "/")
                throw new AdapterError("INVALID_ARGUMENT", "Root mutation refused");

              return input;
            },
            submit: async (input, ctx) => {
              try {
                await fsCall(
                  input.sandbox,
                  "mkdir",
                  input.path,
                  { signal: ctx.signal, deadline: Date.now() + 30000 },
                  "",
                  input.recursive,
                );
              } catch (cause) {
                if (cause instanceof AdapterFilesystemError && cause.details.effect === "none")
                  return ctx.reject(cause.code, cause.message);
                throw cause;
              }

              return { acknowledged: true as const };
            },
          },
          remove: {
            prepare: async (input) => {
              path(input.path);

              if (input.path === "/")
                throw new AdapterError("INVALID_ARGUMENT", "Root mutation refused");

              return input;
            },
            submit: async (input, ctx) => {
              try {
                await fsCall(
                  input.sandbox,
                  "remove",
                  input.path,
                  { signal: ctx.signal, deadline: Date.now() + 30000 },
                  "",
                  input.recursive,
                );
              } catch (cause) {
                if (cause instanceof AdapterFilesystemError && cause.details.effect === "none")
                  return ctx.reject(cause.code, cause.message);
                throw cause;
              }

              return { acknowledged: true as const };
            },
          },
          readStream: async (input, ctx) => {
            input = { ...input, sandbox: await pin(input.sandbox, readSignal(ctx)) };
            checkReference(input.sandbox);
            path(input.path);
            const signal = ctx.signal;
            await verifySession(input.sandbox.id, readSignal(ctx));

            const response = await client.request(
              route(input.sandbox.id) + "/fs/read",
              signal,
              JSON.stringify({ path: input.path, cwd: "/" }),
            );

            if (
              !response.headers.get("content-type")?.includes("application/octet-stream") ||
              !response.body
            ) {
              void response.body?.cancel().catch(() => {});
              throw new AdapterError("UNAVAILABLE", "Expected binary file stream");
            }

            const reader = response.body.getReader();
            let stop: () => void = () => {};

            const cleanup = () => signal.removeEventListener("abort", stop);

            return new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  stop = () => {
                    cleanup();
                    void reader.cancel().catch(() => {});
                    controller.error(new AdapterError("TIMEOUT", "File stream interrupted"));
                  };

                  signal.addEventListener("abort", stop, { once: true });

                  if (signal.aborted) stop();
                },
                async pull(controller) {
                  try {
                    const chunk = await reader.read();

                    if (signal.aborted) return;

                    if (chunk.done) {
                      cleanup();
                      controller.close();
                    } else controller.enqueue(chunk.value);
                  } catch (cause) {
                    cleanup();
                    controller.error(cause);
                  }
                },
                cancel() {
                  cleanup();
                  void reader.cancel().catch(() => {});
                },
              },
              { highWaterMark: 0 },
            );
          },
          writeStream: async (input, ctx) => {
            input = { ...input, sandbox: await pin(input.sandbox, readSignal(ctx)) };
            checkReference(input.sandbox);
            path(input.path);

            if (input.path === "/")
              throw new AdapterError("INVALID_ARGUMENT", "Root write refused");
            const signal = ctx.signal;
            await verifySession(input.sandbox.id, readSignal(ctx));
            const operation = () => ({ signal, deadline: Date.now() + 30000 });
            const stage = posix.join(posix.dirname(input.path), `.sandbar-${crypto.randomUUID()}`);
            let chunkPath: string | undefined;
            let stageOwned = false;
            let bytesWritten = 0;
            ctx.retain?.({ temporaryPaths: [stage] });

            try {
              await fsCall(input.sandbox, "reserve", stage, operation());
              stageOwned = true;

              for await (const bytes of input.bytes) {
                signal.throwIfAborted();

                for (let offset = 0; offset < bytes.length; offset += 65536) {
                  chunkPath = posix.join(
                    posix.dirname(input.path),
                    `.sandbar-${crypto.randomUUID()}`,
                  );
                  ctx.retain?.({
                    temporaryPaths: [stage, chunkPath],
                    bytesTransferred: bytesWritten,
                  });
                  const chunk = bytes.subarray(offset, offset + 65536);

                  try {
                    await fsCall(input.sandbox, "reserve", chunkPath, operation());
                  } catch (cause) {
                    if (cause instanceof AdapterFilesystemError && cause.details.effect === "none")
                      chunkPath = undefined;
                    throw cause;
                  }

                  await upload(input.sandbox.id, chunkPath, chunk, signal);
                  await fsCall(input.sandbox, "append", stage, operation(), chunkPath);
                  bytesWritten += chunk.length;
                  chunkPath = undefined;
                  ctx.retain?.({ temporaryPaths: [stage], bytesTransferred: bytesWritten });
                }
              }

              await fsCall(
                input.sandbox,
                "publish",
                stage,
                operation(),
                input.path,
                input.overwrite,
              );
              ctx.retain?.({
                effect: "applied",
                temporaryPaths: [],
                bytesTransferred: bytesWritten,
              });

              return { bytesWritten };
            } catch (cause) {
              let temporaryPaths =
                !stageOwned &&
                cause instanceof AdapterFilesystemError &&
                cause.details.effect === "none"
                  ? []
                  : [stage, ...(chunkPath ? [chunkPath] : [])];

              if (
                cause instanceof AdapterFilesystemError &&
                cause.details.effect === "none" &&
                stageOwned &&
                !chunkPath
              ) {
                try {
                  await fsCall(input.sandbox, "remove", stage, operation());
                  temporaryPaths = [];
                  ctx.retain?.({ temporaryPaths, bytesTransferred: bytesWritten });
                } catch {
                  /* Preserve custody if stage cleanup cannot be confirmed. */
                }
              }

              ctx.retain?.({ temporaryPaths, bytesTransferred: bytesWritten });

              if (cause instanceof AdapterFilesystemError && cause.details.effect === "applied")
                ctx.retain?.({ effect: "applied" });
              throw new AdapterFilesystemError(
                cause instanceof AdapterError ? cause.code : "UNAVAILABLE",
                "Stream publication did not complete",
                {
                  effect:
                    cause instanceof AdapterFilesystemError ? cause.details.effect : "possible",
                  destination: input.path,
                  temporaryPaths,
                  bytesTransferred: bytesWritten,
                },
              );
            }
          },
          read: async (input, ctx) => {
            input = { ...input, sandbox: await pin(input.sandbox, readSignal(ctx)) };
            checkReference(input.sandbox);

            return read(
              input.sandbox.id,
              input.path,
              readSignal(ctx),
              input.maxBytes === undefined ? maxBytes : Math.min(input.maxBytes, maxBytes),
            );
          },
          write: {
            async prepare(input) {
              path(input.path);

              if (input.path === "/")
                throw new AdapterError("INVALID_ARGUMENT", "Root write refused");

              if (input.bytes.length > maxBytes)
                throw new AdapterError("INVALID_ARGUMENT", "File exceeds byte bound");

              return input;
            },
            async submit(input, ctx) {
              const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
              input = { ...input, sandbox: await pin(input.sandbox, signal) };
              checkReference(input.sandbox);
              await verifySession(input.sandbox.id, signal);

              const stage = posix.join(
                posix.dirname(input.path),
                `.sandbar-${crypto.randomUUID()}`,
              );

              let stageOwned = false;

              try {
                await fsCall(input.sandbox, "reserve", stage, {
                  signal,
                  deadline: Date.now() + 30000,
                });
                stageOwned = true;
                await upload(input.sandbox.id, stage, input.bytes, signal);
                await fsCall(
                  input.sandbox,
                  "publish",
                  stage,
                  { signal, deadline: Date.now() + 30000 },
                  input.path,
                  input.overwrite,
                );
              } catch (cause) {
                if (cause instanceof AdapterFilesystemError && cause.details.effect === "none") {
                  if (!stageOwned) return ctx.reject(cause.code, cause.message);

                  try {
                    await fsCall(input.sandbox, "remove", stage, {
                      signal,
                      deadline: Date.now() + 30000,
                    });
                  } catch {
                    throw new AdapterFilesystemError(cause.code, cause.message, {
                      effect: "none",
                      destination: input.path,
                      temporaryPaths: [stage],
                    });
                  }

                  return ctx.reject(cause.code, cause.message);
                }

                throw new AdapterFilesystemError(
                  cause instanceof AdapterError ? cause.code : "UNAVAILABLE",
                  "Buffered publication did not complete",
                  {
                    effect:
                      cause instanceof AdapterFilesystemError ? cause.details.effect : "possible",
                    destination: input.path,
                    temporaryPaths: [stage],
                  },
                );
              }

              return { bytesWritten: input.bytes.length };
            },
          },
        },
      };
    },
  });
}

export const vercel = createVercelAdapter();
