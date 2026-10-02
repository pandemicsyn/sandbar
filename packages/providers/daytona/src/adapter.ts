import {
  RenewRequest,
  PreviewPort,
  PreviewResult,
  ResolvedRenewInput,
  sandboxReference,
  assertSandboxReference,
  assertResourceScope,
  unknownSandboxFacts,
  nativeDeadline,
  type SandboxInfo,
  type SandboxReference,
} from "sandbar-adapter";
import { z } from "zod";
import { daytonaState } from "./state-native";
import { MountDurability as importMountDurability, type ResourceReference } from "sandbar-adapter";
import {
  AdapterError,
  AdapterCheckpointError,
  type OperationOutcome,
  defineAdapter,
  type AttemptContext,
  type ObserveContext,
} from "sandbar-adapter";
import type { DriverResult } from "@sandbar/provider-spi";
import {
  boundedBytes,
  daytonaProvider,
  daytonaRegistration,
  type DaytonaEndpointPair,
} from "./index";

const Configuration = z
  .strictObject({
    apiUrl: z.url().default("https://app.daytona.io/api"),
    toolboxOrigin: z.url().default("https://proxy.app.daytona.io"),
    target: z.string().min(1),
    networkPolicy: z.enum(["blocked", "daytona-default"]).default("blocked"),
    snapshots: z
      .strictObject({ restartAfterCapture: z.boolean().default(true) })
      .default({ restartAfterCapture: true }),
    ttlMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    preview: z
      .strictObject({ access: z.enum(["protected", "public"]).default("protected") })
      .default({ access: "protected" }),
    lifecycle: z
      .strictObject({ lifetimeSeconds: z.number().int().positive().safe().max(86400).optional() })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.lifecycle?.lifetimeSeconds !== undefined && value.ttlMinutes !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "lifetimeSeconds"],
        message: "Supply one lifetime option",
      });
  })
  .transform((value) => ({
    ...value,
    ttlMinutes:
      value.lifecycle?.lifetimeSeconds === undefined
        ? (value.ttlMinutes ?? 60)
        : Math.ceil(value.lifecycle.lifetimeSeconds / 60),
  }));

const RenewToken = z.strictObject({ acknowledged: z.literal(true) });

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

function destroyOutcome(token: z.infer<typeof DestroyToken>): OperationOutcome {
  return {
    kind: "destroy",
    status: "unknown",
    retainedVolumes:
      token.mountDurability?.map((mount) => {
        if (mount.volume.kind !== "volume")
          throw new AdapterError("INTERNAL", "Invalid retained volume identity");

        return { ...mount.volume, kind: "volume" as const };
      }) ?? [],
  };
}

const ExecToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  maxOutputBytes: z.number().int().nonnegative().max(1_048_576),
  receiptDeadline: z.number().int().nonnegative().optional(),
});

const WriteToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
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

const DestroyToken = z.strictObject({
  sandboxId: z.string().min(1).max(512),
  deletionAccepted: z.boolean().optional(),
  stage: z.enum(["uncertain", "accepted", "rejected"]).optional(),
  rejectionCode: z.enum(Object.values(errorCodes)).optional(),
  retainedResources: z.array(z.string().min(1).max(512)).max(128).optional(),
  mountDurability: z.array(importMountDurability).max(32).optional(),
});

function requireDestroyTokenCapacity(token: z.infer<typeof DestroyToken>): void {
  const versions: z.infer<typeof DestroyToken>[] = [
    token,
    { ...token, stage: "accepted", deletionAccepted: true },
    { ...token, stage: "rejected", rejectionCode: "INVALID_ARGUMENT" },
  ];

  if (
    versions.some(
      (version) =>
        !DestroyToken.safeParse(version).success ||
        new TextEncoder().encode(JSON.stringify(version)).length > 4096,
    )
  )
    throw new AdapterError("CAPACITY", "Daytona destroy custody exceeds recovery token bound");
}

// Retained labels are summaries; mountDurability preserves the full scoped native identity.
function retainedVolumeLabel(nativeId: string): string {
  const label = `daytona-volume:${nativeId}`;

  return label.length <= 512 ? label : nativeId;
}

function failure(result: Exclude<DriverResult, { status: "completed" }>, ctx: AttemptContext) {
  if (result.status === "rejected")
    return ctx.reject(errorCodes[result.error.code], result.error.message);

  return ctx.unknown(
    result.status === "unknown" ? result.reason : "Daytona result remains uncertain",
  );
}

async function createResult(
  result: DriverResult & { nativeSandbox?: { id: string; labels?: Record<string, string> } },
  ctx: AttemptContext,
  referenceFor: (
    id: string,
    operation: string,
    submission: string,
    nativeDetail?: { id: string; labels?: Record<string, string> },
  ) => Promise<SandboxReference | null>,
  useNativeDetail = false,
) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Daytona returned another result kind");

    return {
      id: result.value.observation.ref.nativeId,
      reference:
        (await referenceFor(
          result.value.observation.ref.nativeId,
          ctx.operationId,
          ctx.submissionId,
          useNativeDetail ? result.nativeSandbox : undefined,
        )) ?? undefined,
      state:
        result.value.observation.state === "running" ? ("running" as const) : ("unknown" as const),
    };
  }

  if (result.status === "pending")
    return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });

  return failure(result, ctx);
}

async function observedCreate(
  result: DriverResult & { nativeSandbox?: { id: string; labels?: Record<string, string> } },
  ctx: ObserveContext,
  submissionId: string,
  operationId: string,
  referenceFor: (
    id: string,
    operation: string,
    submission: string,
    nativeDetail?: { id: string; labels?: Record<string, string> },
  ) => Promise<SandboxReference | null>,
) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Daytona returned another result kind");

    return {
      id: result.value.observation.ref.nativeId,
      reference:
        (await referenceFor(
          result.value.observation.ref.nativeId,
          operationId,
          submissionId,
          result.nativeSandbox,
        )) ?? undefined,
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
      if (config.preview.access === "public")
        throw new AdapterError(
          "UNSUPPORTED",
          "Daytona public previews require sandbox-wide publication; this adapter supports preview.access protected only",
        );

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

      const resourceBinding = {
        authority: { kind: "organization", id: scope.accountId! },
        partition,
      };

      const resourceState = daytonaState({
        scope: { authority: { kind: "organization", id: scope.accountId! }, partition },
        apiUrl: config.apiUrl,
        apiKey: credentials.apiKey,
        target: config.target,
        restartAfterCapture: config.snapshots.restartAfterCapture,
        fetch: fetchImpl ?? fetch,
      });

      const inspection = async (
        id: string,
        expected?: SandboxReference,
        ctx?: import("sandbar-adapter").ReadContext,
      ): Promise<SandboxInfo> => {
        let value;

        try {
          value = await resourceState.box(id, ctx);
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError("UNAVAILABLE", "Daytona native detail is unavailable");
        }

        if (value.networkBlockAll === undefined || value.public === undefined)
          throw new AdapterError(
            "UNAVAILABLE",
            "Daytona native network/visibility policy is unavailable",
          );

        if (value.networkBlockAll !== (config.networkPolicy === "blocked") || value.public)
          throw new AdapterError("CONFLICT", "Daytona native network/visibility policy differs");
        const operation = value.labels?.["sandbar.operation"];
        const submission = value.labels?.["sandbar.submission"];

        const reference =
          operation && submission
            ? sandboxReference("daytona", resourceBinding, value.id, { operation, submission })
            : null;

        if (expected) {
          if (!reference)
            throw new AdapterError("CONFLICT", "Native sandbox creation correlation is missing");
          assertSandboxReference(reference, expected);
        }

        const states = new Map<string, import("sandbar-adapter").SandboxState>([
          ["started", "running"],
          ["stopped", "stopped"],
          ["archived", "suspended"],
          ["starting", "restoring"],
          ["restoring", "restoring"],
          ["resuming", "restoring"],
          ["creating", "creating"],
          ["destroying", "destroying"],
          ["destroyed", "destroyed"],
        ]);

        return {
          ...unknownSandboxFacts(),
          reference,
          state: states.get(value.state) ?? "unknown",
          nativeState: value.state,
          observedAt: new Date().toISOString(),
          expires: nativeDeadline(value.autoDestroyAt, "sandbox"),
          idleStop:
            value.autoStopInterval != null &&
            Number.isSafeInteger(value.autoStopInterval) &&
            value.autoStopInterval >= 0
              ? {
                  status: "known",
                  value:
                    value.autoStopInterval === 0
                      ? null
                      : { seconds: value.autoStopInterval * 60, action: "stop" },
                }
              : unknownSandboxFacts().idleStop,
          retention:
            value.autoDeleteInterval != null && Number.isSafeInteger(value.autoDeleteInterval)
              ? {
                  status: "known",
                  value: {
                    autoDeleteAfterStoppedSeconds:
                      value.autoDeleteInterval < 0 ? null : value.autoDeleteInterval * 60,
                  },
                }
              : unknownSandboxFacts().retention,
        };
      };

      const referenceFor = async (
        id: string,
        operation: string,
        submission: string,
        nativeDetail?: { id: string; labels?: Record<string, string> },
      ) => {
        // The driver has already checked scope and labels on mount/observation detail reads.
        if (nativeDetail) {
          if (
            nativeDetail.id !== id ||
            nativeDetail.labels?.["sandbar.operation"] !== operation ||
            nativeDetail.labels?.["sandbar.submission"] !== submission
          )
            return null;

          return sandboxReference("daytona", resourceBinding, id, { operation, submission });
        }

        try {
          const info = await inspection(id);

          const expected = sandboxReference("daytona", resourceBinding, id, {
            operation,
            submission,
          });

          if (!info.reference) return null;
          assertSandboxReference(info.reference, expected);

          return info.reference;
        } catch {
          return null;
        } // Confirmed creation remains usable when optional native metadata cannot be read.
      };

      const destroyToken = (
        sandboxId: string,
        mounts: Awaited<ReturnType<typeof resourceState.box>>["volumes"],
        retainedResources?: string[],
      ): z.infer<typeof DestroyToken> => {
        const token: z.infer<typeof DestroyToken> = {
          sandboxId,
          stage: "uncertain",
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
        requireDestroyTokenCapacity(token);

        return token;
      };

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
            Object.keys(input.request.resources ?? {}).length ||
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
              requireSnapshotIdentity: true,
              networkPolicy: input.request.networkPolicy,
              signal: ctx.signal,
            }),
            ctx,
            referenceFor,
          );
        },
        async observe(attempt: import("sandbar-adapter").RecoveryAttempt, ctx: ObserveContext) {
          if (!attempt.resource || attempt.resource.kind !== "snapshot")
            return ctx.unknown("Missing restore snapshot identity");

          const value = await driver.observe({
            scope,
            submissionId: attempt.submissionId,
            operationId: attempt.operationId,
            expectedSnapshotId: attempt.resource.nativeId,
          });

          return value
            ? observedCreate(value, ctx, attempt.submissionId, attempt.operationId, referenceFor)
            : null;
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
        async snapshotList(
          page: Parameters<
            NonNullable<import("sandbar-adapter").AdapterSession["snapshotList"]>
          >[0],
          ctx: import("sandbar-adapter").ReadContext,
        ) {
          const result = await resourceState.fields.snapshotList!(page, ctx);

          for (const info of result.items) info.restore.networkPolicies = [...caps.networkPolicies];

          return result;
        },
        async resourceCapabilities(target, ctx) {
          if (target.sandbox?.reference)
            await inspection(target.sandbox.id, target.sandbox.reference, ctx);

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
            const nativeResult = await driver.create({
              scope,
              identity: identity(ctx),
              image: input.image,
              imageKind: input.imageKind,
              networkPolicy: input.networkPolicy,
              labels: input.labels,
              mounts: input.mounts,
              signal: ctx.signal,
            });

            const result = await createResult(
              nativeResult,
              ctx,
              referenceFor,
              !!input.mounts?.length,
            );

            if (!("id" in result) || !input.mounts?.length) return result;

            const detail = nativeResult.nativeSandbox;

            if (
              !detail ||
              detail.state !== "started" ||
              input.mounts.some(
                (mount) =>
                  !detail.volumes?.some(
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

            const value = result
              ? await observedCreate(
                  result,
                  ctx,
                  attempt.submissionId,
                  attempt.operationId,
                  referenceFor,
                )
              : null;

            if (!value || !("id" in value) || !attempt.mounts?.length) return value;
            const detail = result?.nativeSandbox;

            if (
              !detail ||
              detail.state !== "started" ||
              attempt.mounts.some(
                (mount) =>
                  !detail.volumes?.some(
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
              nativeBox = await resourceState.box(box.id, ctx, box.reference);
            } catch (error) {
              if (error instanceof AdapterError) throw error;
              throw new AdapterError("UNAVAILABLE", "Daytona inspection failed before deletion");
            }

            if (nativeBox.volumes.length && box.storage !== "allow-unconfirmed")
              throw new AdapterError(
                "UNSUPPORTED",
                "Writable mount shutdown durability is unverified; select allow-unconfirmed for compute cleanup",
              );

            let retainedResources: string[] | undefined;

            try {
              retainedResources = await driver.destroyRetainedResources(native(box.id));
            } catch {
              throw new AdapterError("UNAVAILABLE", "Daytona inspection failed before deletion");
            }

            destroyToken(box.id, nativeBox.volumes, retainedResources);

            return box;
          },
          async submit(box, ctx) {
            let mounts: Awaited<ReturnType<typeof resourceState.box>>["volumes"];

            try {
              mounts = (
                await resourceState.box(
                  box.id,
                  {
                    signal: ctx.signal,
                    deadline: Date.now() + 30000,
                  },
                  box.reference,
                )
              ).volumes;
            } catch (error) {
              const code = error instanceof AdapterError ? error.code : "UNAVAILABLE";
              await ctx.checkpoint({ sandboxId: box.id, stage: "rejected", rejectionCode: code });

              return ctx.reject(code, "Daytona inspection failed before deletion");
            }

            if (mounts.length && box.storage !== "allow-unconfirmed") {
              await ctx.checkpoint({
                sandboxId: box.id,
                stage: "rejected",
                rejectionCode: "UNSUPPORTED",
              });

              return ctx.reject(
                "UNSUPPORTED",
                "Writable mount cleanup requires explicit allow-unconfirmed",
              );
            }

            let retainedResources: string[] | undefined;

            try {
              retainedResources = await driver.destroyRetainedResources(native(box.id));
            } catch {
              await ctx.checkpoint({
                sandboxId: box.id,
                stage: "rejected",
                rejectionCode: "UNAVAILABLE",
              });

              return ctx.reject("UNAVAILABLE", "Daytona inspection failed before deletion");
            }

            let token: z.infer<typeof DestroyToken>;

            try {
              token = destroyToken(box.id, mounts, retainedResources);
            } catch (error) {
              if (!(error instanceof AdapterError) || error.code !== "CAPACITY") throw error;
              await ctx.checkpoint({
                sandboxId: box.id,
                stage: "rejected",
                rejectionCode: "CAPACITY",
              });

              return ctx.reject("CAPACITY", error.message);
            }

            await ctx.checkpoint(token).catch((error) => {
              if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
              throw error;
            });

            if (ctx.signal.aborted) {
              token.stage = "rejected";
              token.rejectionCode = "UNAVAILABLE";
              await ctx.checkpoint(token).catch((error) => {
                if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
                throw error;
              });

              return ctx.reject("UNAVAILABLE", "Daytona deletion cancelled before dispatch");
            }

            if (box.reference)
              await resourceState.box(
                box.id,
                { signal: ctx.signal, deadline: Date.now() + 30000 },
                box.reference,
              );

            const result = await driver.destroy({
              sandbox: native(box.id),
              identity: identity(ctx),
              signal: ctx.signal,
              retainedResources,
            });

            if (result.status === "rejected") {
              token.stage = "rejected";
              token.rejectionCode = errorCodes[result.error.code];
              await ctx.checkpoint(token).catch((error) => {
                if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
                throw error;
              });

              return failure(result, ctx);
            }

            if (result.deletionAccepted || result.status === "completed") {
              token.deletionAccepted = true;
              token.stage = "accepted";
              await ctx.checkpoint(token).catch((error) => {
                if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
                throw error;
              });
            }

            const value = destroyValue(result);

            if (value)
              return {
                ...value,
                retainedResources: [
                  ...value.retainedResources,
                  ...mounts.map((mount) => retainedVolumeLabel(mount.volumeId)),
                ],
                mountDurability: token.mountDurability,
              };

            return ctx.pending(token, { pollAfterMs: 500 });
          },
          async observe(attempt, ctx) {
            const token = attempt.token ? DestroyToken.safeParse(attempt.token) : null;

            if (
              !attempt.sandbox ||
              (token && (!token.success || token.data.sandboxId !== attempt.sandbox.id))
            )
              return null;

            if (token?.success && token.data.stage === "rejected")
              return ctx.unknown(
                "Deletion cancelled before dispatch; continue to confirm no effect",
              );

            if (attempt.sandbox.reference) {
              try {
                await resourceState.box(attempt.sandbox.id, ctx, attempt.sandbox.reference);
              } catch (error) {
                if (!(error instanceof AdapterError) || error.code !== "NOT_FOUND") throw error;
              }
            }

            const result = await driver.observeDestroy(
              native(attempt.sandbox.id),
              attempt.submissionId,
              token?.success ? token.data.retainedResources : undefined,
              token?.success
                ? token.data.deletionAccepted ||
                    ["uncertain", "accepted"].includes(token.data.stage ?? "")
                : false,
            );

            if (!result)
              return ctx.unknown(
                "Daytona deletion is unconfirmed",
                token?.success ? destroyOutcome(token.data) : undefined,
              );

            if (result.status === "pending") {
              const recovery: z.infer<typeof DestroyToken> = {
                sandboxId: attempt.sandbox.id,
                stage: token?.success ? token.data.stage : undefined,
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
                    ? (token.data.mountDurability?.map((mount) =>
                        retainedVolumeLabel(mount.volume.nativeId),
                      ) ?? [])
                    : []),
                ],
              };

            return (
              completed ??
              ctx.unknown(
                result.status === "unknown" ? result.reason : "Daytona deletion is unconfirmed",
                token?.success ? destroyOutcome(token.data) : undefined,
              )
            );
          },
          async continue(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (
              token.success &&
              token.data.stage === "rejected" &&
              token.data.rejectionCode &&
              !token.data.deletionAccepted &&
              token.data.sandboxId === attempt.sandbox?.id
            )
              return ctx.reject(
                token.data.rejectionCode,
                "Daytona deletion was rejected before dispatch",
              );

            return ctx.unknown(
              "Daytona destroy cannot be replayed",
              token.success ? destroyOutcome(token.data) : undefined,
            );
          },
        },
        async renewCapabilities(target, ctx) {
          if (
            target.sandbox &&
            (await inspection(target.sandbox.id, target.sandbox.reference, ctx)).state !== "running"
          )
            return { status: "unavailable" as const, reason: "Renewal requires running compute" };

          return {
            status: "supported" as const,
            value: {
              minSeconds: 60,
              maxSeconds: 86400,
              stepSeconds: 60,
              scope: "sandbox" as const,
            },
          };
        },
        renew: {
          recovery: { version: 1, token: RenewToken },
          async prepare(input, ctx) {
            assertResourceScope(input.sandbox.reference, {
              provider: "daytona",
              scope: resourceBinding,
            });

            const requested = RenewRequest.parse({
              forSeconds: input.forSeconds ?? config.ttlMinutes * 60,
            }).forSeconds;

            if (requested > 86400)
              throw new AdapterError(
                "INVALID_ARGUMENT",
                "Renewal exceeds the adapter lifetime ceiling",
              );
            const forSeconds = Math.ceil(requested / 60) * 60;
            const info = await inspection(input.sandbox.id, input.sandbox.reference, ctx);

            if (info.state !== "running")
              throw new AdapterError("UNAVAILABLE", "Renewal requires running compute");

            return ResolvedRenewInput.parse({ ...input, forSeconds });
          },
          async submit(input, ctx) {
            if (ctx.signal.aborted)
              return ctx.reject("UNAVAILABLE", "Renewal cancelled before dispatch");

            try {
              const response = await resourceState.renew(
                input.sandbox.id,
                input.forSeconds,
                ctx.signal,
              );

              if ([400, 401, 403, 404, 409, 422, 429].includes(response.status))
                return ctx.reject(
                  response.status === 404
                    ? "NOT_FOUND"
                    : [401, 403].includes(response.status)
                      ? "FORBIDDEN"
                      : response.status === 409
                        ? "CONFLICT"
                        : response.status === 429
                          ? "RATE_LIMIT"
                          : "INVALID_ARGUMENT",
                  "Daytona renewal rejected",
                );

              if (!response.ok)
                throw new AdapterError("UNAVAILABLE", "Daytona renewal acknowledgement was lost");
            } catch {
              return ctx.unknown(
                "Daytona renewal acknowledgement was lost; never replay this reset",
                {
                  kind: "sandbox_renew",
                  status: "unknown",
                  reference: input.sandbox.reference,
                  requested: { forSeconds: input.forSeconds },
                  observation: await inspection(input.sandbox.id, input.sandbox.reference, {
                    signal: ctx.signal,
                    deadline: Date.now() + 30000,
                  }).catch(() => null),
                },
              );
            }

            // One effect is complete. A failed compatibility save cannot erase its ACK.
            try {
              await ctx.checkpoint({ acknowledged: true });
            } catch {
              /* Return the confirmed result below. */
            }

            const observation = await inspection(input.sandbox.id, input.sandbox.reference, {
              signal: ctx.signal,
              deadline: Date.now() + 30000,
            }).catch(() => null);

            return {
              reference: input.sandbox.reference,
              requested: { forSeconds: input.forSeconds },
              acknowledged: true as const,
              observation,
            };
          },
          async observe(attempt, ctx) {
            if (!attempt.sandbox?.reference || !attempt.renewal)
              return ctx.unknown("Saved renewal intent or identity is missing");
            assertResourceScope(attempt.sandbox.reference, {
              provider: "daytona",
              scope: resourceBinding,
            });
            const acknowledged = RenewToken.safeParse(attempt.token).success;

            const observation = await inspection(
              attempt.sandbox.id,
              attempt.sandbox.reference,
              ctx,
            ).catch(() => null);

            if (!acknowledged)
              return ctx.unknown(
                "A current deadline cannot prove renewal acknowledgement; never replay",
                {
                  kind: "sandbox_renew",
                  status: "unknown",
                  reference: attempt.sandbox.reference,
                  requested: attempt.renewal,
                  observation,
                },
              );

            return {
              reference: attempt.sandbox.reference,
              requested: attempt.renewal,
              acknowledged: true as const,
              observation,
            };
          },
        },
        async reopen(reference, ctx) {
          assertResourceScope(reference, {
            provider: "daytona",
            scope: { authority: { kind: "organization", id: scope.accountId! }, partition },
          });

          return inspection(reference.nativeId, reference, ctx);
        },
        async inspect(box, ctx) {
          return { id: box.id, ...(await inspection(box.id, box.reference, ctx)) };
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
          async prepare(input, ctx) {
            if (input.sandbox.reference)
              await inspection(input.sandbox.id, input.sandbox.reference, ctx);

            return input;
          },
          async submit(input, ctx) {
            if (input.sandbox.reference)
              await inspection(input.sandbox.id, input.sandbox.reference, {
                signal: ctx.signal,
                deadline: Date.now() + 30000,
              });
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

            if (attempt.sandbox.reference)
              await inspection(attempt.sandbox.id, attempt.sandbox.reference, ctx);

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
        async preview(input, ctx) {
          if (!PreviewPort.safeParse(input.port).success)
            throw new AdapterError(
              "INVALID_ARGUMENT",
              "Preview port must be an integer from 1 through 65535",
            );

          if (!input.sandbox.reference)
            throw new AdapterError(
              "UNSUPPORTED",
              "Daytona preview requires a verified sandbox reference; inspect and reopen using its reference first",
            );
          const info = await inspection(input.sandbox.id, input.sandbox.reference, ctx);

          if (info.state === "destroyed")
            throw new AdapterError(
              "NOT_FOUND",
              "Daytona sandbox is destroyed; preview access is unavailable",
            );

          if (info.state !== "running")
            throw new AdapterError(
              "UNAVAILABLE",
              "Daytona preview requires running compute; resume explicitly before requesting access",
            );

          try {
            const response = await (fetchImpl ?? fetch)(
              `${config.apiUrl}/sandbox/${encodeURIComponent(input.sandbox.id)}/ports/${input.port}/preview-url`,
              {
                headers: { Authorization: `Bearer ${credentials.apiKey}` },
                signal: ctx.signal,
                redirect: "error",
              },
            );

            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined);
              throw new AdapterError(
                response.status === 404
                  ? "NOT_FOUND"
                  : [401, 403].includes(response.status)
                    ? "FORBIDDEN"
                    : "UNAVAILABLE",
                "Daytona preview access request failed",
              );
            }

            // Native preview data includes credentials: bound parsing and never include its body in errors.
            const bytes = await boundedBytes(response, 32768, ctx.signal);

            const native = z
              .object({
                sandboxId: z.string(),
                url: z.string(),
                token: z.string().min(1).max(8192),
              })
              .parse(JSON.parse(new TextDecoder().decode(bytes)));

            if (native.sandboxId !== input.sandbox.id)
              throw new AdapterError("CONFLICT", "Daytona preview response identity differs");

            return PreviewResult.parse({
              access: "protected",
              url: native.url,
              headers: { "x-daytona-preview-token": native.token },
            });
          } catch (error) {
            if (error instanceof AdapterError) throw error;
            throw new AdapterError("UNAVAILABLE", "Daytona preview access response is unavailable");
          }
        },
        files: {
          maxBytes: caps.maxFileBytes,
          async read(input, ctx) {
            if (input.sandbox.reference)
              await inspection(input.sandbox.id, input.sandbox.reference, {
                signal: ctx.signal,
                deadline: Date.now() + 30000,
              });

            ctx.signal.throwIfAborted();

            return driver.readFile({
              sandbox: native(input.sandbox.id),
              path: input.path,
              signal: ctx.signal,
            });
          },
          write: {
            recovery: { version: 1, token: WriteToken },
            async prepare(input, ctx) {
              if (input.sandbox.reference)
                await inspection(input.sandbox.id, input.sandbox.reference, ctx);

              return input;
            },
            async submit(input, ctx) {
              if (input.sandbox.reference)
                await inspection(input.sandbox.id, input.sandbox.reference, {
                  signal: ctx.signal,
                  deadline: Date.now() + 30000,
                });

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

              if (attempt.sandbox.reference)
                await inspection(attempt.sandbox.id, attempt.sandbox.reference, ctx);

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
