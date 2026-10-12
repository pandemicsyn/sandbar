import { z } from "zod";
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { pack } from "tar-stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AdapterError,
  AdapterFilesystemError,
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
  unknownSandboxFacts,
  type Sandbox,
  type SandboxReference,
  type SandboxInfo,
  type ReadContext,
  type ProcessObservationFailure,
} from "@sandbar-sdk/adapter";
import { boundedBody, VercelClient, type VercelTransport } from "./transport";
import { startVercelProcess, reopenVercelProcess } from "./process-native";
import { filesystemHelper, filesystemValue, directorySchema, fileStat } from "./filesystem";
import { captureHelper, captureSpec, decodeReceipt } from "./capture";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const policy = z.enum(["vercel-deny-all", "vercel-allow-all"]);

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
  vcpus: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(2),
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
    .default("vercel/sandbox/node:24"),
  timeoutSeconds: z.number().int().min(60).max(300).default(300),
  networkPolicy: policy.default("vercel-deny-all"),
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

const nativeBox = z.object({
  name: z.string(),
  currentSessionId: id,
  persistent: z.boolean(),
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
  imageIdentity: z.string().optional(),
  sourceSnapshotId: id.optional(),
});

const execToken = z.strictObject({
  version: z.literal(1),
  sessionId: id,
  commandId: id.optional(),
  stdinPath: z
    .string()
    .regex(/^\/tmp\/sandbar-stdin-[0-9a-f-]{36}$/)
    .optional(),
  maxBytes: z.number().int().min(0).max(1048576),
  confirmedExit: z.strictObject({ exitCode: z.number().int() }).optional(),
});

const maxBytes = 1048576;

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
      const mode = config.networkPolicy === "vercel-deny-all" ? "deny-all" : "allow-all";
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
          box.reference.generation !== undefined
        )
          throw new AdapterError(
            "CONFLICT",
            "Vercel sandbox reference differs from immutable session identity",
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

      const expiry = (value: z.infer<typeof sessionSchema>): SandboxInfo["expires"] => {
        if (value.startedAt === undefined || value.timeout === undefined)
          return { status: "unknown", reason: "Native deadline is unavailable" };

        return {
          status: "known",
          at: new Date(value.startedAt + value.timeout).toISOString(),
          action: "destroy",
          scope: "running-session",
        };
      };

      const inspection = async (box: Sandbox, signal: AbortSignal): Promise<SandboxInfo> => {
        checkReference(box);
        const value = await get(box.id, signal);

        return {
          reference: box.reference ?? reference(value.id),
          state: state(value.status),
          nativeState: value.status,
          observedAt: new Date().toISOString(),
          ...unknownSandboxFacts(),
          expires: expiry(value),
          execution: { status: "known", value: { nativeId: value.id } },
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
        checkReference(box);
        const signal = readSignal(ctx);
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
              input.networkPolicy !== config.networkPolicy ||
              (input.region && input.region !== config.region) ||
              input.mounts?.length
            )
              throw new AdapterError("UNSUPPORTED", "Unsupported Vercel creation option");

            if (input.requirements?.snapshot) {
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
            const requestedName = `sandbar-${crypto.randomUUID()}`;

            const acknowledgement = await client.json(
              "/v3/sandboxes",
              signal,
              z.object({ session: z.object({ id }).passthrough() }).passthrough(),
              {
                projectId: project.id,
                name: requestedName,
                image: sourceSnapshotId ? undefined : image,
                mounts: {},
                source: sourceSnapshotId
                  ? { type: "snapshot", snapshotId: sourceSnapshotId }
                  : undefined,
                region: config.region,
                persistent: false,
                timeout: config.timeoutSeconds * 1000,
                resources: { vcpus: config.vcpus },
                ports: config.ports,
                failoverRegions: [],
                networkPolicy: { mode },
                tags: { ...input.labels, sandbarSubmission: ctx.submissionId },
              },
            );

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
              !result.sandbox.persistent &&
              result.sandbox.currentSessionId === result.session.id &&
              result.session.region === config.region &&
              result.session.vcpus === config.vcpus &&
              result.session.timeout === config.timeoutSeconds * 1000 &&
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
              id: token.sessionId,
              reference: reference(token.sessionId),
              state: result.session.status === "running" ? "running" : "unknown",
            };
          },
          async observe(attempt, ctx) {
            if (!attempt.token) return null;
            const token = createToken.parse(attempt.token);

            if (!token.validated)
              return ctx.unknown(
                "Acknowledged configuration mismatch; manual session cleanup required",
                createOutcome(token.sessionId, attempt, token.sourceSnapshotId),
              );

            if (token.imageIdentity) observedImages.set(token.sessionId, token.imageIdentity);
            const value = await get(token.sessionId, readSignal(ctx));

            if (
              value.networkPolicy?.mode !== mode ||
              (token.sourceSnapshotId && value.sourceSnapshotId !== token.sourceSnapshotId)
            )
              return ctx.unknown("Acknowledged session network policy mismatch");

            if (value.status === "pending") return ctx.pending(token, { pollAfterMs: 250 });

            return {
              id: value.id,
              reference: reference(value.id),
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
        preserve: "filesystem",
        sourceStates: ["running"],
        interruption: "terminate",
        sourceAfter: "destroyed",
        connections: "dropped",
        consistency: "unknown",
        restoreExecution: "fresh",
        mountHandling: "none",
      };

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
            networkPolicies: [config.networkPolicy],
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
              start: (
                input: import("@sandbar-sdk/adapter").ProcessStartInput,
                ctx: import("@sandbar-sdk/adapter").ProcessStartContext,
              ) => startVercelProcess(executeProcess(input.sandbox), input, ctx),
              reopen: (
                input: import("@sandbar-sdk/adapter").ProcessReopenInput,
                ctx: import("@sandbar-sdk/adapter").ProcessStartContext,
              ) => reopenVercelProcess(executeProcess(input.sandbox), input, ctx),
            }
          : undefined;

      return {
        scope,
        defaultImage: { kind: "prepared", value: image },
        defaultNetworkPolicy: config.networkPolicy,
        supports: {
          images: ["prepared"],
          network: [config.networkPolicy],
          exec: { commands: ["argv", "shell"], maxOutputBytes: maxBytes },
          fileWrite: { overwrite: true, noClobber: true },
        },
        renewCapabilities: async (target, ctx) => {
          if (target.sandbox) {
            checkReference(target.sandbox);

            if ((await get(target.sandbox.id, readSignal(ctx))).status !== "running")
              return { status: "unavailable" as const, reason: "Only running sessions can renew" };
          }

          return {
            status: "supported" as const,
            value: {
              minSeconds: 1,
              maxSeconds: 300,
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
              forSeconds: z.number().int().min(1).max(300),
            }),
          },
          prepare: async (input) => {
            checkReference(input.sandbox);
            const forSeconds = input.forSeconds ?? config.timeoutSeconds;

            if (forSeconds < 1 || forSeconds > 300 || !Number.isInteger(forSeconds))
              throw new AdapterError("INVALID_ARGUMENT", "Renewal window must be 1–300 seconds");

            return { ...input, forSeconds };
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            const before = await get(input.sandbox.id, signal);

            if (before.status !== "running")
              return ctx.reject("CONFLICT", "Only running sessions can renew");
            await ctx.checkpoint({
              reference: input.sandbox.reference,
              forSeconds: input.forSeconds,
            });

            const result = await client.json(
              route(input.sandbox.id) + "/extend-timeout",
              signal,
              z.object({ session: sessionSchema }),
              { duration: input.forSeconds * 1000 },
            );

            if (result.session.id !== input.sandbox.id || result.session.region !== config.region)
              return ctx.unknown("Renewal session mismatch");

            return {
              reference: reference(input.sandbox.id),
              requested: { forSeconds: input.forSeconds },
              acknowledged: true as const,
              observation: {
                reference: reference(input.sandbox.id),
                state: state(result.session.status),
                nativeState: result.session.status,
                observedAt: new Date().toISOString(),
                ...unknownSandboxFacts(),
                execution: { status: "known" as const, value: { nativeId: input.sandbox.id } },
                expires: expiry(result.session),
              },
            };
          },
          observe: async (attempt, ctx) => {
            if (!attempt.token || !attempt.sandbox?.reference) return null;

            const token = z
              .strictObject({
                reference: ResourceReference,
                forSeconds: z.number().int().min(1).max(300),
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
        snapshotProfiles: async () => ({
          status: "supported" as const,
          value: { profiles: [profile], defaultProfileId: profile.id },
        }),
        resourceCapabilities: async () => ({
          restore: {
            status: "supported" as const,
            value: {
              networkPolicies: [config.networkPolicy],
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
              throw new AdapterError("UNSUPPORTED", "Scheduled snapshot deletion is unavailable");

            return input;
          },
          submit: async (input, ctx) => {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);

            const ack = await client.json(
              route(input.sandbox.id) + "/snapshot",
              signal,
              z.object({ snapshot: z.object({ id }).passthrough() }).passthrough(),
              {},
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
          prepare: async (input, ctx) => {
            checkSnapshot(input.snapshot);

            if (
              input.request.networkPolicy !== config.networkPolicy ||
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
              { image: { kind: "prepared", value: image }, networkPolicy: config.networkPolicy },
              ctx,
            );
          },
          observe: async (attempt, ctx) => {
            if (!attempt.resource || !attempt.token) return null;
            checkSnapshot(attempt.resource);
            const token = createToken.parse(attempt.token);

            if (token.sourceSnapshotId !== attempt.resource.nativeId)
              return ctx.unknown("Restore snapshot resource mismatch");
            const mutation = makeCreation(token.sourceSnapshotId);

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
          async submit(box, ctx) {
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
            checkReference(box);
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
          const query = new URLSearchParams({
            project: project.id,
            limit: String(Math.min(input.limit, 100)),
          });

          if (input.cursor) query.set("cursor", input.cursor);
          const result = await client.json(`/v2/sandboxes?${query}`, readSignal(ctx), page);

          return {
            items: result.sandboxes
              .filter((box) => !box.persistent && box.region === config.region)
              .map((box) => ({ id: box.currentSessionId, state: state(box.status) })),
            nextCursor: result.pagination.next ?? undefined,
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

            checkReference(input.sandbox);
            await verifySession(input.sandbox.id, signal);

            let stdinPath: string | undefined;

            if (input.stdin !== undefined) {
              stdinPath = `/tmp/sandbar-stdin-${crypto.randomUUID()}`;
              await ctx.checkpoint({
                version: 1,
                sessionId: input.sandbox.id,
                maxBytes: input.maxOutputBytes,
                stdinPath,
              });

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

            if (token.sessionId !== attempt.sandbox.id)
              return ctx.unknown("Execution recovery session mismatch");
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
          read: (input, ctx) => {
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
