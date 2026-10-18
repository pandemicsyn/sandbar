import type {
  BoatApi,
  CreateSandboxRequest,
  FetchAPI,
  Sandbox as NativeSandbox,
} from "@boatdev/sdk";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  assertResourceScope,
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type ExecInput,
  type FileWriteInput,
  type ReadContext,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxState,
} from "@sandbar-sdk/adapter";
import { parseWrapper, wrapperScript } from "./exec";
import {
  BOAT_API,
  createBoatClient,
  nativeFailure,
  refusedBeforeEffect,
  type NativeFailure,
} from "./transport";

/** Prepared image value for Boat's stock Ubuntu machine; a dot is never valid in a snapshot name. */
export const BASE_IMAGE = "ubuntu-24.04";

/** Boat accepts command timeouts of 1-600 seconds. */
export const MAX_EXEC_SECONDS = 600;

/** Per-stream output bound collected through the guest wrapper. */
export const MAX_OUTPUT_BYTES = 1_048_576;

/** Boat's documented write limit (5 MiB after decoding); reads use the same bound. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

const SnapshotName = /^[a-z0-9][a-z0-9-]{0,62}$/;

const ShareCode = /^bsh_[A-Za-z0-9_-]{1,256}$/;

const Image = z
  .string()
  .refine(
    (value) => value === BASE_IMAGE || SnapshotName.test(value) || ShareCode.test(value),
    `Use "${BASE_IMAGE}", a Boat named snapshot, or a bsh_ share code`,
  );

const Configuration = z
  .strictObject({
    /** Required consent: Boat sandboxes always have outbound internet access. */
    network: z.literal("internet").optional(),
    /** Default prepared image: the stock machine, a named snapshot or a share code. */
    image: Image.default(BASE_IMAGE),
    machine: z.enum(["small", "default", "large", "xlarge"]).default("default"),
    /**
     * Boat environment to attach (account variables, secret files and logins). Omitted,
     * sandboxes start with none of the account's secrets (`noEnv`).
     */
    environment: z.string().min(1).max(128).optional(),
    lifecycle: z
      .strictObject({
        /** Auto-archive after this many seconds; renew extends it. */
        lifetimeSeconds: z.number().int().min(60).max(MAX_TTL_SECONDS).default(900),
      })
      .default({ lifetimeSeconds: 900 }),
  })
  .superRefine((value, ctx) => {
    if (value.network === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message: 'Configure network: "internet"; Boat does not offer blocked egress',
      });
  })
  .transform(({ network, ...value }) => ({ ...value, networkPolicy: network ?? "internet" }));

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const CreateToken = z.strictObject({ id: Id });

const DestroyToken = z.strictObject({ id: Id, operation: Id.optional() });

const StopToken = z.strictObject({ id: Id });

type Native = Pick<
  BoatApi,
  | "me"
  | "create"
  | "get"
  | "sandboxes"
  | "deleteSandbox"
  | "getDeletionOperation"
  | "command"
  | "readFile"
  | "writeFile"
  | "stop"
  | "resume"
  | "update"
>;

const running = new Set(["ready", "idle", "running"]);

function state(native: string): SandboxState {
  switch (native) {
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
      return "creating";
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "archived":
      return "suspended";
    case "cancelled":
      return "destroyed";
    default:
      return "unknown";
  }
}

function readContext(signal: AbortSignal, seconds = 30): ReadContext {
  return { signal, deadline: Date.now() + seconds * 1000 };
}

function init(ctx: ReadContext): RequestInit {
  return {
    signal: AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now())),
    ]),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export type BoatAdapterOptions = {
  /** Native fetch used by the generated client; tests inject a deterministic fixture. */
  fetch?: FetchAPI;
  /** Poll interval while waiting for provisioning, archiving or deletion. */
  pollIntervalMs?: number;
  /** Longest a create, resume or stop waits in-call before returning a pending result. */
  settleSeconds?: number;
};

/** Constructing a definition performs no provider IO. */
export function createBoatAdapter(options: BoatAdapterOptions = {}) {
  const pollMs = options.pollIntervalMs ?? 1000;
  const settleSeconds = options.settleSeconds ?? 120;

  return defineAdapter({
    name: "boat",
    displayName: "Boat",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      const native: Native = createBoatClient(credentials.apiKey, options.fetch);
      const secrets = [credentials.apiKey];
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK throws are normalized at this boundary.
      const failure = (error: unknown) => nativeFailure(error, secrets);

      const read = async <T>(ctx: ReadContext, run: (request: RequestInit) => Promise<T>) => {
        try {
          return await run(init(ctx));
        } catch (error) {
          throw (await failure(error)).error;
        }
      };

      const me = await read(readContext(host.signal), (request) => native.me(request));
      const accountId = Id.safeParse(me.user.id);

      if (!accountId.success)
        throw new AdapterError("UNSUPPORTED", "Boat did not return a stable account id");

      if (me.user.suspended || me.user.closed)
        throw new AdapterError("FORBIDDEN", "The Boat account is suspended or closed");

      const scope = {
        authority: { kind: "account", id: accountId.data },
        partition: { endpoint: BOAT_API },
      };

      const checkedRef = (ref: SandboxReference) => {
        assertResourceScope(ref, { provider: "boat", scope });

        if (
          ref.kind !== "sandbox" ||
          ref.generation !== undefined ||
          !Id.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Boat sandbox identity");
      };

      const owned = (sandbox: NativeSandbox, id: string) => {
        if (sandbox.id !== id)
          throw new AdapterError("CONFLICT", "Boat returned a different sandbox identity");

        if (
          sandbox.createdById !== undefined &&
          sandbox.createdById !== null &&
          sandbox.createdById !== accountId.data
        )
          throw new AdapterError("CONFLICT", "Boat sandbox belongs to another account");

        return sandbox;
      };

      const find = async (id: string, ctx: ReadContext): Promise<NativeSandbox | null> => {
        Id.parse(id);

        try {
          return owned((await native.get({ sandboxId: id }, init(ctx))).sandbox, id);
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          const native = await failure(error);

          if (native.status === 404) return null;
          throw native.error;
        }
      };

      const requireSandbox = async (box: Sandbox, ctx: ReadContext) => {
        if (box.reference) checkedRef(box.reference);
        const sandbox = await find(box.id, ctx);

        if (!sandbox || sandbox.state === "cancelled")
          throw new AdapterError(
            "NOT_FOUND",
            "Boat sandbox is unavailable in the verified account",
          );

        return sandbox;
      };

      const requireRunning = async (box: Sandbox, ctx: ReadContext) => {
        const sandbox = await requireSandbox(box, ctx);

        if (!running.has(sandbox.state))
          throw new AdapterError(
            "CONFLICT",
            `Boat sandbox is ${sandbox.state}; commands and files need a ready sandbox`,
          );

        return sandbox;
      };

      const observation = (sandbox: NativeSandbox, ref: SandboxReference | null): SandboxInfo => ({
        reference: ref,
        state: state(sandbox.state),
        nativeState: sandbox.state,
        observedAt: new Date().toISOString(),
        ...unknownSandboxFacts(),
        expires: sandbox.archiveAfter
          ? {
              status: "known",
              at: sandbox.archiveAfter.toISOString(),
              action: "suspend",
              scope: "sandbox",
            }
          : sandbox.ttlSeconds === null
            ? { status: "none" }
            : { status: "unknown", reason: "Boat reported no auto-stop deadline" },
        idleStop: { status: "known", value: null },
      });

      const partialCreate = (
        id: string,
        identity: { operationId: string; submissionId: string },
      ) => ({
        kind: "create" as const,
        status: "partial" as const,
        sandbox: sandboxReference("boat", scope, id, {
          operation: identity.operationId,
          submission: identity.submissionId,
        }),
        setup: { expiry: "acknowledged" as const, readiness: "unconfirmed" as const },
      });

      /** Poll a read until it settles, the local wait ends, or the caller aborts. */
      const settle = async <T>(
        signal: AbortSignal,
        check: (ctx: ReadContext) => Promise<T | undefined>,
      ): Promise<T | undefined> => {
        const until = Date.now() + settleSeconds * 1000;

        for (;;) {
          const value = await check(readContext(signal));

          if (value !== undefined || Date.now() + pollMs > until) return value;
          await delay(pollMs, signal);
        }
      };

      const created = async (
        id: string,
        creation: { operation: string; submission: string },
        ctx: ReadContext,
      ) => {
        const sandbox = await find(id, ctx);

        if (!sandbox || !running.has(sandbox.state)) return { sandbox };

        return {
          sandbox,
          value: {
            id,
            reference: sandboxReference("boat", scope, id, creation),
            state: "running" as const,
          },
        };
      };

      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native SDK throws are normalized at this boundary.
      const rejection = async (ctx: AttemptContext, error: unknown, reason: string) => {
        const native: NativeFailure = await failure(error);

        return refusedBeforeEffect(native)
          ? ctx.reject(native.error.code, native.error.message)
          : ctx.unknown(`${reason}; do not replay`);
      };

      const session: AdapterSession<
        CreateInput,
        Sandbox,
        ExecInput,
        FileWriteInput,
        "argv" | "shell",
        z.infer<typeof CreateToken>
      > = {
        scope,
        defaultImage: { kind: "prepared", value: config.image },
        defaultNetworkPolicy: config.networkPolicy,
        supports: {
          images: ["prepared"],
          network: ["internet"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: false },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input) {
            if (input.image.kind !== "prepared")
              throw new AdapterError(
                "UNSUPPORTED",
                "Boat starts from its Ubuntu machine or a named snapshot; OCI images are unavailable",
              );

            if (!Image.safeParse(input.image.value).success)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Boat images are "${BASE_IMAGE}", a named snapshot, or a bsh_ share code`,
              );

            if (input.networkPolicy !== "internet")
              throw new AdapterError(
                "UNSUPPORTED",
                "Boat sandboxes always have outbound internet; blocked or allowlisted egress is unavailable",
              );

            if (
              input.region !== undefined ||
              (input.labels && Object.keys(input.labels).length) ||
              input.mounts?.length ||
              input.requirements
            )
              throw new AdapterError(
                "UNSUPPORTED",
                "Boat has no region selection, labels, volume mounts or snapshot requirements",
              );

            return input;
          },
          async submit(input, ctx) {
            let id: string;

            try {
              const request: CreateSandboxRequest = {
                type: config.machine,
                ttlSeconds: config.lifecycle.lifetimeSeconds,
              };

              if (input.image.value !== BASE_IMAGE) request.from = input.image.value;

              // Without a configured environment, withhold every account secret.
              if (config.environment === undefined) request.noEnv = true;
              else request.environment = config.environment;

              const response = await native.create(
                { idempotencyKey: ctx.submissionId, createSandboxRequest: request },
                init(readContext(ctx.signal)),
              );

              id = Id.parse(response.sandbox.id);
            } catch (error) {
              if (error instanceof z.ZodError)
                return ctx.unknown("Boat create acknowledgement has no usable sandbox id");

              return rejection(ctx, error, "Boat create response was not confirmed");
            }

            try {
              await ctx.checkpoint({ id });
            } catch (error) {
              if (error instanceof AdapterCheckpointError) error.outcome = partialCreate(id, ctx);
              throw error;
            }

            const creation = { operation: ctx.operationId, submission: ctx.submissionId };

            try {
              const result = await settle(ctx.signal, async (read) => {
                const current = await created(id, creation, read);

                if (current.value) return current;

                if (!current.sandbox || ["cancelled", "error"].includes(current.sandbox.state))
                  return current;

                return undefined;
              });

              if (result?.value) return result.value;

              if (result?.sandbox?.state === "cancelled" || (result && !result.sandbox))
                return ctx.unknown(
                  "Boat cancelled the sandbox before it became ready; nothing remains to clean up",
                  partialCreate(id, ctx),
                );

              if (result?.sandbox?.state === "error")
                return ctx.unknown(
                  "Boat reported an error while provisioning; inspect or destroy the sandbox",
                  partialCreate(id, ctx),
                );
            } catch {
              /* A failed readiness read is not evidence; continue through observation. */
            }

            return ctx.pending({ id }, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success)
              return ctx.unknown(
                "Boat create response was lost before a sandbox id arrived; inspect inventory without replay",
              );

            const current = await created(
              token.data.id,
              { operation: attempt.operationId, submission: attempt.submissionId },
              ctx,
            );

            if (current.value) return current.value;

            if (!current.sandbox || ["cancelled", "error"].includes(current.sandbox.state))
              return ctx.unknown(
                `Boat sandbox ${current.sandbox ? current.sandbox.state : "is gone"}; inspect without replay`,
                partialCreate(token.data.id, attempt),
              );

            return ctx.pending(token.data, { pollAfterMs: pollMs });
          },
        },
        async inspect(box, ctx) {
          if (box.reference) checkedRef(box.reference);
          const sandbox = await find(box.id, ctx);

          return sandbox
            ? { id: sandbox.id, ...observation(sandbox, box.reference ?? null) }
            : null;
        },
        async reopen(ref, ctx) {
          checkedRef(ref);

          return observation(await requireSandbox({ id: ref.nativeId, reference: ref }, ctx), ref);
        },
        async inventory(input, ctx) {
          const page = await read(ctx, (request) =>
            native.sandboxes({ limit: Math.min(200, input.limit), cursor: input.cursor }, request),
          );

          const items = page.sandboxes
            .filter(
              (sandbox) =>
                sandbox.createdById === undefined ||
                sandbox.createdById === null ||
                sandbox.createdById === accountId.data,
            )
            .map((sandbox) => ({
              id: Id.parse(sandbox.id),
              state:
                sandbox.state === "cancelled"
                  ? ("destroyed" as const)
                  : running.has(sandbox.state)
                    ? ("running" as const)
                    : ("unknown" as const),
            }));

          return {
            items,
            nextCursor: page.pageInfo?.hasMore
              ? (page.pageInfo.nextCursor ?? undefined)
              : undefined,
          };
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(input, ctx) {
            await requireSandbox(input, ctx);

            return input;
          },
          async submit(input, ctx) {
            const token: z.infer<typeof DestroyToken> = { id: Id.parse(input.id) };
            await ctx.checkpoint(token);
            let operation;

            try {
              operation = (
                await native.deleteSandbox(
                  { sandboxId: token.id, xAsciiConfirmDelete: token.id },
                  init(readContext(ctx.signal)),
                )
              ).operation;
            } catch (error) {
              const native = await failure(error);

              if (refusedBeforeEffect(native))
                return ctx.reject(native.error.code, native.error.message);

              return ctx.pending(token, { pollAfterMs: pollMs });
            }

            if (operation.targetId !== token.id || !Id.safeParse(operation.id).success)
              return ctx.unknown(
                "Boat deletion operation does not match the sandbox; do not replay",
              );
            const tracked = { ...token, operation: operation.id };
            await ctx.checkpoint(tracked);

            try {
              const done = await settle(ctx.signal, async (read) =>
                (await deleted(tracked, read)) ? true : undefined,
              );

              if (done) return { computeStopped: true, retainedResources: [] };
            } catch {
              /* Deletion is acknowledged; completion continues through observation. */
            }

            return ctx.pending(tracked, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id)
              return ctx.unknown("Boat deletion identity is unavailable; do not replay");

            if (!token.data.operation) {
              const sandbox = await find(token.data.id, ctx);

              return ctx.unknown(
                sandbox
                  ? "Boat delete response was lost and the sandbox still exists; destroy it again explicitly"
                  : "Boat delete response was lost; the sandbox is gone but teardown is unconfirmed",
              );
            }

            return (await deleted(token.data, ctx))
              ? { computeStopped: true, retainedResources: [] }
              : ctx.pending(token.data, { pollAfterMs: pollMs });
          },
        },
        exec: {
          finiteStdin: "bytes",
          async prepare(input, ctx) {
            if (input.deadlineSeconds > MAX_EXEC_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Boat commands run for at most ${MAX_EXEC_SECONDS} seconds`,
              );
            // Validates argv, env names and NUL bytes before any effect.
            wrapperScript({ ...input, maxBytes: input.maxOutputBytes });
            await requireRunning(input.sandbox, ctx);

            return input;
          },
          async submit(input, ctx) {
            let stdinPath: string | undefined;

            if (input.stdin !== undefined) {
              stdinPath = `/tmp/sandbar-stdin-${crypto.randomUUID()}`;

              try {
                const written = await native.writeFile(
                  {
                    sandboxId: input.sandbox.id,
                    fileWriteRequest: {
                      path: stdinPath,
                      content: base64(input.stdin),
                      encoding: "base64",
                    },
                  },
                  init(readContext(ctx.signal)),
                );

                if (written.size !== input.stdin.byteLength)
                  return ctx.unknown(
                    "Boat stored a different stdin length; the command did not run",
                  );
              } catch (error) {
                return rejection(
                  ctx,
                  error,
                  "Boat stdin upload was not confirmed; the command did not run",
                );
              }
            }

            let response;

            try {
              response = await native.command(
                {
                  sandboxId: input.sandbox.id,
                  commandRequest: {
                    command: wrapperScript({ ...input, stdinPath, maxBytes: input.maxOutputBytes }),
                    timeoutSeconds: Math.max(1, Math.ceil(input.deadlineSeconds)),
                  },
                },
                init(readContext(ctx.signal, input.deadlineSeconds + 30)),
              );
            } catch (error) {
              return rejection(ctx, error, "Boat command response was not confirmed");
            }

            if (!("stdout" in response))
              return ctx.unknown("Boat started the command detached; its result is unavailable");

            if (response.timedOut)
              return ctx.unknown(
                `Boat stopped the command at its ${input.deadlineSeconds}s deadline; output is unavailable`,
              );

            const result = response.stdoutTruncated ? null : parseWrapper(response.stdout);

            if (!result)
              return ctx.unknown("Boat ran the command but its result record could not be decoded");

            return result;
          },
        },
        files: {
          maxBytes: MAX_FILE_BYTES,
          async read(input, ctx) {
            await requireRunning(input.sandbox, ctx);

            const file = await read(ctx, (request) =>
              native.readFile(
                { sandboxId: input.sandbox.id, path: input.path, encoding: "base64" },
                request,
              ),
            );

            if (file.encoding !== "base64")
              throw new AdapterError("INTERNAL", "Boat returned a file in an unexpected encoding");
            const bytes = new Uint8Array(Buffer.from(file.content, "base64"));

            if (bytes.byteLength !== file.size)
              throw new AdapterError("INTERNAL", "Boat file length does not match its content");

            if (bytes.byteLength > (input.maxBytes ?? MAX_FILE_BYTES))
              throw new AdapterError("CAPACITY", "Boat file exceeds the read bound");

            return bytes;
          },
          write: {
            async prepare(input, ctx) {
              if (!input.overwrite)
                throw new AdapterError(
                  "UNSUPPORTED",
                  "Boat file writes always replace the target; no-clobber creation is unavailable",
                );

              if (input.bytes.byteLength > MAX_FILE_BYTES)
                throw new AdapterError("CAPACITY", "Boat file exceeds the write bound");
              await requireRunning(input.sandbox, ctx);

              return input;
            },
            async submit(input, ctx) {
              try {
                const written = await native.writeFile(
                  {
                    sandboxId: input.sandbox.id,
                    fileWriteRequest: {
                      path: input.path,
                      content: base64(input.bytes),
                      encoding: "base64",
                    },
                  },
                  init(readContext(ctx.signal)),
                );

                if (written.size !== input.bytes.byteLength)
                  return ctx.unknown("Boat stored a different file length; do not replay");

                return { bytesWritten: written.size };
              } catch (error) {
                return rejection(ctx, error, "Boat file write was not confirmed");
              }
            },
          },
        },
        async suspensionCapabilities() {
          return {
            status: "supported",
            value: { preserve: "filesystem", processes: "terminated", connections: "dropped" },
          };
        },
        async resumeCapabilities() {
          return {
            status: "supported",
            value: { sourceStates: ["suspended"], setsSessionTimeout: true },
          };
        },
        suspend: {
          recovery: { version: 1, token: StopToken },
          async prepare(input, ctx) {
            const sandbox = await requireSandbox(input.sandbox, ctx);

            if (!running.has(sandbox.state))
              throw new AdapterError(
                "CONFLICT",
                `Boat can archive only a ready sandbox, not ${sandbox.state}`,
              );

            if (sandbox.snapshots === false)
              throw new AdapterError(
                "UNSUPPORTED",
                "This Boat sandbox has snapshots off; archiving it would erase its disk",
              );

            return { ...input, intent: { action: "suspend", preserve: "filesystem" } };
          },
          async submit(input, ctx) {
            const token = { id: Id.parse(input.sandbox.id) };
            await ctx.checkpoint(token);

            try {
              await native.stop(
                { sandboxId: token.id, stopRequest: { force: false } },
                init(readContext(ctx.signal)),
              );
            } catch (error) {
              return rejection(ctx, error, "Boat stop response was not confirmed");
            }

            try {
              const archived = await settle(ctx.signal, async (read) => {
                const sandbox = await find(token.id, read);

                return sandbox?.state === "archived" ? sandbox : undefined;
              });

              if (archived)
                return {
                  reference: input.sandbox.reference,
                  preserve: "filesystem" as const,
                  processes: "terminated" as const,
                  connections: "dropped" as const,
                  observation: observation(archived, input.sandbox.reference),
                };
            } catch {
              /* Stop is acknowledged; archiving continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = StopToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.id !== box.id)
              return ctx.unknown("Boat stop identity is unavailable; do not replay");
            const sandbox = await find(token.data.id, ctx);

            if (!sandbox) return ctx.unknown("Boat sandbox disappeared while archiving");

            if (sandbox.state === "archived")
              return {
                reference: box.reference,
                preserve: "filesystem",
                processes: "terminated",
                connections: "dropped",
                observation: observation(sandbox, box.reference),
              };

            if (sandbox.stop?.status === "superseded")
              return ctx.unknown("A resume superseded the Boat stop before it archived");

            return ctx.pending(token.data, { pollAfterMs: pollMs });
          },
        },
        resume: {
          recovery: { version: 1, token: StopToken },
          async prepare(input, ctx) {
            const sandbox = await requireSandbox(input.sandbox, ctx);

            if (sandbox.state !== "archived")
              throw new AdapterError(
                "CONFLICT",
                `Boat can resume only an archived sandbox, not ${sandbox.state}`,
              );

            return {
              ...input,
              intent: { action: "resume", forSeconds: config.lifecycle.lifetimeSeconds },
            };
          },
          async submit(input, ctx) {
            const token = { id: Id.parse(input.sandbox.id) };

            const forSeconds =
              input.intent.action === "resume"
                ? (input.intent.forSeconds ?? config.lifecycle.lifetimeSeconds)
                : config.lifecycle.lifetimeSeconds;

            await ctx.checkpoint(token);

            try {
              await native.resume(
                { sandboxId: token.id, resumeRequest: { ttlSeconds: forSeconds } },
                init(readContext(ctx.signal)),
              );
            } catch (error) {
              return rejection(ctx, error, "Boat resume response was not confirmed");
            }

            try {
              const ready = await settle(ctx.signal, async (read) => {
                const sandbox = await find(token.id, read);

                return sandbox && running.has(sandbox.state) ? sandbox : undefined;
              });

              if (ready)
                return {
                  reference: input.sandbox.reference,
                  execution: "fresh" as const,
                  executionIdentity: unknownSandboxFacts().execution,
                  connections: "dropped" as const,
                  observation: observation(ready, input.sandbox.reference),
                };
            } catch {
              /* Resume is acknowledged; readiness continues through observation. */
            }

            return ctx.pending(token, { pollAfterMs: pollMs });
          },
          async observe(attempt, ctx) {
            const token = StopToken.safeParse(attempt.token);
            const box = attempt.sandbox;

            if (!token.success || !box?.reference || token.data.id !== box.id)
              return ctx.unknown("Boat resume identity is unavailable; do not replay");
            const sandbox = await find(token.data.id, ctx);

            if (!sandbox) return ctx.unknown("Boat sandbox disappeared while resuming");

            if (running.has(sandbox.state))
              return {
                reference: box.reference,
                execution: "fresh",
                executionIdentity: unknownSandboxFacts().execution,
                connections: "dropped",
                observation: observation(sandbox, box.reference),
              };

            return state(sandbox.state) === "creating" || sandbox.state === "archived"
              ? ctx.pending(token.data, { pollAfterMs: pollMs })
              : ctx.unknown(
                  `Boat sandbox is ${sandbox.state} after resume; inspect without replay`,
                );
          },
        },
        async renewCapabilities() {
          return {
            status: "supported",
            value: {
              minSeconds: 60,
              maxSeconds: MAX_TTL_SECONDS,
              stepSeconds: 1,
              scope: "sandbox",
            },
          };
        },
        renew: {
          async prepare(input, ctx) {
            await requireSandbox(input.sandbox, ctx);
            const forSeconds = input.forSeconds ?? config.lifecycle.lifetimeSeconds;

            if (forSeconds < 60 || forSeconds > MAX_TTL_SECONDS)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                `Boat auto-stop windows are 60 to ${MAX_TTL_SECONDS} seconds`,
              );

            return { ...input, forSeconds };
          },
          async submit(input, ctx) {
            let sandbox: NativeSandbox;

            try {
              sandbox = (
                await native.update(
                  {
                    sandboxId: input.sandbox.id,
                    updateSandboxRequest: { ttlSeconds: input.forSeconds },
                  },
                  init(readContext(ctx.signal)),
                )
              ).sandbox;
            } catch (error) {
              return rejection(ctx, error, "Boat auto-stop update was not confirmed");
            }

            return {
              reference: input.sandbox.reference,
              requested: { forSeconds: input.forSeconds },
              acknowledged: true,
              observation:
                sandbox.id === input.sandbox.id
                  ? observation(sandbox, input.sandbox.reference)
                  : null,
            };
          },
        },
      };

      /** Deletion removes the sandbox from every list at once; the machine stops once removal ends. */
      async function deleted(token: z.infer<typeof DestroyToken>, ctx: ReadContext) {
        if (!token.operation) return false;

        const operation = await read(ctx, (request) =>
          native.getDeletionOperation({ operationId: token.operation ?? "" }, request),
        );

        if (operation.operation.targetId !== token.id)
          throw new AdapterError("CONFLICT", "Boat deletion operation targets another sandbox");

        return (
          operation.operation.status === "completed" ||
          (operation.operation.stage !== undefined && operation.operation.stage !== "removing")
        );
      }

      return session;
    },
  });
}

export const boatAdapter = createBoatAdapter();
