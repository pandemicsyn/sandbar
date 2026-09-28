import { z } from "zod";
import {
  AdapterError,
  defineAdapter,
  type AttemptContext,
  type ObserveContext,
} from "sandbar-adapter";
import type { DriverResult } from "@sandbar/provider-spi";
import { daytonaProvider, daytonaRegistration, type DaytonaEndpointPair } from "./index";

const Configuration = z.strictObject({
  apiUrl: z.url().default("https://app.daytona.io/api"),
  toolboxOrigin: z.url().default("https://proxy.app.daytona.io"),
  target: z.string().min(1),
  ttlMinutes: z.coerce.number().int().min(1).max(1440).default(60),
});

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const Token = z.strictObject({ submissionId: z.string().min(1).max(128) });

const ExecToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576),
});

const WriteToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

const DestroyToken = z.strictObject({ sandboxId: z.string().min(1).max(512) });

const errorCodes = {
  invalid: "INVALID_ARGUMENT",
  unsupported: "UNSUPPORTED",
  unauthorized: "UNAUTHENTICATED",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
  capacity: "CAPACITY",
  rate_limit: "RATE_LIMIT",
  unavailable: "UNAVAILABLE",
  timeout: "TIMEOUT",
  internal: "INTERNAL",
} as const;

function failure(result: Exclude<DriverResult, { status: "completed" }>, ctx: AttemptContext) {
  if (result.status === "rejected")
    return ctx.reject(errorCodes[result.error.code], result.error.message);

  return ctx.unknown(
    result.status === "unknown" ? result.reason : "Daytona result remains uncertain",
  );
}

function createResult(result: DriverResult, ctx: AttemptContext) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Daytona returned another result kind");

    return {
      id: result.value.observation.ref.nativeId,
      state:
        result.value.observation.state === "running" ? ("running" as const) : ("unknown" as const),
    };
  }

  if (result.status === "pending")
    return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });

  return failure(result, ctx);
}

function observedCreate(result: DriverResult, ctx: ObserveContext, submissionId: string) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Daytona returned another result kind");

    return {
      id: result.value.observation.ref.nativeId,
      state:
        result.value.observation.state === "running" ? ("running" as const) : ("unknown" as const),
    };
  }

  if (result.status === "pending")
    return ctx.pending({ submissionId }, { pollAfterMs: result.observeAfterMs });

  return ctx.unknown(
    result.status === "unknown" ? result.reason : "Daytona discovery has no confirmed completion",
  );
}

function bytes(base64?: string) {
  return Uint8Array.from(Buffer.from(base64 ?? "", "base64"));
}

function executionValue(result: DriverResult) {
  if (result.status !== "completed" || result.value.kind !== "execution") return null;

  if (!result.value.observation.completed) return null;
  const output = result.value.observation;

  return {
    exitCode: output.exitCode ?? null,
    stdout: bytes(output.stdoutBase64),
    stderr: bytes(output.stderrBase64),
    truncated: output.truncated ?? false,
  };
}

function fileWriteValue(result: DriverResult) {
  if (result.status !== "completed" || result.value.kind !== "file_write") return null;

  if (!result.value.observation.complete) return null;

  return { bytesWritten: result.value.observation.bytesWritten };
}

function destroyValue(result: DriverResult) {
  if (result.status !== "completed" || result.value.kind !== "destroy") return null;

  if (!result.value.observation.computeStopped) return null;

  return {
    computeStopped: true,
    retainedResources: result.value.observation.retainedResources,
  };
}

/** Daytona's public adapter uses the pinned single-attempt native HTTP boundary. */
export function createDaytonaAdapter(
  fetchImpl?: typeof fetch,
  trustedEndpoints: DaytonaEndpointPair[] = [],
) {
  const configSchema = Configuration.superRefine((value, ctx) => {
    try {
      daytonaRegistration(fetchImpl, trustedEndpoints).validate({
        credentials: { apiKey: "validation-only" },
        configuration: {
          apiUrl: value.apiUrl,
          toolboxOrigin: value.toolboxOrigin,
          target: value.target,
          ttlMinutes: String(value.ttlMinutes),
        },
      });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["apiUrl"],
        message: "Daytona endpoint pair is not trusted by this host",
      });
    }
  });

  return defineAdapter({
    name: "daytona",
    displayName: "Daytona",
    config: configSchema,
    credentials: Credentials,
    async connect({ config, credentials }) {
      const { driver, scope } = await daytonaProvider({
        apiKey: credentials.apiKey,
        apiUrl: config.apiUrl,
        toolboxOrigin: config.toolboxOrigin,
        target: config.target,
        ttlMinutes: config.ttlMinutes,
        fetch: fetchImpl,
        trustedEndpoints,
      });

      const native = (id: string) => ({ kind: "sandbox" as const, scope, nativeId: id });

      const identity = (ctx: AttemptContext) => ({
        projectId: "adapter",
        operationId: ctx.operationId,
        submissionId: ctx.submissionId,
        invocationKey: ctx.invocationKey,
      });

      const caps = await driver.capabilities(scope);

      return {
        scope: {
          authority: { kind: "organization", id: scope.accountId! },
          partition: {
            region: config.target,
            endpoint: config.apiUrl,
            toolboxOrigin: config.toolboxOrigin,
          },
        },
        supports: {
          images: ["prepared", "oci"],
          network: caps.networkPolicies,
          exec: { commands: ["argv", "shell"], maxOutputBytes: caps.maxOutputBytes },
          fileWrite: { overwrite: true, noClobber: true },
        },
        imageBuild: {
          async prepare(input) {
            if (!driver.prepareImage(input.source.value))
              throw new AdapterError("UNSUPPORTED", "OCI image needs a fixed tag or digest");

            return input;
          },
          async submit(input, ctx) {
            const result = await driver.buildImage({
              submissionId: ctx.submissionId,
              image: input.source.value,
              signal: ctx.signal,
            });

            return result.status === "completed" ? result.value : ctx.unknown(result.reason);
          },
          async observe(attempt, ctx) {
            const result = await driver.observeImageBuild(attempt.submissionId);

            if (!result) return null;

            return result.status === "completed" ? result.value : ctx.unknown(result.reason);
          },
        },
        create: {
          recovery: { version: 1, token: Token },
          async prepare(input) {
            const result = await driver.prepare({
              scope,
              image: input.image,
              networkPolicy: input.networkPolicy,
              region: input.region,
            });

            if (!result.supported || !result.effectiveImage)
              throw new AdapterError(
                "UNSUPPORTED",
                result.reason ?? "Daytona image is unsupported",
              );

            return {
              image: result.effectiveImage,
              imageKind: input.image.kind,
              networkPolicy: input.networkPolicy,
              labels: input.labels,
            };
          },
          async submit(input, ctx) {
            return createResult(
              await driver.create({
                scope,
                identity: identity(ctx),
                image: input.image,
                imageKind: input.imageKind,
                networkPolicy: input.networkPolicy,
                labels: input.labels,
                signal: ctx.signal,
              }),
              ctx,
            );
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            return result ? observedCreate(result, ctx, attempt.submissionId) : null;
          },
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async submit(box, ctx) {
            const result = await driver.destroy({
              sandbox: native(box.id),
              identity: identity(ctx),
              signal: ctx.signal,
            });

            const value = destroyValue(result);

            return value ?? ctx.pending({ sandboxId: box.id }, { pollAfterMs: 500 });
          },
          async observe(attempt, ctx) {
            const token = attempt.token ? DestroyToken.safeParse(attempt.token) : null;

            if (
              !attempt.sandbox ||
              (token && (!token.success || token.data.sandboxId !== attempt.sandbox.id))
            )
              return null;

            const result = await driver.observeDestroy(
              native(attempt.sandbox.id),
              attempt.submissionId,
            );

            if (!result) return null;

            return destroyValue(result) ?? ctx.unknown("Daytona deletion is unconfirmed");
          },
        },
        async inspect(box) {
          const result = await driver.inspect(native(box.id));

          return result ? { id: result.ref.nativeId, state: result.state } : null;
        },
        async inventory(input) {
          const page = await driver.inventory({ scope, cursor: input.cursor, limit: input.limit });

          return {
            items: page.items.map((item) => ({ id: item.ref.nativeId, state: item.state })),
            nextCursor: page.nextCursor,
          };
        },
        exec: {
          recovery: { version: 1, token: ExecToken },
          async submit(input, ctx) {
            const result = await driver.exec({
              sandbox: native(input.sandbox.id),
              identity: identity(ctx),
              command: input.command,
              cwd: input.cwd,
              env: input.env,
              deadlineSeconds: input.deadlineSeconds,
              maxOutputBytes: input.maxOutputBytes,
              signal: ctx.signal,
            });

            const value = executionValue(result);

            if (value) return value;

            if (result.status === "rejected") return failure(result, ctx);

            return ctx.pending(
              { submissionId: ctx.submissionId, maxOutputBytes: input.maxOutputBytes },
              { pollAfterMs: 500 },
            );
          },
          async observe(attempt, ctx) {
            const token = attempt.token ? ExecToken.safeParse(attempt.token) : null;

            if (
              !attempt.sandbox ||
              (token && (!token.success || token.data.submissionId !== attempt.submissionId))
            )
              return null;

            const result = await driver.observeExec({
              sandbox: native(attempt.sandbox.id),
              submissionId: attempt.submissionId,
              maxOutputBytes: token?.success ? token.data.maxOutputBytes : undefined,
            });

            if (!result) return null;
            const value = executionValue(result);

            return value ?? ctx.unknown("Daytona execution receipt is incomplete");
          },
        },
        files: {
          maxBytes: caps.maxFileBytes,
          async read(input) {
            return driver.readFile({ sandbox: native(input.sandbox.id), path: input.path });
          },
          write: {
            recovery: { version: 1, token: WriteToken },
            async submit(input, ctx) {
              const result = await driver.writeFile({
                sandbox: native(input.sandbox.id),
                identity: identity(ctx),
                path: input.path,
                bytes: input.bytes,
                overwrite: input.overwrite,
                signal: ctx.signal,
              });

              const value = fileWriteValue(result);

              if (value) return value;

              if (result.status === "rejected") return failure(result, ctx);

              const digest = Buffer.from(
                await crypto.subtle.digest("SHA-256", new Uint8Array(input.bytes)),
              ).toString("hex");

              return ctx.pending({ submissionId: ctx.submissionId, digest }, { pollAfterMs: 500 });
            },
            async observe(attempt, ctx) {
              const token = attempt.token ? WriteToken.safeParse(attempt.token) : null;

              if (
                !attempt.sandbox ||
                (token && (!token.success || token.data.submissionId !== attempt.submissionId))
              )
                return null;

              const result = await driver.observeWrite({
                sandbox: native(attempt.sandbox.id),
                submissionId: attempt.submissionId,
                digest: token?.success ? token.data.digest : undefined,
              });

              if (!result) return null;
              const value = fileWriteValue(result);

              return value ?? ctx.unknown("Daytona write receipt is incomplete");
            },
          },
        },
      };
    },
  });
}

export const daytonaAdapter = createDaytonaAdapter();
