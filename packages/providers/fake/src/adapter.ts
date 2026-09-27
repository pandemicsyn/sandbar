import { z } from "zod";
import { AdapterError, defineAdapter, type AttemptContext, type ObserveContext } from "@sandbar/adapter";
import type { DriverResult } from "@sandbar/provider-spi";
import { fakeProvider } from "./client";

const Empty = z.strictObject({});
const Token = z.strictObject({ submissionId: z.string().min(1).max(128) });
const errorCodes = {
  invalid: "INVALID_ARGUMENT", unsupported: "UNSUPPORTED", unauthorized: "UNAUTHENTICATED",
  not_found: "NOT_FOUND", conflict: "CONFLICT", capacity: "CAPACITY",
  rate_limit: "RATE_LIMIT", unavailable: "UNAVAILABLE", timeout: "TIMEOUT", internal: "INTERNAL",
} as const;
function failure(result: Exclude<DriverResult, { status: "completed" }>, ctx: AttemptContext) {
  if (result.status === "rejected") return ctx.reject(errorCodes[result.error.code], result.error.message);
  return ctx.unknown(result.status === "unknown" ? result.reason : "Fake result is uncertain");
}
function createResult(result: DriverResult, ctx: AttemptContext) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Fake returned another result kind");
    return { id: result.value.observation.ref.nativeId,
      state: result.value.observation.state === "running" ? "running" as const : "unknown" as const };
  }
  if (result.status === "pending")
    return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });
  return failure(result, ctx);
}
function observedCreate(result: DriverResult, ctx: ObserveContext, submissionId: string) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Fake returned another result kind");
    return { id: result.value.observation.ref.nativeId,
      state: result.value.observation.state === "running" ? "running" as const : "unknown" as const };
  }
  if (result.status === "pending")
    return ctx.pending({ submissionId }, { pollAfterMs: result.observeAfterMs });
  return ctx.unknown("Fake observation did not confirm completion");
}
function bytes(base64?: string) {
  return Uint8Array.from(Buffer.from(base64 ?? "", "base64"));
}

/** A deterministic loopback adapter for SDK and service qualification. */
export function createFakeAdapter(options: { url: string; token: string; fetch?: typeof fetch }) {
  return defineAdapter({
    name: "fake",
    displayName: "Fake test provider",
    config: Empty,
    credentials: Empty,
    async connect() {
      const { driver, scope } = await fakeProvider(options);
      const native = (id: string) => ({ kind: "sandbox" as const, scope, nativeId: id });
      const identity = (ctx: AttemptContext) => ({
        projectId: "adapter", operationId: ctx.operationId,
        submissionId: ctx.submissionId, invocationKey: ctx.invocationKey,
      });
      const caps = await driver.capabilities(scope);
      return {
        scope: {
          authority: { kind: "fixture", id: "fake-local" },
          partition: { endpoint: new URL(options.url).origin, region: "local" },
        },
        supports: {
          images: ["prepared"], network: caps.networkPolicies,
          exec: { commands: ["argv", "shell"], maxOutputBytes: caps.maxOutputBytes },
          fileWrite: { overwrite: true },
        },
        create: {
          recovery: { version: 1, token: Token },
          async prepare(input) {
            const result = await driver.prepare({ scope, image: input.image,
              networkPolicy: input.networkPolicy, region: input.region });
            if (!result.supported || !result.effectiveImage)
              throw new AdapterError("UNSUPPORTED", result.reason ?? "Fake image is unsupported");
            return { image: result.effectiveImage, networkPolicy: input.networkPolicy, labels: input.labels };
          },
          async submit(input, ctx) {
            return createResult(await driver.create({ scope, identity: identity(ctx),
              image: input.image, networkPolicy: input.networkPolicy, labels: input.labels }), ctx);
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({ scope, submissionId: attempt.submissionId,
              operationId: attempt.operationId });
            return result ? observedCreate(result, ctx, attempt.submissionId) : null;
          },
        },
        destroy: {
          async submit(box, ctx) {
            const result = await driver.destroy({ sandbox: native(box.id), identity: identity(ctx) });
            if (result.status === "completed") {
              if (result.value.kind !== "destroy" || !result.value.observation.computeStopped)
                return ctx.unknown("Fake destroy did not confirm compute stop");
              return { computeStopped: true, retainedResources: result.value.observation.retainedResources };
            }
            return failure(result, ctx);
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({ scope, submissionId: attempt.submissionId,
              operationId: attempt.operationId });
            if (!result) return null;
            if (result.status === "completed" && result.value.kind === "destroy" &&
                result.value.observation.computeStopped &&
                result.value.observation.sandbox.nativeId === attempt.sandbox?.id)
              return { computeStopped: true, retainedResources: result.value.observation.retainedResources };
            return ctx.unknown("Fake destroy observation was not confirmed");
          },
        },
        async inspect(box) {
          const result = await driver.inspect(native(box.id));
          return result ? { id: result.ref.nativeId, state: result.state } : null;
        },
        async inventory(input) {
          const page = await driver.inventory({ scope, cursor: input.cursor, limit: input.limit });
          return { items: page.items.map((item) => ({ id: item.ref.nativeId, state: item.state })),
            nextCursor: page.nextCursor };
        },
        exec: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            const result = await driver.exec({ sandbox: native(input.sandbox.id),
              identity: identity(ctx), command: input.command, cwd: input.cwd, env: input.env,
              deadlineSeconds: input.deadlineSeconds, maxOutputBytes: input.maxOutputBytes });
            if (result.status === "completed") {
              if (result.value.kind !== "execution" || !result.value.observation.completed)
                return ctx.unknown("Fake execution did not complete");
              const output = result.value.observation;
              return { exitCode: output.exitCode ?? null, stdout: bytes(output.stdoutBase64),
                stderr: bytes(output.stderrBase64), truncated: output.truncated ?? false };
            }
            if (result.status === "pending")
              return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });
            return failure(result, ctx);
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({ scope, submissionId: attempt.submissionId,
              operationId: attempt.operationId });
            if (!result) return null;
            if (result.status === "completed" && result.value.kind === "execution" &&
                result.value.observation.completed &&
                result.value.observation.sandbox.nativeId === attempt.sandbox?.id) {
              const output = result.value.observation;
              return { exitCode: output.exitCode ?? null, stdout: bytes(output.stdoutBase64),
                stderr: bytes(output.stderrBase64), truncated: output.truncated ?? false };
            }
            if (result.status === "pending")
              return ctx.pending({ submissionId: attempt.submissionId }, { pollAfterMs: result.observeAfterMs });
            return ctx.unknown("Fake execution observation was not confirmed");
          },
        },
        files: {
          maxBytes: caps.maxFileBytes,
          async read(input) { return driver.readFile({ sandbox: native(input.sandbox.id), path: input.path }); },
          write: {
            recovery: { version: 1, token: Token },
            async submit(input, ctx) {
              const result = await driver.writeFile({ sandbox: native(input.sandbox.id),
                identity: identity(ctx), path: input.path, bytes: input.bytes, overwrite: input.overwrite });
              if (result.status === "completed") {
                if (result.value.kind !== "file_write" || !result.value.observation.complete)
                  return ctx.unknown("Fake file write was not confirmed");
                return { bytesWritten: result.value.observation.bytesWritten };
              }
              if (result.status === "pending")
                return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });
              return failure(result, ctx);
            },
            async observe(attempt, ctx) {
              const result = await driver.observe({ scope, submissionId: attempt.submissionId,
                operationId: attempt.operationId });
              if (!result) return null;
              if (result.status === "completed" && result.value.kind === "file_write" &&
                  result.value.observation.complete &&
                  result.value.observation.sandbox.nativeId === attempt.sandbox?.id)
                return { bytesWritten: result.value.observation.bytesWritten };
              if (result.status === "pending")
                return ctx.pending({ submissionId: attempt.submissionId }, { pollAfterMs: result.observeAfterMs });
              return ctx.unknown("Fake file-write observation was not confirmed");
            },
          },
        },
      };
    },
  });
}
