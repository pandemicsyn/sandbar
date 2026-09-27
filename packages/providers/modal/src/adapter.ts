import { z } from "zod";
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

type RecordValue = z.output<typeof RecordSchema>;

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
        supports: { images: ["prepared"], network: ["blocked"] },
        create: {
          async prepare(input) {
            if (input.image.kind !== "prepared" || !/^im-[A-Za-z0-9_-]+$/.test(input.image.value))
              throw new AdapterError("UNSUPPORTED", "Use an existing Modal image ID");

            if (input.region && input.region !== config.region)
              throw new AdapterError(
                "UNSUPPORTED",
                "Modal region differs from the verified connection",
              );

            if (input.labels && Object.keys(input.labels).some((key) => key.startsWith("sandbar_")))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved Modal tag prefix");
            await verify();

            if (!(await transport.imageExists(input.image.value)))
              throw new AdapterError("NOT_FOUND", "Modal image is unavailable");

            return { imageId: input.image.value, labels: input.labels ?? {} };
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
        async destroy(box, ctx) {
          const record = await find(box.id);

          if (!record)
            return ctx.reject("NOT_FOUND", "Modal sandbox was not found in the verified App");

          try {
            const stopped = await transport.terminate(record.id);

            return stopped
              ? { computeStopped: true, retainedResources: [] }
              : ctx.unknown("Modal termination was not confirmed");
          } catch {
            return ctx.unknown("Modal termination response unavailable; do not replay");
          }
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
        },
      };
    },
  });
}

export const modalAdapter = createModalAdapter();
