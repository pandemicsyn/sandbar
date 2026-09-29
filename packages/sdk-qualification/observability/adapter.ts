import {
  defineAdapter,
  type CreateInput,
  type AttemptContext,
  type ObserveContext,
  type FileWriteInput,
  type RecoveryAttempt,
} from "sandbar-adapter";
import { z } from "zod";

/** Independent deterministic adapter, no provider IO or telemetry dependency. */
export function fixtureAdapter(
  options: {
    lost?: boolean;
    pending?: boolean;
    completeAfterPolls?: number;
    observeFailure?: "unknown" | "throw";
    exitCode?: number;
    delay?: Promise<void>;
    read?: () => Promise<Uint8Array>;
  } = {},
) {
  const counts = { create: 0, exec: 0, read: 0, write: 0, destroy: 0, observe: 0, close: 0 };

  const adapter = defineAdapter({
    name: "qualification",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        counts.close++;
      });

      return {
        scope: { authority: { kind: "fixture", id: "CANARY_NATIVE_SCOPE" }, partition: {} },
        supports: {
          images: ["prepared" as const],
          network: ["blocked" as const],
          fileWrite: { noClobber: true, overwrite: true },
          exec: { commands: ["argv" as const], maxOutputBytes: 1024 },
        },
        create: {
          recovery: { version: 1, token: z.strictObject({ secret: z.string() }) },
          async submit(_input: CreateInput, ctx: AttemptContext) {
            counts.create++;
            await options.delay;

            if (options.lost) throw new Error("CANARY_CAUSE_CREDENTIAL_URL");

            if (options.pending)
              return ctx.pending({ secret: "CANARY_TOKEN" }, { pollAfterMs: 50 });

            return { id: "CANARY_NATIVE_ID", state: "running" as const };
          },
          async observe(_attempt: RecoveryAttempt, ctx: ObserveContext) {
            counts.observe++;

            if (options.completeAfterPolls && counts.observe >= options.completeAfterPolls)
              return { id: "CANARY_NATIVE_ID", state: "running" as const };

            if (options.observeFailure === "unknown") return ctx.unknown("CANARY_UNKNOWN");

            if (options.observeFailure === "throw") throw new Error("CANARY_PROVIDER_FAILURE");

            return ctx.pending({ secret: "CANARY_TOKEN" }, { pollAfterMs: 50 });
          },
        },
        async destroy() {
          counts.destroy++;

          return { computeStopped: true as const, retainedResources: [] };
        },
        async exec() {
          counts.exec++;

          return {
            exitCode: options.exitCode ?? 7,
            stdout: new TextEncoder().encode("CANARY_OUTPUT"),
            stderr: new Uint8Array(),
            truncated: false,
          };
        },
        files: {
          maxBytes: 1024,
          async read() {
            counts.read++;

            return options.read ? options.read() : new TextEncoder().encode("CANARY_FILE_CONTENT");
          },
          async write(input: FileWriteInput) {
            counts.write++;

            return { bytesWritten: input.bytes.length };
          },
        },
      };
    },
  });

  return { adapter, counts };
}
