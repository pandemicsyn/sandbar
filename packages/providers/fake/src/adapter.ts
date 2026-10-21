import { z } from "zod";
import {
  AdapterError,
  assertResourceScope,
  defineAdapter,
  ResourceReference,
  sandboxReference,
  type AdapterSession,
  type AttemptContext,
  type ImageInfo,
  type SnapshotInfo,
  type SnapshotProfile,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartInput,
  type ProcessStartContext,
  type Scope,
  type ObserveContext,
} from "@sandbar-sdk/adapter";
import type { DriverResult } from "@sandbar/provider-spi";
import { fakeProvider } from "./client";
import { FAKE_STARTER_IMAGE, type FakeImage } from "./protocol";

const ImageBuildToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  source: z.string().min(1).max(1024),
});

const ImageDeleteToken = z.strictObject({
  stage: z.enum(["uncertain", "rejected"]),
  imageId: z.string().min(1).max(512),
});

const Empty = z.strictObject({});

const Token = z.strictObject({ submissionId: z.string().min(1).max(128) });

const CaptureToken = z.strictObject({
  submissionId: z.string().min(1).max(128),
  sandbox: z.string().min(1).max(512),
});

/** Fake snapshots copy the sandbox's files; a restore starts fresh with them. */
const snapshotProfile: SnapshotProfile = {
  id: "fake-files",
  preserve: "filesystem",
  sourceStates: ["running"],
  interruption: "none",
  sourceAfter: "unchanged",
  connections: "preserved",
  consistency: "crash-consistent",
  restoreExecution: "fresh",
  mountHandling: "none",
};

const restoreSupport = {
  networkPolicies: ["blocked"],
  resources: false,
  mounts: false,
  independentLifecycle: true,
};

const errorCodes = {
  invalid: "INVALID_ARGUMENT",
  unsupported: "UNSUPPORTED",
  unauthorized: "UNAUTHENTICATED",
  forbidden: "FORBIDDEN",
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

  return ctx.unknown(result.status === "unknown" ? result.reason : "Fake result is uncertain");
}

function createResult(result: DriverResult, ctx: AttemptContext, scope: Scope) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Fake returned another result kind");
    const id = result.value.observation.ref.nativeId;

    return {
      id,
      reference: sandboxReference("fake", scope, id, {
        operation: ctx.operationId,
        submission: ctx.submissionId,
      }),
      state:
        result.value.observation.state === "running" ? ("running" as const) : ("unknown" as const),
    };
  }

  if (result.status === "pending")
    return ctx.pending({ submissionId: ctx.submissionId }, { pollAfterMs: result.observeAfterMs });

  return failure(result, ctx);
}

function observedCreate(
  result: DriverResult,
  ctx: ObserveContext,
  attempt: { operationId: string; submissionId: string },
  scope: Scope,
) {
  if (result.status === "completed") {
    if (result.value.kind !== "sandbox") return ctx.unknown("Fake returned another result kind");
    const id = result.value.observation.ref.nativeId;

    return {
      id,
      reference: sandboxReference("fake", scope, id, {
        operation: attempt.operationId,
        submission: attempt.submissionId,
      }),
      state:
        result.value.observation.state === "running" ? ("running" as const) : ("unknown" as const),
    };
  }

  if (result.status === "pending")
    return ctx.pending(
      { submissionId: attempt.submissionId },
      { pollAfterMs: result.observeAfterMs },
    );

  return ctx.unknown("Fake observation did not confirm completion");
}

function bytes(base64?: string) {
  return Uint8Array.from(Buffer.from(base64 ?? "", "base64"));
}

/**
 * A deterministic loopback adapter for SDK qualification. Image inspection, inventory and deletion
 * are always available; `imageBuild: true` also builds images, standing in for build-first
 * providers. Built images are simulated records; nothing is pulled or run.
 */
export function createFakeAdapter(options: {
  url: string;
  token: string;
  fetch?: typeof fetch;
  imageBuild?: boolean;
  /** Capture sandbox files as snapshots and restore from them, like a filesystem snapshot. */
  snapshots?: boolean;
  /**
   * Stream seeded exec fixtures as sustained byte processes. The output arrives at start; the
   * process then stays running for `holdMs` (default 0) unless it is terminated, which exits 143.
   * `textOnly` streams decoded text without declaring byte output, like Boat or Runloop.
   */
  processes?: { holdMs?: number; textOnly?: boolean };
}) {
  return defineAdapter({
    name: "fake",
    displayName: "Fake test provider",
    config: Empty,
    credentials: Empty,
    async connect() {
      const { driver, scope } = await fakeProvider(options);
      const native = (id: string) => ({ kind: "sandbox" as const, scope, nativeId: id });

      const identity = (ctx: AttemptContext) => ({
        projectId: "adapter",
        operationId: ctx.operationId,
        submissionId: ctx.submissionId,
        invocationKey: ctx.invocationKey,
      });

      const caps = await driver.capabilities(scope);

      const bindingScope = {
        authority: { kind: "fixture", id: "fake-local" },
        partition: { endpoint: new URL(options.url).origin, region: "local" },
      };

      const info = (observation: {
        state: "running" | "destroyed" | "unknown";
        observedAt: string;
      }) => ({
        state: observation.state === "running" ? ("running" as const) : ("unknown" as const),
        nativeState: observation.state,
        observedAt: observation.observedAt,
        expires: { status: "unknown" as const, reason: "Fake sandboxes have no native expiry" },
        idleStop: { status: "unknown" as const, reason: "Fake sandboxes have no idle policy" },
        retention: {
          status: "unknown" as const,
          reason: "Fake sandboxes have no retention policy",
        },
        execution: {
          status: "unknown" as const,
          reason: "Fake sandboxes have no execution identity",
        },
      });

      const imageRef = (
        id: string,
        ownership: ResourceReference["ownership"],
      ): ResourceReference => ({
        version: 1,
        kind: "image",
        provider: "fake",
        scope: structuredClone(bindingScope),
        nativeId: id,
        ownership,
      });

      const checkImage = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "fake", scope: bindingScope });

        if (ref.kind !== "image") throw new AdapterError("INVALID_ARGUMENT", "Wrong resource kind");
      };

      const imageInfo = (image: FakeImage, reference: ResourceReference): ImageInfo => ({
        reference,
        state: "ready",
        createdAt: image.createdAt,
        source: image.source ? { kind: "oci", value: image.source } : null,
        visibility: image.visibility,
        // The fake does not enumerate sandboxes per image; deletion checks use at dispatch.
        nativeDependencies: null,
      });

      const builtImage = (image: FakeImage, created: boolean) => ({
        preparedId: image.id,
        retainedResources: [
          {
            kind: "fake-image",
            id: image.id,
            ownership: created ? ("verified" as const) : ("unknown" as const),
            cleanup: "manual" as const,
          },
        ],
        image: imageRef(image.id, created ? "verified-created" : "unknown"),
      });

      const imageBuild: AdapterSession["imageBuild"] = {
        recovery: { version: 1, token: ImageBuildToken },
        async submit(input, ctx) {
          const token = { submissionId: ctx.submissionId, source: input.source.value };
          await ctx.checkpoint(token);

          if (ctx.signal.aborted)
            return ctx.reject("UNAVAILABLE", "Build cancelled before dispatch");

          const result = await driver.buildImage({
            scope,
            identity: identity(ctx),
            source: input.source.value,
          });

          if (result.status === "rejected") return ctx.reject("UNAVAILABLE", result.reason);

          if (result.status === "unknown") return ctx.unknown(`${result.reason}; no build replay`);

          return builtImage(result.image, result.created);
        },
        async observe(attempt, ctx) {
          const token = ImageBuildToken.safeParse(attempt.token);

          if (!token.success || token.data.submissionId !== attempt.submissionId)
            return ctx.unknown("Fake image build evidence is unavailable; no build replay");

          const image = await driver.inspectImage(scope, { submissionId: attempt.submissionId });

          if (!image) return null;

          if (image.source !== token.data.source)
            return ctx.unknown("Fake image build source differs; no build replay");

          // Discovered by submission rather than acknowledged, so ownership stays unknown.
          return builtImage(image, false);
        },
      };

      const images: Pick<
        AdapterSession,
        "imageInspect" | "imageListCoverage" | "imageList" | "imageDelete"
      > = {
        async imageInspect(ref) {
          checkImage(ref);
          const image = await driver.inspectImage(scope, { imageId: ref.nativeId });

          if (!image) throw new AdapterError("NOT_FOUND", "Fake image does not exist");

          return imageInfo(image, structuredClone(ref));
        },
        imageListCoverage: "provider-scope",
        async imageList(input) {
          const page = await driver.listImages({
            scope,
            cursor: input.cursor,
            limit: input.limit,
          });

          return {
            items: page.items.map((image) =>
              imageInfo(
                image,
                imageRef(image.id, image.id === FAKE_STARTER_IMAGE ? "borrowed" : "unknown"),
              ),
            ),
            nextCursor: page.nextCursor,
            coverage: "provider-scope",
          };
        },
        imageDelete: {
          recovery: { version: 1, token: ImageDeleteToken },
          async prepare(ref) {
            checkImage(ref);
            const image = await driver.inspectImage(scope, { imageId: ref.nativeId });

            if (!image) throw new AdapterError("NOT_FOUND", "Fake image does not exist");

            if (image.visibility === "public")
              throw new AdapterError("CONFLICT", "Fake public provider images are never deleted");

            return ref;
          },
          async submit(ref, ctx) {
            checkImage(ref);
            await ctx.checkpoint({ stage: "uncertain", imageId: ref.nativeId });

            if (ctx.signal.aborted) {
              await ctx.checkpoint({ stage: "rejected", imageId: ref.nativeId });

              return ctx.reject("UNAVAILABLE", "Image delete cancelled before dispatch");
            }

            const result = await driver.deleteImage({
              scope,
              identity: identity(ctx),
              imageId: ref.nativeId,
            });

            if (result.status === "deleted") return { deleted: true as const, reference: ref };

            if (result.status === "not_found")
              return ctx.reject("NOT_FOUND", "Fake image does not exist");

            if (result.status === "rejected")
              return ctx.reject(
                "CONFLICT",
                result.reason === "public"
                  ? "Fake public provider images are never deleted"
                  : "Fake image is in use by a running sandbox",
              );

            if (result.status === "transport_rejected")
              return ctx.reject("UNAVAILABLE", `Fake image delete rejected (${result.httpStatus})`);

            return ctx.unknown("Fake image delete response was lost; observe without replay");
          },
          async observe(attempt, ctx) {
            const token = ImageDeleteToken.safeParse(attempt.token);
            const ref = attempt.resource;

            if (
              !ref ||
              ref.kind !== "image" ||
              !token.success ||
              token.data.imageId !== ref.nativeId
            )
              return ctx.unknown("Fake image delete evidence is unavailable; no replay");

            if (token.data.stage === "rejected")
              return ctx.unknown("Image delete was cancelled before dispatch");
            checkImage(ref);

            if (await driver.inspectImage(scope, { imageId: ref.nativeId }))
              return ctx.unknown("Fake image is still present; no delete replay");

            return { deleted: true as const, reference: ref };
          },
        },
      };

      const snapshotRef = (
        id: string,
        ownership: ResourceReference["ownership"],
      ): ResourceReference => ({ ...imageRef(id, ownership), kind: "snapshot" });

      const checkSnapshot = (ref: ResourceReference) => {
        assertResourceScope(ref, { provider: "fake", scope: bindingScope });

        if (ref.kind !== "snapshot")
          throw new AdapterError("INVALID_ARGUMENT", "Wrong resource kind");
      };

      const snapshotInfo = (image: FakeImage, reference: ResourceReference): SnapshotInfo => ({
        reference,
        preserve: "filesystem",
        restoreExecution: "fresh",
        consistency: "crash-consistent",
        source: image.source
          ? { id: image.source.replace(/^snapshot:/, ""), class: "fake-sandbox" }
          : null,
        state: "ready",
        createdAt: image.createdAt,
        expiration: "unknown",
        excludedPaths: [],
        mounts: [],
        mountHandling: "none",
        restore: restoreSupport,
        dependencies: [],
        nativeDependencies: null,
      });

      const requireSnapshot = async (ref: ResourceReference) => {
        checkSnapshot(ref);
        const image = await driver.inspectImage(scope, { imageId: ref.nativeId });

        if (!image?.source?.startsWith("snapshot:"))
          throw new AdapterError("NOT_FOUND", "Fake snapshot does not exist");

        return image;
      };

      const captured = (image: FakeImage, created: boolean) => {
        const reference = snapshotRef(image.id, created ? "verified-created" : "unknown");

        return {
          snapshot: snapshotInfo(image, reference),
          capture: {
            preserve: "filesystem" as const,
            interruption: "none" as const,
            restoreExecution: "fresh" as const,
          },
          source: { state: "running" as const, connections: "preserved" as const },
          retainedResources: [reference],
        };
      };

      const snapshots: Pick<
        AdapterSession,
        | "snapshotProfiles"
        | "snapshotCapture"
        | "snapshotInspect"
        | "snapshotListCoverage"
        | "snapshotList"
        | "snapshotDelete"
        | "snapshotRestore"
        | "resourceCapabilities"
      > = {
        async snapshotProfiles() {
          return {
            status: "supported",
            value: { profiles: [snapshotProfile], defaultProfileId: snapshotProfile.id },
          };
        },
        snapshotCapture: {
          recovery: { version: 1, token: CaptureToken },
          async submit(input, ctx) {
            await ctx.checkpoint({ submissionId: ctx.submissionId, sandbox: input.sandbox.id });

            const result = await driver.captureSnapshot({
              scope,
              identity: identity(ctx),
              sandbox: native(input.sandbox.id),
            });

            if (result.status === "rejected") return ctx.reject("CONFLICT", result.reason);

            if (result.status === "unknown")
              return ctx.unknown(`${result.reason}; no capture replay`);

            return captured(result.image, result.created);
          },
          async observe(attempt, ctx) {
            const token = CaptureToken.safeParse(attempt.token);

            if (!token.success || token.data.submissionId !== attempt.submissionId)
              return ctx.unknown("Fake snapshot evidence is unavailable; no capture replay");

            const image = await driver.inspectImage(scope, { submissionId: attempt.submissionId });

            return image ? captured(image, false) : null;
          },
        },
        async snapshotInspect(ref) {
          return snapshotInfo(await requireSnapshot(ref), structuredClone(ref));
        },
        snapshotListCoverage: "provider-scope",
        async snapshotList(input) {
          const page = await driver.listSnapshots({
            scope,
            cursor: input.cursor,
            limit: input.limit,
          });

          return {
            items: page.items.map((image) => snapshotInfo(image, snapshotRef(image.id, "unknown"))),
            nextCursor: page.nextCursor,
            coverage: "provider-scope",
          };
        },
        snapshotDelete: {
          async prepare(ref) {
            await requireSnapshot(ref);

            return ref;
          },
          async submit(ref, ctx) {
            const result = await driver.deleteImage({
              scope,
              identity: identity(ctx),
              imageId: ref.nativeId,
            });

            if (result.status === "deleted") return { deleted: true as const, reference: ref };

            if (result.status === "not_found")
              return ctx.reject("NOT_FOUND", "Fake snapshot does not exist");

            if (result.status === "rejected")
              return ctx.reject("CONFLICT", "Fake snapshot is in use by a running sandbox");

            return ctx.unknown("Fake snapshot delete response was lost; observe without replay");
          },
          async observe(attempt, ctx) {
            const ref = attempt.resource;

            if (!ref) return ctx.unknown("Fake snapshot delete evidence is unavailable");
            checkSnapshot(ref);

            return (await driver.inspectImage(scope, { imageId: ref.nativeId }))
              ? ctx.unknown("Fake snapshot is still present; no delete replay")
              : { deleted: true as const, reference: ref };
          },
        },
        resourceCapabilities: async () => ({
          restore: { status: "supported" as const, value: restoreSupport },
          volumes: { status: "unsupported" as const, reason: "The fake has no volumes" },
          mounts: { status: "unsupported" as const, reason: "The fake has no mounts" },
        }),
        snapshotRestore: {
          recovery: { version: 1, token: Token },
          options: { env: true, labels: true, lifetime: { minSeconds: 1, maxSeconds: 86_400 } },
          async prepare(input) {
            if (input.request.resources || input.request.mounts?.length)
              throw new AdapterError("UNSUPPORTED", "Fake restores take no sizing or mounts");

            if (!restoreSupport.networkPolicies.includes(input.request.networkPolicy))
              throw new AdapterError("UNSUPPORTED", "Fake restores use blocked network only");
            await requireSnapshot(input.snapshot);

            return input;
          },
          async submit(input, ctx) {
            return createResult(
              await driver.create({
                scope,
                identity: identity(ctx),
                image: input.snapshot.nativeId,
                networkPolicy: input.request.networkPolicy,
                labels: input.request.labels,
                env: input.request.env,
                lifetimeSeconds: input.request.lifetimeSeconds,
              }),
              ctx,
              bindingScope,
            );
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            return result ? observedCreate(result, ctx, attempt, bindingScope) : null;
          },
        },
      };

      const processes = options.processes && {
        supports: {
          sustainedOutput: true as const,
          binaryOutput: options.processes.textOnly ? undefined : (true as const),
        },
        async start(input: ProcessStartInput, ctx: ProcessStartContext): Promise<NativeProcess> {
          const submissionId = crypto.randomUUID();

          const result = await driver.exec({
            sandbox: native(input.sandbox.id),
            identity: {
              projectId: "adapter",
              operationId: submissionId,
              submissionId,
              invocationKey: submissionId,
            },
            command: input.command,
            cwd: input.cwd,
            env: input.env,
            deadlineSeconds: 300,
            maxOutputBytes: input.maxOutputBytes,
          });

          if (result.status === "rejected")
            throw new AdapterError(errorCodes[result.error.code], result.error.message);

          if (
            result.status !== "completed" ||
            result.value.kind !== "execution" ||
            result.value.observation.exitCode == null
          )
            throw new AdapterError("UNAVAILABLE", "Fake process start was not confirmed");
          const observation = result.value.observation;
          let confirmedExit: NativeProcessExit | undefined;
          let finish: (exit: NativeProcessExit) => void = () => undefined;

          const exited = new Promise<NativeProcessExit>((resolve) => {
            finish = (exit) => {
              confirmedExit ??= exit;
              clearTimeout(timer);
              resolve(confirmedExit);
            };
          });

          const timer = setTimeout(
            () => finish({ exitCode: observation.exitCode! }),
            options.processes?.holdMs ?? 0,
          );

          for (const [stream, encoded] of [
            ["stdout", observation.stdoutBase64],
            ["stderr", observation.stderrBase64],
          ] as const) {
            const chunk = bytes(encoded);

            if (!chunk.byteLength) continue;

            if (options.processes?.textOnly)
              ctx.onOutput({ stream, text: new TextDecoder().decode(chunk) });
            else ctx.onOutputBytes?.({ stream, bytes: chunk });
          }

          return {
            get confirmedExit() {
              return confirmedExit;
            },
            wait: () => exited,
            outputDone: exited.then(() => undefined),
            detachOutput: async () => undefined,
            async terminate() {
              if (confirmedExit) return { status: "not-found" as const };
              finish({ exitCode: 143 });

              return { status: "requested" as const };
            },
            // A detached observer must not keep the local event loop alive for the held process.
            detach: async () => {
              timer.unref();
            },
          };
        },
      };

      const snapshotHooks = options.snapshots ? snapshots : undefined;

      return {
        ...images,
        snapshotProfiles: snapshotHooks?.snapshotProfiles,
        snapshotCapture: snapshotHooks?.snapshotCapture,
        snapshotInspect: snapshotHooks?.snapshotInspect,
        snapshotListCoverage: snapshotHooks?.snapshotListCoverage,
        snapshotList: snapshotHooks?.snapshotList,
        snapshotDelete: snapshotHooks?.snapshotDelete,
        snapshotRestore: snapshotHooks?.snapshotRestore,
        resourceCapabilities: snapshotHooks?.resourceCapabilities,
        imageBuild: options.imageBuild ? imageBuild : undefined,
        processes,
        scope: bindingScope,
        supports: {
          images: ["prepared"],
          network: caps.networkPolicies,
          exec: { commands: ["argv", "shell"], maxOutputBytes: caps.maxOutputBytes },
          fileWrite: { overwrite: true, noClobber: true },
          createEnv: true,
          lifetime: { minSeconds: 1, maxSeconds: 86_400 },
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
              throw new AdapterError("UNSUPPORTED", result.reason ?? "Fake image is unsupported");

            return {
              image: result.effectiveImage,
              networkPolicy: input.networkPolicy,
              labels: input.labels,
              env: input.env,
              lifetimeSeconds: input.lifetimeSeconds,
            };
          },
          async submit(input, ctx) {
            return createResult(
              await driver.create({
                scope,
                identity: identity(ctx),
                image: input.image,
                networkPolicy: input.networkPolicy,
                labels: input.labels,
                env: input.env,
                lifetimeSeconds: input.lifetimeSeconds,
              }),
              ctx,
              bindingScope,
            );
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            return result ? observedCreate(result, ctx, attempt, bindingScope) : null;
          },
        },
        async reopen(reference) {
          const observation = await driver.inspect(native(reference.nativeId));

          if (!observation || observation.state === "destroyed")
            throw new AdapterError("NOT_FOUND", "Fake sandbox does not exist");

          return { reference, ...info(observation) };
        },
        destroy: {
          async submit(box, ctx) {
            const result = await driver.destroy({
              sandbox: native(box.id),
              identity: identity(ctx),
            });

            if (result.status === "completed") {
              if (result.value.kind !== "destroy" || !result.value.observation.computeStopped)
                return ctx.unknown("Fake destroy did not confirm compute stop");

              return {
                computeStopped: true,
                retainedResources: result.value.observation.retainedResources,
              };
            }

            return failure(result, ctx);
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            if (!result) return null;

            if (
              result.status === "completed" &&
              result.value.kind === "destroy" &&
              result.value.observation.computeStopped &&
              result.value.observation.sandbox.nativeId === attempt.sandbox?.id
            )
              return {
                computeStopped: true,
                retainedResources: result.value.observation.retainedResources,
              };

            return ctx.unknown("Fake destroy observation was not confirmed");
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
        async sandboxList(input) {
          const page = await driver.inventory({ scope, cursor: input.cursor, limit: input.limit });

          return {
            // The fake lists every sandbox in its scope and records no creation correlation, so
            // references carry no receipt and claim no ownership.
            coverage: "provider-scope" as const,
            items: page.items.map((item) => ({
              id: item.ref.nativeId,
              state: item.state,
              reference: {
                version: 1 as const,
                kind: "sandbox" as const,
                provider: "fake",
                scope: bindingScope,
                nativeId: item.ref.nativeId,
                ownership: "unknown" as const,
              },
            })),
            nextCursor: page.nextCursor,
          };
        },
        exec: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            const result = await driver.exec({
              sandbox: native(input.sandbox.id),
              identity: identity(ctx),
              command: input.command,
              cwd: input.cwd,
              env: input.env,
              deadlineSeconds: input.deadlineSeconds,
              maxOutputBytes: input.maxOutputBytes,
            });

            if (result.status === "completed") {
              if (result.value.kind !== "execution" || !result.value.observation.completed)
                return ctx.unknown("Fake execution did not complete");
              const output = result.value.observation;

              return {
                exitCode: output.exitCode ?? null,
                stdout: bytes(output.stdoutBase64),
                stderr: bytes(output.stderrBase64),
                truncated: output.truncated ?? false,
              };
            }

            if (result.status === "pending")
              return ctx.pending(
                { submissionId: ctx.submissionId },
                { pollAfterMs: result.observeAfterMs },
              );

            return failure(result, ctx);
          },
          async observe(attempt, ctx) {
            const result = await driver.observe({
              scope,
              submissionId: attempt.submissionId,
              operationId: attempt.operationId,
            });

            if (!result) return null;

            if (
              result.status === "completed" &&
              result.value.kind === "execution" &&
              result.value.observation.completed &&
              result.value.observation.sandbox.nativeId === attempt.sandbox?.id
            ) {
              const output = result.value.observation;

              return {
                exitCode: output.exitCode ?? null,
                stdout: bytes(output.stdoutBase64),
                stderr: bytes(output.stderrBase64),
                truncated: output.truncated ?? false,
              };
            }

            if (result.status === "pending")
              return ctx.pending(
                { submissionId: attempt.submissionId },
                { pollAfterMs: result.observeAfterMs },
              );

            return ctx.unknown("Fake execution observation was not confirmed");
          },
        },
        files: {
          maxBytes: caps.maxFileBytes,
          async read(input) {
            return driver.readFile({ sandbox: native(input.sandbox.id), path: input.path });
          },
          write: {
            recovery: { version: 1, token: Token },
            async submit(input, ctx) {
              const result = await driver.writeFile({
                sandbox: native(input.sandbox.id),
                identity: identity(ctx),
                path: input.path,
                bytes: input.bytes,
                overwrite: input.overwrite,
              });

              if (result.status === "completed") {
                if (result.value.kind !== "file_write" || !result.value.observation.complete)
                  return ctx.unknown("Fake file write was not confirmed");

                return { bytesWritten: result.value.observation.bytesWritten };
              }

              if (result.status === "pending")
                return ctx.pending(
                  { submissionId: ctx.submissionId },
                  { pollAfterMs: result.observeAfterMs },
                );

              return failure(result, ctx);
            },
            async observe(attempt, ctx) {
              const result = await driver.observe({
                scope,
                submissionId: attempt.submissionId,
                operationId: attempt.operationId,
              });

              if (!result) return null;

              if (
                result.status === "completed" &&
                result.value.kind === "file_write" &&
                result.value.observation.complete &&
                result.value.observation.sandbox.nativeId === attempt.sandbox?.id
              )
                return { bytesWritten: result.value.observation.bytesWritten };

              if (result.status === "pending")
                return ctx.pending(
                  { submissionId: attempt.submissionId },
                  { pollAfterMs: result.observeAfterMs },
                );

              return ctx.unknown("Fake file-write observation was not confirmed");
            },
          },
        },
      };
    },
  });
}
