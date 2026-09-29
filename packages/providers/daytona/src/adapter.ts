import { z } from "zod";
import { daytonaState } from "./state-native";
import { MountDurability as importMountDurability, type ResourceReference } from "sandbar-adapter";
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
  networkPolicy: z.enum(["blocked", "daytona-default"]).default("blocked"),
  snapshots: z
    .strictObject({ restartAfterCapture: z.boolean().default(true) })
    .default({ restartAfterCapture: true }),
  ttlMinutes: z.coerce.number().int().min(1).max(1440).default(60),
});

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const Token = z.strictObject({ submissionId: z.string().min(1).max(128) });

const ImageToken = Token.extend({
  image: z.string().min(1).max(512),
  discoveryDeadline: z.number().int().nonnegative().optional(),
  snapshotId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
});

const ExecToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576),
  receiptDeadline: z.number().int().nonnegative().optional(),
});

const WriteToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

const DestroyToken = z.strictObject({
  sandboxId: z.string().min(1).max(512),
  deletionAccepted: z.boolean().optional(),
  retainedResources: z.array(z.string().min(1).max(512)).max(128).optional(),
  mountDurability: z.array(importMountDurability).max(32).optional(),
});

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
          networkPolicy: value.networkPolicy,
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
        networkPolicy: config.networkPolicy,
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

      const partition = {
        region: config.target,
        endpoint: config.apiUrl,
        toolboxOrigin: config.toolboxOrigin,
      };

      if (config.networkPolicy === "daytona-default")
        Object.assign(partition, { networkPolicy: config.networkPolicy });

      const resourceState = daytonaState({
        scope: { authority: { kind: "organization", id: scope.accountId! }, partition },
        apiUrl: config.apiUrl,
        apiKey: credentials.apiKey,
        target: config.target,
        restartAfterCapture: config.snapshots.restartAfterCapture,
        fetch: fetchImpl ?? fetch,
      });

      const createMutation = {
        recovery: { version: 1, token: Token },
        async prepare(
          input: import("sandbar-adapter").SnapshotRestoreInput,
          ctx: import("sandbar-adapter").ReadContext,
        ) {
          const info = await resourceState.inspectSnapshot(input.snapshot, ctx);

          if (
            info.mountHandling !== "none" ||
            info.state !== "ready" ||
            info.preserve !== "filesystem" ||
            input.request.resources ||
            Object.keys(input.request.mounts ?? {}).length
          )
            throw new AdapterError(
              "UNSUPPORTED",
              "Only mount-free container cold restore is mapped",
            );

          const plan = await driver.prepare({
            scope,
            image: { kind: "prepared", value: input.snapshot.nativeId },
            networkPolicy: input.request.networkPolicy,
          });

          if (!plan.supported || !plan.effectiveImage)
            throw new AdapterError("UNSUPPORTED", plan.reason ?? "Restore unsupported");

          return input;
        },
        async submit(input: import("sandbar-adapter").SnapshotRestoreInput, ctx: AttemptContext) {
          const info = await resourceState.inspectSnapshot(input.snapshot, {
            signal: ctx.signal,
            deadline: Date.now() + 30000,
          });

          if (
            info.state !== "ready" ||
            info.mountHandling !== "none" ||
            info.preserve !== "filesystem"
          )
            return ctx.reject("UNAVAILABLE", "Snapshot provenance changed before restore");

          if (ctx.signal.aborted)
            return ctx.reject("UNAVAILABLE", "Restore cancelled before dispatch");

          return createResult(
            await driver.create({
              scope,
              identity: identity(ctx),
              image: input.snapshot.nativeId,
              imageKind: "prepared",
              networkPolicy: input.request.networkPolicy,
              signal: ctx.signal,
            }),
            ctx,
          );
        },
        async observe(attempt: import("sandbar-adapter").RecoveryAttempt, ctx: ObserveContext) {
          const value = await driver.observe({
            scope,
            submissionId: attempt.submissionId,
            operationId: attempt.operationId,
          });

          return value ? observedCreate(value, ctx, attempt.submissionId) : null;
        },
      };

      return {
        ...resourceState.fields,
        snapshotRestore: createMutation,
        async snapshotInspect(ref: ResourceReference, ctx: import("sandbar-adapter").ReadContext) {
          const info = await resourceState.inspectSnapshot(ref, ctx);
          info.restore.networkPolicies = [...caps.networkPolicies];

          return info;
        },
        async resourceCapabilities() {
          const fields = await resourceState.fields.resourceCapabilities!(
            {},
            { signal: new AbortController().signal, deadline: Date.now() + 30000 },
          );

          return {
            ...fields,
            restore: {
              status: "supported" as const,
              value: {
                networkPolicies: [...caps.networkPolicies],
                resources: false,
                mounts: false,
                independentLifecycle: true,
              },
            },
          };
        },
        scope: {
          authority: { kind: "organization", id: scope.accountId! },
          partition,
        },
        supports: {
          images: ["prepared", "oci"],
          network: caps.networkPolicies,
          exec: { commands: ["argv", "shell"], maxOutputBytes: caps.maxOutputBytes },
          fileWrite: { overwrite: true, noClobber: true },
        },
        imageBuild: {
          recovery: { version: 1, token: ImageToken },
          async prepare(input) {
            if (!driver.prepareImage(input.source.value))
              throw new AdapterError("UNSUPPORTED", "OCI image needs a fixed tag or digest");

            return input;
          },
          async submit(input, ctx) {
            let discoveryDeadline: number | undefined;

            const result = await driver.buildImage({
              submissionId: ctx.submissionId,
              image: input.source.value,
              signal: ctx.signal,
              onSubmit: () => {
                discoveryDeadline = Date.now() + 600_000;
              },
            });

            if (result.status === "rejected") return ctx.reject("UNAVAILABLE", result.reason);

            if (result.status !== "completed") {
              const token: z.infer<typeof ImageToken> = {
                submissionId: ctx.submissionId,
                image: input.source.value,
              };

              if (result.snapshotId) token.snapshotId = result.snapshotId;

              if (discoveryDeadline !== undefined) token.discoveryDeadline = discoveryDeadline;

              return ctx.pending(token, { pollAfterMs: 500 });
            }

            return result.value;
          },
          async observe(attempt, ctx) {
            const token = ImageToken.safeParse(attempt.token);

            if (!token.success || token.data.submissionId !== attempt.submissionId) {
              let candidate: string | null = null;

              try {
                candidate = await driver.imageBuildCandidate(attempt.submissionId);
              } catch {
                // Unreadable evidence cannot certify build completion.
              }

              return ctx.unknown(
                candidate
                  ? `Daytona image build source evidence is unavailable; possible retained resource daytona:snapshot:${candidate}, ownership unknown, manual cleanup`
                  : "Daytona image build source evidence is unavailable; a retained snapshot may exist under the submission name",
              );
            }

            let result: Awaited<ReturnType<typeof driver.observeImageBuild>>;

            try {
              result = await driver.observeImageBuild(
                attempt.submissionId,
                token.data.image,
                token.data.snapshotId,
              );
            } catch {
              result = null;
            }

            if (!result)
              return token.data.discoveryDeadline !== undefined &&
                Date.now() < token.data.discoveryDeadline
                ? ctx.pending(token.data, { pollAfterMs: 500 })
                : ctx.unknown("Daytona image build discovery window unavailable or ended");

            if (result.status === "pending")
              return ctx.pending(
                { ...token.data, snapshotId: result.snapshotId },
                { pollAfterMs: 500 },
              );

            return result.status === "completed" ? result.value : ctx.unknown(result.reason);
          },
        },
        create: {
          recovery: { version: 1, token: Token },
          async prepare(input) {
            if ("sandbar.imageSnapshot" in (input.labels ?? {}))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved Daytona snapshot label");

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
              mounts: input.mounts,
            };
          },
          async submit(input, ctx) {
            const result = createResult(
              await driver.create({
                scope,
                identity: identity(ctx),
                image: input.image,
                imageKind: input.imageKind,
                networkPolicy: input.networkPolicy,
                labels: input.labels,
                mounts: input.mounts,
                signal: ctx.signal,
              }),
              ctx,
            );

            if (!("id" in result) || !input.mounts?.length) return result;

            const detail = await resourceState.box(result.id, {
              signal: ctx.signal,
              deadline: Date.now() + 30000,
            });

            if (
              detail.state !== "started" ||
              input.mounts.some(
                (mount) =>
                  !detail.volumes.some(
                    (actual) =>
                      actual.volumeId === mount.volume.nativeId &&
                      actual.mountPath === mount.path &&
                      actual.subpath === mount.subpath,
                  ),
              )
            )
              return ctx.unknown("Create-time mounts are not ready");

            return { ...result, mounts: input.mounts };
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            const value = result ? observedCreate(result, ctx, attempt.submissionId) : null;

            if (!value || !("id" in value) || !attempt.mounts?.length) return value;
            const detail = await resourceState.box(value.id, ctx);

            if (
              detail.state !== "started" ||
              attempt.mounts.some(
                (mount) =>
                  !detail.volumes.some(
                    (actual) =>
                      actual.volumeId === mount.volume.nativeId &&
                      actual.mountPath === mount.path &&
                      actual.subpath === mount.subpath,
                  ),
              )
            )
              return ctx.unknown("Recovered create-time mounts are not ready");

            return { ...value, mounts: attempt.mounts };
          },
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(box, ctx) {
            let nativeBox;

            try {
              nativeBox = await resourceState.box(box.id, ctx);
            } catch {
              throw new AdapterError("UNAVAILABLE", "Daytona inspection failed before deletion");
            }

            if (nativeBox.volumes.length && box.storage !== "allow-unconfirmed")
              throw new AdapterError(
                "UNSUPPORTED",
                "Writable mount shutdown durability is unverified; select allow-unconfirmed for compute cleanup",
              );

            return box;
          },
          async submit(box, ctx) {
            const mounts = (
              await resourceState.box(box.id, { signal: ctx.signal, deadline: Date.now() + 30000 })
            ).volumes;

            if (mounts.length && box.storage !== "allow-unconfirmed")
              return ctx.reject(
                "UNSUPPORTED",
                "Writable mount cleanup requires explicit allow-unconfirmed",
              );
            let retainedResources: string[] | undefined;

            try {
              retainedResources = await driver.destroyRetainedResources(native(box.id));
            } catch {
              return ctx.reject("UNAVAILABLE", "Daytona inspection failed before deletion");
            }

            const result = await driver.destroy({
              sandbox: native(box.id),
              identity: identity(ctx),
              signal: ctx.signal,
              retainedResources,
            });

            const value = destroyValue(result);

            if (value)
              return {
                ...value,
                retainedResources: [
                  ...value.retainedResources,
                  ...mounts.map((mount) => `daytona-volume:${mount.volumeId}`),
                ],
                mountDurability: mounts.map((mount) => ({
                  volume: {
                    version: 1 as const,
                    kind: "volume" as const,
                    provider: "daytona",
                    scope: { authority: { kind: "organization", id: scope.accountId! }, partition },
                    nativeId: mount.volumeId,
                    ownership: "unknown" as const,
                  },
                  path: mount.mountPath,
                  status: "unconfirmed" as const,
                })),
              };

            const token: z.infer<typeof DestroyToken> = {
              sandboxId: box.id,
              mountDurability: mounts.map((mount) => ({
                volume: {
                  version: 1,
                  kind: "volume",
                  provider: "daytona",
                  scope: { authority: { kind: "organization", id: scope.accountId! }, partition },
                  nativeId: mount.volumeId,
                  ownership: "unknown",
                },
                path: mount.mountPath,
                status: "unconfirmed",
              })),
            };

            if (retainedResources !== undefined) token.retainedResources = retainedResources;

            if (result.deletionAccepted) token.deletionAccepted = true;

            return ctx.pending(token, { pollAfterMs: 500 });
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
              token?.success ? token.data.retainedResources : undefined,
              token?.success ? token.data.deletionAccepted : false,
            );

            if (!result) return null;

            if (result.status === "pending") {
              const recovery: z.infer<typeof DestroyToken> = {
                sandboxId: attempt.sandbox.id,
                mountDurability: token?.success ? token.data.mountDurability : undefined,
              };

              if (token?.success && token.data.retainedResources)
                recovery.retainedResources = token.data.retainedResources;

              if (token?.success && token.data.deletionAccepted) recovery.deletionAccepted = true;

              return ctx.pending(recovery, { pollAfterMs: result.observeAfterMs });
            }

            const completed = destroyValue(result);

            if (completed)
              return {
                ...completed,
                mountDurability: token?.success ? token.data.mountDurability : undefined,
                retainedResources: [
                  ...completed.retainedResources,
                  ...(token?.success
                    ? (token.data.mountDurability?.map(
                        (mount) => `daytona-volume:${mount.volume.nativeId}`,
                      ) ?? [])
                    : []),
                ],
              };

            return (
              completed ??
              ctx.unknown(
                result.status === "unknown" ? result.reason : "Daytona deletion is unconfirmed",
              )
            );
          },
        },
        async inspect(box) {
          const result = await driver.inspect(native(box.id));

          if (!result) return null;
          const detail = await resourceState.box(box.id);

          return {
            id: box.id,
            state: detail.state === "stopped" ? ("stopped" as const) : result.state,
          };
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
            let receiptDeadline: number | undefined;

            const result = await driver.exec({
              sandbox: native(input.sandbox.id),
              identity: identity(ctx),
              command: input.command,
              cwd: input.cwd,
              env: input.env,
              deadlineSeconds: input.deadlineSeconds,
              maxOutputBytes: input.maxOutputBytes,
              signal: ctx.signal,
              onSubmit() {
                receiptDeadline = Date.now() + (input.deadlineSeconds + 10) * 1000;
              },
            });

            const value = executionValue(result);

            if (value) return value;

            if (result.status === "rejected") return failure(result, ctx);

            const token: z.infer<typeof ExecToken> = {
              submissionId: ctx.submissionId,
              maxOutputBytes: input.maxOutputBytes,
            };

            if (receiptDeadline !== undefined) token.receiptDeadline = receiptDeadline;

            return ctx.pending(token, { pollAfterMs: 500 });
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

            if (
              result.status === "pending" &&
              token?.success &&
              token.data.receiptDeadline &&
              Date.now() < token.data.receiptDeadline
            )
              return ctx.pending(token.data, { pollAfterMs: result.observeAfterMs });

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
