import { z } from "zod";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { AdapterError, defineAdapter } from "sandbar-adapter";
import { createSdkTransport, MODAL_ENDPOINT, type ModalTransport } from "./transport";

const MAX_BYTES = 1_048_576;

const Configuration = z.strictObject({
  appName: z.string().min(1).max(128),
  environment: z.string().min(1).max(128),
  region: z.string().min(1).max(128).optional(),
  timeoutSeconds: z.coerce.number().int().min(60).max(3600).default(300),
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

const ExecToken = z.strictObject({ maxBytes: z.number().int().min(0).max(MAX_BYTES) });

const WriteToken = z.strictObject({ expectedBytes: z.number().int().min(0).max(MAX_BYTES) });

const DestroyToken = z.strictObject({ id: z.string().min(1).max(128) });

function writeCount(bytes: Uint8Array): number | undefined {
  const receipt = new TextDecoder().decode(bytes).trim();

  if (!/^\d+$/.test(receipt)) return undefined;
  const count = Number(receipt);

  return Number.isSafeInteger(count) ? count : undefined;
}

type RecordValue = z.output<typeof RecordSchema>;

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

      const find = async (id: string): Promise<RecordValue | null> => {
        await verify();

        for await (const value of transport.list(appId)) {
          const record = RecordSchema.parse(value);

          if (record.id === id) return record;
        }

        return null;
      };

      return {
        scope: {
          authority: { kind: "app", id: appId },
          partition: {
            endpoint: MODAL_ENDPOINT,
            environment: config.environment,
            region: config.region ?? "",
          },
        },
        supports: {
          images: ["prepared", "oci"],
          network: ["blocked"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
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
            };
          },
          async submit(input, ctx) {
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

              if (input.ociReference) request.ociReference = input.ociReference;

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
            } catch {
              return ctx.unknown("Modal create response unavailable; observe without replay");
            }
          },
          async observe(attempt) {
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
          },
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
            ? { id: record.id, state: record.running ? ("running" as const) : ("unknown" as const) }
            : null;
        },
        async inventory(input) {
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
        },
        exec: {
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
              return ctx.pending({ maxBytes: input.maxOutputBytes });
            }

            try {
              return await transport.result(
                input.sandbox.id,
                modalExecId(ctx.submissionId),
                input.maxOutputBytes,
                signal,
              );
            } catch {
              return ctx.pending({ maxBytes: input.maxOutputBytes });
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

              return await transport.result(
                attempt.sandbox.id,
                modalExecId(attempt.submissionId),
                token.data.maxBytes,
                signal,
              );
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
