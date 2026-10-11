import { z } from "zod";
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { pack } from "tar-stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  AdapterError,
  defineAdapter,
  assertResourceScope,
  unknownSandboxFacts,
  type Sandbox,
  type SandboxReference,
  type SandboxInfo,
  type ReadContext,
  type ProcessObservationFailure,
} from "@sandbar-sdk/adapter";
import { boundedBody, VercelClient, type VercelTransport } from "./transport";
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
  region: z.literal("iad1").default("iad1"),
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
});

const nativeBox = z.object({
  name: z.string(),
  currentSessionId: id,
  persistent: z.boolean(),
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
});

const execToken = z.strictObject({
  version: z.literal(1),
  sessionId: id,
  commandId: id,
  maxBytes: z.number().int().min(0).max(1048576),
  confirmedExit: z.strictObject({ exitCode: z.number().int() }).optional(),
});

const maxBytes = 1048576;

const image = "vercel/sandbox/node:24";

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
    value.endsWith("/") ||
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

      const inspection = async (box: Sandbox, signal: AbortSignal): Promise<SandboxInfo> => {
        checkReference(box);
        const value = await get(box.id, signal);

        return {
          reference: reference(value.id),
          state: state(value.status),
          nativeState: value.status,
          observedAt: new Date().toISOString(),
          ...unknownSandboxFacts(),
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

      return {
        scope,
        defaultImage: { kind: "prepared", value: image },
        defaultNetworkPolicy: config.networkPolicy,
        supports: {
          images: ["prepared"],
          network: [config.networkPolicy],
          exec: { commands: ["argv", "shell"], maxOutputBytes: maxBytes },
          fileWrite: { overwrite: true, noClobber: false },
        },
        create: {
          recovery: { version: 1, token: createToken },
          async prepare(input) {
            if (
              input.image.kind !== "prepared" ||
              input.image.value !== image ||
              input.networkPolicy !== config.networkPolicy ||
              (input.region && input.region !== config.region) ||
              input.mounts?.length ||
              input.requirements
            )
              throw new AdapterError("UNSUPPORTED", "Unsupported Vercel creation option");

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
                image,
                region: config.region,
                persistent: false,
                timeout: config.timeoutSeconds * 1000,
                resources: { vcpus: 2 },
                ports: [],
                networkPolicy: { mode },
                tags: { ...input.labels, sandbarSubmission: ctx.submissionId },
              },
            );

            await ctx.checkpoint({
              version: 1,
              sessionId: acknowledgement.session.id,
              validated: false,
            });

            const parsed = z
              .object({ session: sessionSchema, sandbox: nativeBox })
              .safeParse(acknowledgement);

            if (!parsed.success)
              return ctx.unknown("Acknowledged session has incomplete configuration evidence");
            const result = parsed.data;

            const validated =
              result.sandbox.name === requestedName &&
              !result.sandbox.persistent &&
              result.sandbox.currentSessionId === result.session.id &&
              result.session.region === config.region &&
              result.session.networkPolicy?.mode === mode &&
              result.sandbox.networkPolicy?.mode === mode;

            const token = { version: 1 as const, sessionId: result.session.id, validated };
            await ctx.checkpoint(token);

            if (!validated)
              return ctx.unknown(
                "Acknowledged Vercel session failed configuration validation; retain recovery identity",
              );
            verifiedSessions.add(token.sessionId);

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
              );
            const value = await get(token.sessionId, readSignal(ctx));

            if (value.networkPolicy?.mode !== mode)
              return ctx.unknown("Acknowledged session network policy mismatch");

            if (value.status === "pending") return ctx.pending(token, { pollAfterMs: 250 });

            return {
              id: value.id,
              reference: reference(value.id),
              state: value.status === "running" ? "running" : "unknown",
            };
          },
        },
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
        exec: {
          recovery: { version: 1, token: execToken },
          async prepare(input) {
            if (input.stdin !== undefined)
              throw new AdapterError("UNSUPPORTED", "Vercel finite stdin is unavailable");
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

            const launched = await client.json(route(input.sandbox.id) + "/cmd", signal, command, {
              command: "node",
              args: ["-e", captureHelper, JSON.stringify(captureSpec(input))],
              sudo: false,
              env: {},
              timeout: (input.deadlineSeconds + 5) * 1000,
            });

            if (launched.command.sessionId !== input.sandbox.id)
              return ctx.unknown("Command session mismatch");

            const token = {
              version: 1 as const,
              sessionId: input.sandbox.id,
              commandId: launched.command.id,
              maxBytes: input.maxOutputBytes,
            };

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
              if (!input.overwrite)
                throw new AdapterError("UNSUPPORTED", "Atomic no-clobber writes unavailable");
              path(input.path);

              if (input.bytes.length > maxBytes)
                throw new AdapterError("INVALID_ARGUMENT", "File exceeds byte bound");

              return input;
            },
            async submit(input, ctx) {
              const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]);
              checkReference(input.sandbox);
              await verifySession(input.sandbox.id, signal);

              const response = await client.request(
                route(input.sandbox.id) + "/fs/write",
                signal,
                await archive(input.path, input.bytes),
                { "content-type": "application/gzip", "x-cwd": posix.dirname(input.path) },
              );

              void response.body?.cancel().catch(() => {});

              return { bytesWritten: input.bytes.length };
            },
          },
        },
      };
    },
  });
}

export const vercel = createVercelAdapter();
