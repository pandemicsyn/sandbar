import { z } from "zod";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  AdapterError,
  assertResourceScope,
  defineAdapter,
  Preserve,
  PreserveSchema,
  resolveSnapshot,
  ResourceMinimums,
  type AttemptContext,
  type Fact,
  type ResourceReference,
  type SandboxResources,
  type SnapshotInfo,
  type SnapshotProfile,
} from "@sandbar-sdk/adapter";
import {
  createSdkTransport,
  MODAL_ENDPOINT,
  ModalCreateRejected,
  type ModalTransport,
} from "./transport";
import { startModalProcess } from "./process";

const MAX_BYTES = 1_048_576;

const ModalImageId = z.string().regex(/^im-[A-Za-z0-9_-]+$/, "Use an existing Modal image ID");

/** Works with every adapter feature: it has a POSIX shell, coreutils and Python. */
const DEFAULT_IMAGE = { kind: "oci" as const, value: "python:3.12-slim" };

const Configuration = z.strictObject({
  appName: z.string().min(1).max(128),
  environment: z.string().min(1).max(128),
  region: z.string().min(1).max(128).optional(),
  /** Default for creates without an image: an `im-` ID, or a prepared or OCI image. */
  image: z
    .union([
      ModalImageId.transform((value) => ({ kind: "prepared" as const, value })),
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("prepared"), value: ModalImageId }),
        z.strictObject({ kind: z.literal("oci"), value: z.string().min(1).max(1024) }),
      ]),
    ])
    .default(DEFAULT_IMAGE),
  /**
   * Minimum size, reserved exactly: `vcpus` becomes Modal's CPU reservation (fractions allowed) and
   * `memoryMiB` its memory reservation. Unset dimensions take Modal's defaults.
   */
  resources: ResourceMinimums.optional(),
  /** Modal allows sandboxes to run for up to 24 hours. */
  timeoutSeconds: z.coerce.number().int().min(60).max(86_400).default(900),
  snapshots: z
    .strictObject({
      /** Modal filesystem snapshots keep files only; `filesystem+memory` rejects at connect. */
      preserve: PreserveSchema.optional(),
      /** Seconds Modal keeps each snapshot image after capture; `0` keeps it until deleted. */
      retentionSeconds: z.number().int().nonnegative().safe().optional(),
    })
    .optional(),
});

const Credentials = z.strictObject({
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1),
});

const RecordSchema = z.strictObject({
  id: z.string().min(1).max(128),
  tags: z.record(z.string(), z.string()),
  running: z.boolean(),
});

const ExecToken = z.strictObject({
  maxBytes: z.number().int().min(0).max(MAX_BYTES),
  inputComplete: z.boolean().optional(),
});

const WriteToken = z.strictObject({ expectedBytes: z.number().int().min(0).max(MAX_BYTES) });

const DestroyToken = z.strictObject({ id: z.string().min(1).max(128) });

/** Modal keeps a filesystem snapshot image for 30 days from creation, then deletes it. */
const SNAPSHOT_RETENTION_SECONDS = 30 * 86_400;

/** The capture profile; `retentionSeconds` 0 keeps images until explicitly deleted. */
const snapshotProfile = (retentionSeconds = SNAPSHOT_RETENTION_SECONDS): SnapshotProfile => ({
  id: "modal-filesystem",
  preserve: Preserve.FILESYSTEM,
  sourceStates: ["running"],
  // Modal does not document whether a filesystem snapshot pauses the source; claim no less.
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "unknown",
  consistency: "unknown",
  restoreExecution: "fresh",
  mountHandling: "none",
  minimumRetentionSeconds: retentionSeconds === 0 ? Number.MAX_SAFE_INTEGER : retentionSeconds,
});

/** A restored sandbox is an ordinary Modal create from the snapshot image. */
const restoreSupport = {
  networkPolicies: ["blocked"],
  resources: false,
  mounts: false,
  independentLifecycle: true,
};

function writeCount(bytes: Uint8Array): number | undefined {
  const receipt = new TextDecoder().decode(bytes).trim();

  if (!/^\d+$/.test(receipt)) return undefined;
  const count = Number(receipt);

  return Number.isSafeInteger(count) ? count : undefined;
}

type RecordValue = z.output<typeof RecordSchema>;

type PreparedCreate = {
  imageId: string;
  ociReference?: string | undefined;
  labels: Record<string, string>;
  env?: Record<string, string> | undefined;
};

/** Modal does not report reservations back, so the adapter records the full one in a tag. */
const RESOURCES_TAG = "sandbar_resources";

function recordSize(record: RecordValue): Fact<SandboxResources> {
  const match = /^(\d+(?:\.\d+)?)\/(\d+)$/.exec(record.tags[RESOURCES_TAG] ?? "");
  const vcpus = Number(match?.[1]);
  const memoryMiB = Number(match?.[2]);

  return match && vcpus > 0 && Number.isSafeInteger(memoryMiB) && memoryMiB > 0
    ? { status: "known", value: { vcpus, memoryMiB } }
    : { status: "unknown", reason: "Modal reports no size unless both resources are configured" };
}

export function modalWriteScript(overwrite: boolean): string {
  const prefix = 'umask 077; mkdir -p -- "$1" && ';

  return prefix + (overwrite ? "" : "set -C && ") + 'cat > "$2" && wc -c < "$2"';
}

function modalExecId(submissionId: string): string {
  const bytes = createHash("sha256")
    .update("sandbar-modal-exec\0")
    .update(submissionId)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Create a Modal adapter using the pinned single-attempt control transport. */
export function createModalAdapter(
  transportFactory?: (options: {
    tokenId: string;
    tokenSecret: string;
    appName: string;
    environment: string;
    region?: string;
    timeoutSeconds: number;
  }) => ModalTransport,
) {
  return defineAdapter({
    name: "modal",
    displayName: "Modal",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      if (config.snapshots?.preserve === Preserve.FILESYSTEM_AND_MEMORY)
        throw new AdapterError(
          "UNSUPPORTED",
          "Modal snapshots keep the filesystem only; memory snapshots are not supported",
        );

      const retentionSeconds = config.snapshots?.retentionSeconds;
      const profile = snapshotProfile(retentionSeconds);

      const snapshotSupport = {
        status: "supported" as const,
        value: { profiles: [profile], defaultProfileId: profile.id },
      };

      // Modal's `ttlMs` is a hard cutoff from capture; `null` keeps the image indefinitely.
      const ttlMs =
        retentionSeconds === undefined
          ? undefined
          : retentionSeconds
            ? retentionSeconds * 1000
            : null;

      const options = { ...config, ...credentials };
      const transport = transportFactory?.(options) ?? createSdkTransport(options);
      host.onClose(() => transport.close());
      const appId = await transport.lookupApp(config.appName, config.environment);

      if (!/^ap-[A-Za-z0-9_-]+$/.test(appId))
        throw new AdapterError("UNAUTHENTICATED", "Modal App identity is invalid");

      const verify = async () => {
        if ((await transport.lookupApp(config.appName, config.environment)) !== appId)
          throw new AdapterError("UNAUTHENTICATED", "Modal App identity changed");
      };

      const listPage = async (input: { cursor?: string; limit: number }) => {
        await verify();
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);

        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid inventory cursor");
        const items: { id: string; state: "running" | "unknown" }[] = [];
        let position = 0;

        for await (const value of transport.list(appId)) {
          if (position++ < offset) continue;
          const record = RecordSchema.parse(value);
          items.push({ id: record.id, state: record.running ? "running" : "unknown" });

          if (items.length > input.limit) break;
        }

        return {
          items: items.slice(0, input.limit),
          nextCursor: items.length > input.limit ? String(offset + input.limit) : undefined,
        };
      };

      const scope = {
        authority: { kind: "app", id: appId },
        partition: {
          endpoint: MODAL_ENDPOINT,
          environment: config.environment,
          region: config.region ?? "",
        },
      };

      const find = async (id: string): Promise<RecordValue | null> => {
        await verify();

        for await (const value of transport.list(appId)) {
          const record = RecordSchema.parse(value);

          if (record.id === id) return record;
        }

        return null;
      };

      const snapshotReference = (
        id: string,
        ownership: ResourceReference["ownership"] = "unknown",
      ): ResourceReference & { kind: "snapshot" } => ({
        version: 1,
        kind: "snapshot",
        provider: "modal",
        scope,
        nativeId: id,
        ownership,
      });

      const checkSnapshot = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "modal", scope });

        if (
          ref.kind !== "snapshot" ||
          ref.generation !== undefined ||
          !ModalImageId.safeParse(ref.nativeId).success
        )
          throw new AdapterError("CONFLICT", "Invalid Modal snapshot identity");
      };

      /** Modal reports nothing about an image beyond its ID, so only capture knows its source. */
      const snapshotInfo = (
        ref: ResourceReference & { kind: "snapshot" },
        source: { id: string; createdAt: string } | null,
      ): SnapshotInfo => ({
        reference: ref,
        preserve: "filesystem",
        restoreExecution: "fresh",
        consistency: "unknown",
        source: source && { id: source.id, class: "modal-sandbox" },
        state: "ready",
        createdAt: source?.createdAt ?? null,
        expiration: "unknown",
        excludedPaths: null,
        mounts: [],
        // The adapter never mounts volumes, and Modal leaves mounts out of the root filesystem.
        mountHandling: "none",
        restore: restoreSupport,
        dependencies: [],
        nativeDependencies: null,
      });

      const requireSnapshot = async (ref: ResourceReference) => {
        checkSnapshot(ref);
        await verify();

        if (!(await transport.imageExists(ref.nativeId)))
          throw new AdapterError("NOT_FOUND", "Modal snapshot image is unavailable or expired");
      };

      const submitCreate = async (input: PreparedCreate, ctx: AttemptContext) => {
        if (ctx.submissionId.length >= 64)
          return ctx.reject("INVALID_ARGUMENT", "Modal sandbox name exceeds native limit");

        try {
          const request: Parameters<ModalTransport["create"]>[0] = {
            appId,
            imageId: input.imageId,
            name: ctx.submissionId,
            tags: {
              ...input.labels,
              sandbar_submission: ctx.submissionId,
              sandbar_operation: ctx.operationId,
            },
            timeoutMs: config.timeoutSeconds * 1000,
          };

          if (config.resources?.vcpus !== undefined) request.cpu = config.resources.vcpus;

          if (config.resources?.memoryMiB !== undefined)
            request.memoryMiB = config.resources.memoryMiB;

          if (request.cpu !== undefined && request.memoryMiB !== undefined)
            request.tags[RESOURCES_TAG] = `${request.cpu}/${request.memoryMiB}`;

          if (input.ociReference) request.ociReference = input.ociReference;

          if (input.env) request.env = input.env;

          if (config.region) request.regions = [config.region];
          const id = await transport.create(request);

          if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
            return ctx.unknown("Modal returned an invalid sandbox ID");

          const record = await transport.findByName(
            config.appName,
            config.environment,
            ctx.submissionId,
          );

          if (
            !record ||
            record.id !== id ||
            record.tags.sandbar_submission !== ctx.submissionId ||
            record.tags.sandbar_operation !== ctx.operationId
          )
            return ctx.unknown("Modal create identity could not be correlated");

          return { id, state: record.running ? ("running" as const) : ("unknown" as const) };
        } catch (error) {
          if (error instanceof ModalCreateRejected)
            return error.imageBuilt
              ? ctx.unknown(`${error.message}; the built image remains; observe without replay`)
              : ctx.reject(error.code, error.message);

          return ctx.unknown("Modal create response unavailable; observe without replay");
        }
      };

      const observeCreate = async (attempt: { submissionId: string; operationId: string }) => {
        await verify();

        const record = await transport.findByName(
          config.appName,
          config.environment,
          attempt.submissionId,
        );

        if (
          !record ||
          record.tags.sandbar_submission !== attempt.submissionId ||
          record.tags.sandbar_operation !== attempt.operationId
        )
          return null;
        const checked = RecordSchema.parse(record);

        return {
          id: checked.id,
          state: checked.running ? ("running" as const) : ("unknown" as const),
        };
      };

      return {
        scope,
        defaultImage: config.image,
        supports: {
          images: ["prepared", "oci"],
          network: ["blocked"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
        },
        create: {
          async prepare(input) {
            if (input.image.kind === "prepared" && !/^im-[A-Za-z0-9_-]+$/.test(input.image.value))
              throw new AdapterError("UNSUPPORTED", "Use an existing Modal image ID");

            if (
              input.image.kind === "oci" &&
              !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,1023}$/.test(input.image.value)
            )
              throw new AdapterError("INVALID_ARGUMENT", "Invalid OCI image reference");

            if (input.region && input.region !== config.region)
              throw new AdapterError(
                "UNSUPPORTED",
                "Modal region differs from the verified connection",
              );

            if (input.labels && Object.keys(input.labels).some((key) => key.startsWith("sandbar_")))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved Modal tag prefix");
            await verify();

            if (
              input.image.kind === "prepared" &&
              !(await transport.imageExists(input.image.value))
            )
              throw new AdapterError("NOT_FOUND", "Modal image is unavailable");

            return {
              imageId: input.image.kind === "prepared" ? input.image.value : "",
              ociReference: input.image.kind === "oci" ? input.image.value : undefined,
              labels: input.labels ?? {},
              env: input.env,
            };
          },
          submit: submitCreate,
          observe: observeCreate,
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(box) {
            const record = await find(box.id);

            if (!record)
              throw new AdapterError(
                "NOT_FOUND",
                "Modal sandbox was not found in the verified App",
              );

            return box;
          },
          async submit(box, ctx) {
            try {
              const stopped = await transport.terminate(box.id);

              return stopped
                ? { computeStopped: true, retainedResources: [] }
                : ctx.pending({ id: box.id });
            } catch {
              return ctx.pending({ id: box.id });
            }
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id)
              return ctx.unknown("Modal termination scope evidence is unavailable; do not replay");

            await verify();

            try {
              const state = await transport.poll(token.data.id);

              return state === "stopped"
                ? { computeStopped: true, retainedResources: [] }
                : ctx.unknown("Modal termination is not confirmed; do not replay");
            } catch {
              return ctx.unknown("Modal termination observation failed; do not replay");
            }
          },
        },
        async inspect(box) {
          const record = await find(box.id);

          return record
            ? {
                id: record.id,
                state: record.running ? ("running" as const) : ("unknown" as const),
                resources: recordSize(record),
              }
            : null;
        },
        async inventory(input) {
          return listPage(input);
        },
        async sandboxList(input) {
          const page = await listPage(input);

          return {
            // Every sandbox in the verified App is listed. This adapter has no reopen support,
            // so listed sandboxes carry no reference.
            coverage: "provider-scope" as const,
            items: page.items.map((item) => ({ ...item, reference: null })),
            nextCursor: page.nextCursor,
          };
        },
        snapshotProfiles: async () => snapshotSupport,
        resourceCapabilities: async () => ({
          restore: { status: "supported" as const, value: restoreSupport },
          volumes: {
            status: "unsupported" as const,
            reason: "Modal volumes are not exposed as Sandbar volumes yet",
          },
          mounts: {
            status: "unsupported" as const,
            reason: "Modal volume mounts are not exposed as Sandbar mounts yet",
          },
        }),
        snapshotCapture: {
          async prepare(input) {
            const record = await find(input.sandbox.id);

            if (!record)
              throw new AdapterError(
                "NOT_FOUND",
                "Modal sandbox was not found in the verified App",
              );

            const plan = resolveSnapshot(
              snapshotSupport,
              input.request,
              record.running ? "running" : "unknown",
            );

            if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

            if (input.request.retention?.cleanupAfterSeconds !== undefined)
              throw new AdapterError(
                "UNSUPPORTED",
                "Set Modal snapshot expiry with snapshots.retentionSeconds in adapter setup",
              );

            return input;
          },
          async submit(input, ctx) {
            let imageId: string;

            try {
              imageId = await transport.snapshotFilesystem(input.sandbox.id, ttlMs);
            } catch (error) {
              if (error instanceof ModalCreateRejected)
                return ctx.reject(error.code, error.message);

              // Modal names no image until the call returns, so a lost response leaves nothing to
              // observe. Any image it made expires with the configured retention.
              return ctx.unknown(
                "Modal filesystem snapshot response was not confirmed; any image it made expires with its retention; do not replay",
              );
            }

            if (!ModalImageId.safeParse(imageId).success)
              return ctx.unknown("Modal returned an invalid snapshot image ID; do not replay");
            const createdAt = new Date().toISOString();
            const reference = snapshotReference(imageId, "verified-created");

            return {
              snapshot: snapshotInfo(reference, { id: input.sandbox.id, createdAt }),
              capture: {
                preserve: "filesystem" as const,
                interruption: profile.interruption,
                restoreExecution: "fresh" as const,
              },
              source: { state: "running" as const, connections: profile.connections },
              retainedResources: [reference],
            };
          },
        },
        snapshotRestore: {
          async prepare(input) {
            const { request } = input;

            if (request.resources || request.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "Modal restores keep the configured size and take no mounts",
              );

            if (!restoreSupport.networkPolicies.includes(request.networkPolicy))
              throw new AdapterError("UNSUPPORTED", 'Modal network policy must be "blocked"');
            await requireSnapshot(input.snapshot);

            return input;
          },
          async submit(input, ctx) {
            return submitCreate({ imageId: input.snapshot.nativeId, labels: {} }, ctx);
          },
          async observe(attempt) {
            if (attempt.resource) checkSnapshot(attempt.resource);

            return observeCreate(attempt);
          },
        },
        snapshotDelete: {
          async prepare(ref) {
            await requireSnapshot(ref);

            return ref;
          },
          async submit(ref, ctx) {
            try {
              return (await transport.deleteImage(ref.nativeId)) === "deleted"
                ? { deleted: true as const, reference: ref }
                : ctx.reject("NOT_FOUND", "Modal snapshot image is unavailable or expired");
            } catch {
              return ctx.unknown(
                "Modal snapshot deletion was not confirmed; inspect without replay",
              );
            }
          },
          async observe(attempt, ctx) {
            if (!attempt.resource)
              return ctx.unknown("Modal snapshot deletion identity is unavailable; do not replay");
            checkSnapshot(attempt.resource);
            await verify();

            return (await transport.imageExists(attempt.resource.nativeId))
              ? ctx.unknown("Modal snapshot image still exists; deletion was not confirmed")
              : { deleted: true as const, reference: attempt.resource };
          },
        },
        async snapshotInspect(ref) {
          await requireSnapshot(ref);

          // SAFETY: requireSnapshot checked the reference kind.
          return snapshotInfo(ref as ResourceReference & { kind: "snapshot" }, null);
        },
        processes: {
          supports: {
            sustainedOutput: true,
            binaryOutput: true,
            execCapture: "bytes",
            stdin: transport.stdinWrite ? "bytes" : undefined,
            signals: ["SIGTERM", "SIGKILL"],
          },
          async start(input, ctx) {
            if (!(await find(input.sandbox.id)))
              throw new AdapterError(
                "NOT_FOUND",
                "Modal sandbox was not found in the verified App",
              );

            return startModalProcess(transport, input, ctx);
          },
        },
        exec: {
          finiteStdin: "bytes",
          recovery: { version: 1, token: ExecToken },
          async prepare(input) {
            if (!(await find(input.sandbox.id)))
              throw new AdapterError(
                "NOT_FOUND",
                "Modal sandbox was not found in the verified App",
              );

            return input;
          },
          async submit(input, ctx) {
            const command =
              input.command.kind === "argv"
                ? input.command.argv
                : ["/bin/sh", "-c", input.command.script];

            const signal = AbortSignal.any([
              ctx.signal,
              AbortSignal.timeout((input.deadlineSeconds + 5) * 1000),
            ]);

            const token: z.infer<typeof ExecToken> = {
              maxBytes: input.maxOutputBytes,
              inputComplete: false,
            };

            try {
              await transport.start(
                {
                  sandboxId: input.sandbox.id,
                  execId: modalExecId(ctx.submissionId),
                  command,
                  cwd: input.cwd,
                  env: input.env,
                  timeoutSeconds: input.deadlineSeconds,
                },
                signal,
              );
            } catch {
              return ctx.pending(token);
            }

            try {
              await transport.stdin(
                input.sandbox.id,
                modalExecId(ctx.submissionId),
                input.stdin ?? new Uint8Array(),
                signal,
              );
              token.inputComplete = true;
            } catch {
              return ctx.pending(token);
            }

            try {
              return await transport.result(
                input.sandbox.id,
                modalExecId(ctx.submissionId),
                input.maxOutputBytes,
                signal,
              );
            } catch {
              return ctx.pending(token);
            }
          },
          async observe(attempt, ctx) {
            if (!attempt.sandbox || !(await find(attempt.sandbox.id)))
              return ctx.unknown("Modal command sandbox is unavailable in the verified App");

            try {
              const signal = AbortSignal.any([
                ctx.signal,
                AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now())),
              ]);

              const token = ExecToken.safeParse(attempt.token);

              if (!token.success)
                return ctx.unknown("Modal command output limit is unavailable; do not replay");

              const result = await transport.result(
                attempt.sandbox.id,
                modalExecId(attempt.submissionId),
                token.data.maxBytes,
                signal,
              );

              if (token.data.inputComplete === false)
                return ctx.unknown(
                  "Modal command input or EOF was not confirmed; do not report success or replay",
                );

              return result;
            } catch {
              return ctx.unknown("Modal command evidence is unavailable; do not replay");
            }
          },
        },
        files: {
          maxBytes: MAX_BYTES,
          async read(input) {
            if (!(await find(input.sandbox.id)))
              throw new AdapterError(
                "NOT_FOUND",
                "Modal sandbox was not found in the verified App",
              );
            const bytes = await transport.readBytes(input.sandbox.id, input.path, MAX_BYTES);

            if (bytes.length > MAX_BYTES)
              throw new AdapterError("CAPACITY", "Modal file exceeds the read bound");

            return bytes;
          },
          write: {
            recovery: { version: 1, token: WriteToken },
            async prepare(input) {
              if (!(await find(input.sandbox.id)))
                throw new AdapterError(
                  "NOT_FOUND",
                  "Modal sandbox was not found in the verified App",
                );

              if (input.bytes.length > MAX_BYTES)
                throw new AdapterError("CAPACITY", "Modal file exceeds the write bound");

              if (!input.overwrite && (await transport.fileExists(input.sandbox.id, input.path)))
                throw new AdapterError("CONFLICT", "Modal file already exists");

              return input;
            },
            async submit(input, ctx) {
              // POSIX noclobber opens the destination with O_EXCL. Stdin carries
              // raw bytes, so NUL and non-UTF-8 content are never transcoded.
              const script = modalWriteScript(input.overwrite);

              try {
                await transport.start(
                  {
                    sandboxId: input.sandbox.id,
                    execId: modalExecId(ctx.submissionId),
                    command: [
                      "/bin/sh",
                      "-c",
                      script,
                      "sandbar-write",
                      posix.dirname(input.path),
                      input.path,
                    ],
                    timeoutSeconds: 300,
                  },
                  ctx.signal,
                );
                await transport.stdin(
                  input.sandbox.id,
                  modalExecId(ctx.submissionId),
                  input.bytes,
                  ctx.signal,
                );
              } catch {
                return ctx.pending({ expectedBytes: input.bytes.length });
              }

              try {
                const result = await transport.result(
                  input.sandbox.id,
                  modalExecId(ctx.submissionId),
                  64,
                  ctx.signal,
                );

                if (
                  result.exitCode === 0 &&
                  !result.truncated &&
                  writeCount(result.stdout) === input.bytes.length
                )
                  return { bytesWritten: input.bytes.length };

                return ctx.unknown(
                  "Modal file write failed after submission; inspect destination before retry",
                );
              } catch {
                return ctx.pending({ expectedBytes: input.bytes.length });
              }
            },
            async observe(attempt, ctx) {
              if (!attempt.sandbox || !(await find(attempt.sandbox.id)))
                return ctx.unknown("Modal write sandbox is unavailable in the verified App");

              const token = WriteToken.safeParse(attempt.token);

              if (!token.success)
                return ctx.unknown("Modal write length is unavailable; do not replay");

              try {
                const signal = AbortSignal.any([
                  ctx.signal,
                  AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now())),
                ]);

                const result = await transport.result(
                  attempt.sandbox.id,
                  modalExecId(attempt.submissionId),
                  64,
                  signal,
                );

                const count = writeCount(result.stdout);

                if (
                  result.exitCode === 0 &&
                  !result.truncated &&
                  count === token.data.expectedBytes
                )
                  return { bytesWritten: count };

                return ctx.unknown("Modal write completion cannot be certified; do not replay");
              } catch {
                return ctx.unknown("Modal write evidence is unavailable; do not replay");
              }
            },
          },
        },
      };
    },
  });
}

export const modalAdapter = createModalAdapter();
