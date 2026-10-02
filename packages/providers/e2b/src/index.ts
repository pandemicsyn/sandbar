import { z } from "zod";
import { e2bState } from "./state-native";
import {
  RenewRequest,
  PreviewPort,
  ResolvedRenewInput,
  sandboxReference,
  assertSandboxReference,
  assertResourceScope,
  unknownSandboxFacts,
  nativeDeadline,
  type SandboxInfo,
  type SandboxReference,
} from "sandbar-adapter";
import { createHash } from "node:crypto";
import {
  MountDurability as importMountDurability,
  AdapterError,
  AdapterCheckpointError,
  ResourceReference,
  type OperationOutcome,
  defineAdapter,
  type ExecValue,
  type Json,
} from "sandbar-adapter";
import {
  E2BRenewRejected,
  createSdkTransport,
  E2B_ENDPOINT,
  MAX_BYTES,
  shellQuote,
  type E2BRecord,
  type E2BTransport,
} from "./transport";

import { classifyWriteFailure, WriteFailure, writeFailureReason } from "./write-failure";

const CreateToken = z.strictObject({
  allowPublicTraffic: z.boolean(),
  sandboxId: z.string().min(1).max(512).optional(),
});

const CreateRecoveryToken: z.ZodType<Json> = CreateToken;

const Configuration = z
  .strictObject({
    teamId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    templateId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?(?::default)?$/)
      .default("base"),
    timeoutSeconds: z.number().int().min(60).max(3600).optional(),
    preview: z
      .strictObject({ access: z.enum(["protected", "public"]).default("protected") })
      .default({ access: "protected" }),
    lifecycle: z
      .strictObject({ lifetimeSeconds: z.number().int().positive().safe().max(3600).optional() })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.lifecycle?.lifetimeSeconds !== undefined && value.timeoutSeconds !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle", "lifetimeSeconds"],
        message: "Supply one lifetime option",
      });
  })
  .transform((value) => ({
    ...value,
    timeoutSeconds:
      value.lifecycle?.lifetimeSeconds === undefined
        ? (value.timeoutSeconds ?? 300)
        : Math.max(60, value.lifecycle.lifetimeSeconds),
  }));

const RenewToken = z.strictObject({ acknowledged: z.literal(true) });

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

const ExecToken = z.strictObject({
  maxOutputBytes: z.number().int().min(0).max(MAX_BYTES),
});

const WriteToken = z.strictObject({
  path: z.string().max(4096),
  staged: z.string().max(4096).optional(),
  bytesWritten: z.number().int().min(0).max(MAX_BYTES),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  failure: WriteFailure.optional(),
});

type WriteTokenData = z.infer<typeof WriteToken>;

const DestroyToken = z.strictObject({
  stage: z.enum(["uncertain", "accepted", "rejected"]),
  sandboxId: z.string().min(1).max(512).optional(),
  rejectionCode: z.enum(["UNAVAILABLE", "CAPACITY"]).optional(),
  retainedTemplateId: z.string().max(128).optional(),
  retainedVolumeNames: z.array(z.string().min(1).max(128)).max(32).optional(),
  mountDurability: z.array(importMountDurability).max(32).optional(),
});

function destroyToken(record: E2BRecord, sandboxId: string): z.infer<typeof DestroyToken> {
  const token: z.infer<typeof DestroyToken> = {
    stage: "uncertain",
    sandboxId,
  };

  if (record.volumeMounts?.length) {
    // Native mount observations expose reusable names, never immutable volume IDs.
    token.retainedVolumeNames = record.volumeMounts.map((mount) => mount.name);
  }

  if (record.metadata.sandbar_build) token.retainedTemplateId = record.templateId;

  const rejected: z.infer<typeof DestroyToken> = {
    ...token,
    stage: "rejected",
    rejectionCode: "UNAVAILABLE",
  };

  if (
    !DestroyToken.safeParse(token).success ||
    !DestroyToken.safeParse(rejected).success ||
    new TextEncoder().encode(JSON.stringify(rejected)).length > 4096
  )
    throw new AdapterError("CAPACITY", "E2B destroy custody exceeds recovery token bound");

  return token;
}

function destroyValue(token: z.infer<typeof DestroyToken>): import("sandbar-adapter").DestroyValue {
  const value: import("sandbar-adapter").DestroyValue = {
    computeStopped: true,
    retainedResources: [
      ...(token.retainedTemplateId ? [`e2b-template:${token.retainedTemplateId}`] : []),
      ...(token.mountDurability?.map((mount) => `e2b-volume:${mount.volume.nativeId}`) ?? []),
      ...(token.retainedVolumeNames?.map((name) => `e2b-volume-name:${name}`) ?? []),
    ],
  };

  if (token.mountDurability?.length) value.mountDurability = token.mountDurability;

  return value;
}

function destroyOutcome(
  token: z.infer<typeof DestroyToken>,
): Extract<OperationOutcome, { kind: "destroy" }> {
  return {
    kind: "destroy",
    status: "unknown",
    retainedVolumes:
      token.mountDurability?.map((mount) =>
        ResourceReference.extend({ kind: z.literal("volume") }).parse(mount.volume),
      ) ?? [],
  };
}

const nativeId = /^[A-Za-z0-9_-]{1,128}$/;

const ownerKeys = [
  "sandbar_scope",
  "sandbar_submission",
  "sandbar_operation",
  "sandbar_template",
  "sandbar_build",
  "sandbar_snapshot",
];

function buildName(submissionId: string): string {
  return `sandbar-${createHash("sha256").update(submissionId).digest("hex").slice(0, 40)}`;
}

function requirePath(path: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.length > 4096)
    throw new AdapterError("INVALID_ARGUMENT", "E2B requires a bounded absolute path");
}

function executionPaths(submissionId: string) {
  if (!nativeId.test(submissionId))
    throw new AdapterError("INVALID_ARGUMENT", "Invalid submission ID");
  const base = `/tmp/.sandbar-${submissionId}`;

  return {
    stdout: `${base}.stdout`,
    stderr: `${base}.stderr`,
    status: `${base}.status`,
  };
}

/** The E2B definition uses the same public adapter contract as external adapters. */
export function createE2BAdapter(transportFactory?: (options: { apiKey: string }) => E2BTransport) {
  return defineAdapter({
    name: "e2b",
    displayName: "E2B",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      const transport = transportFactory?.(credentials) ?? createSdkTransport(credentials.apiKey);
      host.onClose(() => transport.close());

      const verifyAuthority = () =>
        config.teamId ? transport.verifyTeam(config.teamId) : transport.verifyAuth();

      await verifyAuthority();

      if (config.templateId !== "base")
        await transport.verifyTemplate(config.teamId, config.templateId);

      // The authenticated read proves this credential works, not its native team identity.
      const authority = config.teamId
        ? { kind: "team", id: config.teamId }
        : {
            kind: "api-key",
            id: createHash("sha256")
              .update("sandbar:e2b:api-key-scope:v1\0")
              .update(credentials.apiKey)
              .digest("hex"),
          };

      const scopeMarker = config.teamId
        ? `${config.teamId}:${config.templateId}`
        : `api-key:${authority.id}:${config.templateId}`;

      const owned = (record: E2BRecord) =>
        nativeId.test(record.id) &&
        nativeId.test(record.templateId) &&
        record.metadata.sandbar_scope === scopeMarker &&
        nativeId.test(record.metadata.sandbar_submission ?? "") &&
        nativeId.test(record.metadata.sandbar_operation ?? "") &&
        ((!!record.metadata.sandbar_snapshot &&
          record.metadata.sandbar_snapshot.startsWith(`${record.templateId}:`) &&
          z.uuid().safeParse(record.metadata.sandbar_snapshot.slice(record.templateId.length + 1))
            .success &&
          record.metadata.sandbar_snapshot === record.metadata.sandbar_template) ||
          record.metadata.sandbar_template === record.templateId ||
          (record.metadata.sandbar_template === "base" && !record.metadata.sandbar_build));

      const assertRecordReference = (
        record: E2BRecord,
        id: string,
        expected?: SandboxReference,
      ) => {
        if (expected) {
          if (record.id !== id || !owned(record))
            throw new AdapterError("CONFLICT", "E2B sandbox identity or scope differs");
          assertSandboxReference(
            sandboxReference("e2b", boundScope, record.id, {
              operation: record.metadata.sandbar_operation!,
              submission: record.metadata.sandbar_submission!,
            }),
            expected,
          );
        }
      };

      const find = async (id: string, expected?: SandboxReference): Promise<E2BRecord | null> => {
        if (!nativeId.test(id))
          throw new AdapterError("INVALID_ARGUMENT", "Invalid E2B sandbox ID");
        await verifyAuthority();
        const record = await transport.get(id);

        if (record) assertRecordReference(record, id, expected);

        return record && owned(record) ? record : null;
      };

      const inspection = async (
        id: string,
        expected?: SandboxReference,
        renewalPolicy = false,
      ): Promise<SandboxInfo> => {
        let record;

        try {
          await verifyAuthority();
          record = await transport.get(id);

          if (record && (record.id !== id || !owned(record)))
            throw new AdapterError(
              "CONFLICT",
              "E2B native identity, scope, or creation markers differ",
            );
        } catch (error) {
          if (error instanceof AdapterError) throw error;
          throw new AdapterError("UNAVAILABLE", "E2B native detail is unavailable");
        }

        if (!record)
          throw new AdapterError("NOT_FOUND", "E2B sandbox is missing, expired, or deleted");

        const reference = sandboxReference("e2b", boundScope, record.id, {
          operation: record.metadata.sandbar_operation!,
          submission: record.metadata.sandbar_submission!,
        });

        if (expected) assertSandboxReference(reference, expected);

        if (
          renewalPolicy &&
          (record.lifecycle?.onTimeout !== "kill" || record.lifecycle?.autoResume !== false)
        )
          throw new AdapterError(
            "UNAVAILABLE",
            "E2B renewal requires known kill-on-timeout with auto-resume off",
          );

        return {
          ...unknownSandboxFacts(),
          reference,
          observedAt: new Date().toISOString(),
          nativeState: record.state,
          state:
            record.state === "running"
              ? "running"
              : record.state === "paused"
                ? "suspended"
                : "unknown",
          expires:
            record.state === "paused"
              ? { status: "none" }
              : nativeDeadline(record.endAt, "running-session"),
          retention:
            record.state === "paused"
              ? { status: "known", value: { autoDeleteAfterStoppedSeconds: null } }
              : unknownSandboxFacts().retention,
        };
      };

      const requireRunning = async (
        id: string,
        expected?: SandboxReference,
      ): Promise<E2BRecord> => {
        const record = await find(id, expected);

        if (!record)
          throw new AdapterError("NOT_FOUND", "E2B sandbox is outside the verified scope");

        if (record.state !== "running")
          throw new AdapterError("UNAVAILABLE", "E2B sandbox is paused");

        if (record.attachmentReady === false)
          throw new AdapterError("UNAVAILABLE", "E2B read-only guest attachment is unavailable");

        return record;
      };

      const cleanup = async (id: string, paths: ReturnType<typeof executionPaths>) => {
        await Promise.allSettled(Object.values(paths).map((path) => transport.remove(id, path)));
      };

      const readExecution = async (
        id: string,
        paths: ReturnType<typeof executionPaths>,
        maxOutputBytes: number,
      ): Promise<ExecValue | null> => {
        let status: { bytes: Uint8Array; truncated: boolean };

        try {
          status = await transport.read(id, paths.status, 16);
        } catch {
          return null;
        }

        const code = new TextDecoder("utf-8", { fatal: true }).decode(status.bytes);

        if (status.truncated || !/^(?:0|[1-9][0-9]{0,2})$/.test(code))
          throw new Error("E2B command completion marker is invalid");
        const stdout = await transport.read(id, paths.stdout, maxOutputBytes);
        const remaining = maxOutputBytes - stdout.bytes.length;
        const stderr = await transport.read(id, paths.stderr, remaining);

        return {
          exitCode: Number(code),
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          truncated: stdout.truncated || stderr.truncated,
        };
      };

      const boundScope = {
        authority,
        partition: { endpoint: E2B_ENDPOINT, template: config.templateId },
      };

      const resources = e2bState({
        scope: boundScope,
        transport,
        scopeMarker,
        timeoutSeconds: config.timeoutSeconds,
        apiKey: credentials.apiKey,
        allowPublicTraffic: config.preview.access === "public",
        find,
      });

      return {
        ...resources.fields,
        scope: {
          authority,
          partition: { endpoint: E2B_ENDPOINT, template: config.templateId },
        },
        async preview(input, ctx) {
          if (!PreviewPort.safeParse(input.port).success)
            throw new AdapterError(
              "INVALID_ARGUMENT",
              "Preview port must be an integer from 1 through 65535",
            );

          if (config.preview.access !== "public")
            throw new AdapterError(
              "UNSUPPORTED",
              "E2B protected preview credentials cannot be retrieved read-only after reopening; select preview.access public explicitly or use Daytona protected previews",
            );
          ctx.signal.throwIfAborted();
          const record = await find(input.sandbox.id, input.sandbox.reference);

          if (!record)
            throw new AdapterError("NOT_FOUND", "E2B sandbox is outside the verified scope");

          if (record.id !== input.sandbox.id)
            throw new AdapterError("CONFLICT", "E2B preview response identity differs");

          if (record.state !== "running")
            throw new AdapterError(
              "UNAVAILABLE",
              "E2B preview requires running compute; resume explicitly before requesting access",
            );
          ctx.signal.throwIfAborted();

          if (
            record.allowPublicTraffic !== true ||
            record.domain !== "e2b.app" ||
            record.lifecycle?.autoResume !== false
          )
            throw new AdapterError(
              "UNAVAILABLE",
              "E2B public preview requires confirmed public traffic, e2b.app domain, and auto-resume off",
            );

          return { access: "public" as const, url: `https://${input.port}-${record.id}.e2b.app` };
        },
        supports: {
          images: ["prepared", "oci"],
          network: ["internet", "blocked"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
        },
        imageBuild: {
          async prepare(input) {
            await verifyAuthority();

            return input;
          },
          async submit(input, ctx) {
            if (!nativeId.test(ctx.submissionId))
              return ctx.reject("INVALID_ARGUMENT", "Invalid E2B build submission ID");

            const name = buildName(ctx.submissionId);

            try {
              if (await transport.findBuild(config.teamId, name))
                return ctx.unknown(`E2B image build ${name} already exists; no build was replayed`);

              if (ctx.signal.aborted)
                return ctx.unknown(`E2B image build ${name} was not submitted after cancellation`);

              const build = await transport.buildImage(input.source.value, name);

              if (!nativeId.test(build.templateId))
                return ctx.unknown(`E2B image build ${name} returned an invalid template ID`);

              if (ctx.signal.aborted)
                return ctx.unknown(`E2B image build ${name} outcome after cancellation is unknown`);

              const observed = await transport.findBuild(config.teamId, name);

              if (
                !observed ||
                observed.templateId !== build.templateId ||
                observed.status !== "ready"
              )
                return ctx.unknown(`E2B image build ${name} could not be confirmed ready`);

              return {
                preparedId: build.templateId,
                retainedResources: [
                  {
                    kind: "e2b-template",
                    id: build.templateId,
                    ownership: "unknown" as const,
                    cleanup: "manual" as const,
                  },
                ],
              };
            } catch {
              return ctx.unknown(`E2B image build ${name} outcome unavailable; observe only`);
            }
          },
          async observe(attempt, ctx) {
            await verifyAuthority();
            const build = await transport.findBuild(config.teamId, buildName(attempt.submissionId));

            if (!build) return null;

            if (build.status !== "ready")
              return ctx.unknown(`E2B image build ${build.templateId} is ${build.status}`);

            return {
              preparedId: build.templateId,
              retainedResources: [
                {
                  kind: "e2b-template",
                  id: build.templateId,
                  ownership: "unknown" as const,
                  cleanup: "manual" as const,
                },
              ],
            };
          },
        },
        create: {
          recovery: { version: 1, token: CreateRecoveryToken },
          async prepare(input) {
            if (input.mounts?.length)
              throw new AdapterError(
                "UNSUPPORTED",
                "E2B cannot bind mount names to immutable volume IDs",
              );

            if (input.region)
              throw new AdapterError("UNSUPPORTED", "E2B region selection is unavailable");

            if (input.networkPolicy !== "internet" && input.networkPolicy !== "blocked")
              throw new AdapterError("UNSUPPORTED", "E2B network policy is unsupported");

            if (input.labels && Object.keys(input.labels).some((key) => ownerKeys.includes(key)))
              throw new AdapterError("INVALID_ARGUMENT", "Reserved E2B metadata key");
            await verifyAuthority();

            if (input.image.kind === "prepared" && input.image.value !== "base") {
              const templateId = await transport.verifyTemplate(config.teamId, input.image.value);

              if (!nativeId.test(templateId))
                throw new AdapterError("INVALID_ARGUMENT", "E2B returned an invalid template ID");

              return { ...input, image: { ...input.image, value: templateId } };
            }

            return input;
          },
          async submit(input, ctx) {
            if (input.mounts?.length)
              return ctx.reject(
                "UNSUPPORTED",
                "E2B cannot bind mount names to immutable volume IDs",
              );

            if (!nativeId.test(ctx.submissionId) || !nativeId.test(ctx.operationId))
              return ctx.reject("INVALID_ARGUMENT", "Invalid E2B correlation ID");

            const token: z.infer<typeof CreateToken> = {
              allowPublicTraffic: config.preview.access === "public",
            };

            await ctx.checkpoint(token);

            let templateId =
              input.image.kind === "prepared" ? input.image.value : config.templateId;

            const name = input.image.kind === "oci" ? buildName(ctx.submissionId) : undefined;

            if (name) {
              try {
                if (await transport.findBuild(config.teamId, name))
                  return ctx.unknown(
                    `E2B image build name ${name} already exists; no build was resubmitted`,
                  );

                if (ctx.signal.aborted)
                  return ctx.unknown(
                    `E2B image build ${name} was not submitted after cancellation`,
                  );

                const build = await transport.buildImage(input.image.value, name);

                if (!nativeId.test(build.templateId))
                  return ctx.unknown(`E2B image build ${name} returned an invalid template ID`);

                if (ctx.signal.aborted)
                  return ctx.unknown(
                    `E2B image build ${name} outcome after cancellation is unknown`,
                  );

                const observed = await transport.findBuild(config.teamId, name);

                if (
                  !observed ||
                  observed.templateId !== build.templateId ||
                  observed.status !== "ready"
                )
                  return ctx.unknown(`E2B image build ${name} could not be confirmed ready`);
                templateId = build.templateId;
              } catch {
                return ctx.unknown(
                  `E2B image build ${name} outcome unavailable; inspect template before a new create`,
                );
              }
            }

            if (ctx.signal.aborted)
              return ctx.unknown("E2B sandbox create was not submitted after cancellation");

            try {
              const metadata = {
                ...input.labels,
                sandbar_scope: scopeMarker,
                sandbar_submission: ctx.submissionId,
                sandbar_operation: ctx.operationId,
                sandbar_template: templateId,
              };

              if (name) Object.assign(metadata, { sandbar_build: name });

              const id = await transport.create({
                templateId,
                timeoutMs: config.timeoutSeconds * 1000,
                allowInternetAccess: input.networkPolicy === "internet",
                allowPublicTraffic: token.allowPublicTraffic,
                metadata,
                signal: ctx.signal,
              });

              if (!nativeId.test(id)) return ctx.unknown("E2B create returned an invalid ID");
              token.sandboxId = id;
              await ctx.checkpoint(token);
              const record = await transport.get(id);

              if (
                !record ||
                record.id !== id ||
                !owned(record) ||
                record.metadata.sandbar_submission !== ctx.submissionId ||
                record.metadata.sandbar_operation !== ctx.operationId
              )
                return ctx.unknown("E2B create identity could not be verified");

              if (record.allowPublicTraffic !== token.allowPublicTraffic)
                return ctx.unknown(
                  "E2B create inbound visibility could not be verified; no replay",
                );

              return {
                id,
                reference: sandboxReference("e2b", boundScope, id, {
                  operation: record.metadata.sandbar_operation!,
                  submission: record.metadata.sandbar_submission!,
                }),
                mounts: input.mounts,
                state: record.state === "running" ? ("running" as const) : ("unknown" as const),
              };
            } catch (error) {
              if (error instanceof AdapterCheckpointError) throw error;

              return ctx.unknown(
                `E2B create response unavailable; observe without replay${name ? `; retained template ${templateId}` : ""}`,
              );
            }
          },
          async observe(attempt, ctx) {
            const token = CreateToken.safeParse(attempt.token);

            if (!token.success)
              return ctx.unknown(
                "Original E2B create inbound visibility is unavailable; no replay",
              );
            await verifyAuthority();

            let id = token.data.sandboxId;

            if (!id) {
              const page = await transport.list(
                {
                  sandbar_scope: scopeMarker,
                  sandbar_submission: attempt.submissionId,
                  sandbar_operation: attempt.operationId,
                },
                2,
              );

              const matches = page.items.filter(
                (record) =>
                  owned(record) &&
                  record.metadata.sandbar_submission === attempt.submissionId &&
                  record.metadata.sandbar_operation === attempt.operationId,
              );

              if (matches.length !== 1 || page.nextToken) {
                const build = await transport.findBuild(
                  config.teamId,
                  buildName(attempt.submissionId),
                );

                return build
                  ? ctx.unknown(
                      `E2B image build ${build.templateId} is ${build.status}; no sandbox was confirmed`,
                    )
                  : null;
              }

              id = matches[0]!.id;
            }

            const record = await transport.get(id);

            if (
              !record ||
              record.id !== id ||
              !owned(record) ||
              record.metadata.sandbar_submission !== attempt.submissionId ||
              record.metadata.sandbar_operation !== attempt.operationId
            )
              return ctx.unknown("Recovered E2B create identity could not be verified");

            if (record.allowPublicTraffic !== token.data.allowPublicTraffic)
              return ctx.unknown(
                "Recovered E2B create inbound visibility is unverified; no replay",
              );

            if (attempt.mounts?.length)
              return ctx.unknown("Recovered native volume IDs cannot be confirmed; no replay");

            return {
              id: record.id,
              reference: sandboxReference("e2b", boundScope, record.id, {
                operation: record.metadata.sandbar_operation!,
                submission: record.metadata.sandbar_submission!,
              }),
              mounts: attempt.mounts,
              state: record.state === "running" ? ("running" as const) : ("unknown" as const),
            };
          },
        },
        destroy: {
          recovery: { version: 2, token: DestroyToken },
          async prepare(box) {
            const record = await find(box.id, box.reference);

            if (!record)
              throw new AdapterError("NOT_FOUND", "E2B sandbox is outside the verified scope");

            if (record.volumeMounts?.length && box.storage !== "allow-unconfirmed")
              throw new AdapterError(
                "UNSUPPORTED",
                "Writable shutdown durability is unverified; explicit allow-unconfirmed required",
              );

            destroyToken(record, box.id);

            return box;
          },
          async submit(box, ctx) {
            const record = await find(box.id, box.reference);

            if (!record)
              return ctx.reject("NOT_FOUND", "E2B sandbox is outside the verified scope");

            if (record.volumeMounts?.length && box.storage !== "allow-unconfirmed")
              return ctx.reject("UNSUPPORTED", "Writable cleanup durability is unverified");

            let token: z.infer<typeof DestroyToken>;

            try {
              token = destroyToken(record, box.id);
            } catch (error) {
              if (!(error instanceof AdapterError) || error.code !== "CAPACITY") throw error;
              await ctx.checkpoint({
                stage: "rejected",
                sandboxId: box.id,
                rejectionCode: "CAPACITY",
              });

              return ctx.reject("CAPACITY", error.message);
            }

            try {
              await ctx.checkpoint(token);
            } catch (error) {
              if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
              throw error;
            }

            if (ctx.signal.aborted) {
              token.stage = "rejected";
              token.rejectionCode = "UNAVAILABLE";

              try {
                await ctx.checkpoint(token);
              } catch (error) {
                if (error instanceof AdapterCheckpointError) error.outcome = destroyOutcome(token);
                throw error;
              }

              return ctx.reject("UNAVAILABLE", "E2B termination cancelled before dispatch");
            }

            if (box.reference) await find(box.id, box.reference);

            try {
              await transport.kill(box.id, ctx.signal);
              token.stage = "accepted";
              await ctx.checkpoint(token);

              if ((await transport.get(box.id)) === null) return destroyValue(token);
            } catch (error) {
              if (error instanceof AdapterCheckpointError) {
                error.outcome = destroyOutcome(token);
                throw error;
              }
              // An absent sandbox may still be confirmed by read-only observation.
            }

            return ctx.pending(token, { pollAfterMs: 1000 });
          },
          async observe(attempt, ctx) {
            if (!attempt.sandbox) return null;
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success) return ctx.unknown("E2B destroy lacks retained-resource evidence");

            if (token.data.sandboxId && token.data.sandboxId !== attempt.sandbox.id)
              return ctx.unknown("E2B destroy checkpoint identity differs");

            if (token.data.stage === "rejected")
              return ctx.unknown(
                "Termination cancelled before dispatch; continue to confirm no effect",
              );
            let record: E2BRecord | null;

            try {
              await verifyAuthority();
              record = await transport.get(attempt.sandbox.id);

              if (record)
                assertRecordReference(record, attempt.sandbox.id, attempt.sandbox.reference);
            } catch {
              return ctx.unknown(
                "E2B compute observation is unavailable; termination cannot be replayed",
                destroyOutcome(token.data),
              );
            }

            if (record) {
              if (!owned(record))
                return ctx.unknown(
                  "E2B destroy scope no longer matches",
                  destroyOutcome(token.data),
                );

              return ctx.pending(token.data, { pollAfterMs: 1000 });
            }

            return destroyValue(token.data);
          },
          async continue(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (
              token.success &&
              token.data.stage === "rejected" &&
              token.data.sandboxId === attempt.sandbox?.id
            )
              return ctx.reject(
                token.data.rejectionCode ?? "UNAVAILABLE",
                "E2B termination rejected before dispatch",
              );

            return ctx.unknown(
              "E2B termination cannot be replayed",
              token.success ? destroyOutcome(token.data) : undefined,
            );
          },
        },
        async renewCapabilities(target) {
          if (!transport.renew)
            return { status: "unsupported" as const, reason: "Renewal transport is not mapped" };

          if (
            target.sandbox &&
            (await inspection(target.sandbox.id, target.sandbox.reference, true)).state !==
              "running"
          )
            return { status: "unavailable" as const, reason: "Renewal requires running compute" };

          return {
            status: "supported" as const,
            value: {
              minSeconds: 60,
              maxSeconds: 3600,
              stepSeconds: 1,
              scope: "running-session" as const,
            },
          };
        },
        renew: transport.renew
          ? {
              recovery: { version: 1, token: RenewToken },
              async prepare(input) {
                assertResourceScope(input.sandbox.reference, {
                  provider: "e2b",
                  scope: boundScope,
                });

                const requested = RenewRequest.parse({
                  forSeconds: input.forSeconds ?? config.timeoutSeconds,
                }).forSeconds;

                if (requested > 3600)
                  throw new AdapterError(
                    "INVALID_ARGUMENT",
                    "Renewal exceeds the adapter lifetime ceiling",
                  );
                const forSeconds = Math.max(60, requested);
                const info = await inspection(input.sandbox.id, input.sandbox.reference, true);

                if (info.state !== "running")
                  throw new AdapterError("UNAVAILABLE", "Renewal requires running compute");

                return ResolvedRenewInput.parse({ ...input, forSeconds });
              },
              async submit(input, ctx) {
                if (ctx.signal.aborted)
                  return ctx.reject("UNAVAILABLE", "Renewal cancelled before dispatch");

                try {
                  await transport.renew!(input.sandbox.id, input.forSeconds, ctx.signal);
                } catch (error) {
                  if (error instanceof E2BRenewRejected)
                    return ctx.reject(error.code, error.message);

                  return ctx.unknown(
                    "E2B renewal acknowledgement was lost; never replay this reset",
                    {
                      kind: "sandbox_renew",
                      status: "unknown",
                      reference: input.sandbox.reference,
                      requested: { forSeconds: input.forSeconds },
                      observation: await inspection(
                        input.sandbox.id,
                        input.sandbox.reference,
                      ).catch(() => null),
                    },
                  );
                }

                // One effect is complete. A failed compatibility save cannot erase its ACK.
                try {
                  await ctx.checkpoint({ acknowledged: true });
                } catch {
                  /* Return the confirmed result below. */
                }

                const observation = await inspection(
                  input.sandbox.id,
                  input.sandbox.reference,
                ).catch(() => null);

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
                  provider: "e2b",
                  scope: boundScope,
                });
                const acknowledged = RenewToken.safeParse(attempt.token).success;

                const observation = await inspection(
                  attempt.sandbox.id,
                  attempt.sandbox.reference,
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
            }
          : undefined,
        async reopen(reference) {
          assertResourceScope(reference, { provider: "e2b", scope: boundScope });

          return inspection(reference.nativeId, reference);
        },
        async inspect(box) {
          return { id: box.id, ...(await inspection(box.id, box.reference)) };
        },
        async inventory(input) {
          await verifyAuthority();

          const page = await transport.list(
            { sandbar_scope: scopeMarker },
            input.limit,
            input.cursor,
          );

          const items = page.items.filter(owned).map((record) => ({
            id: record.id,
            state: record.state === "running" ? ("running" as const) : ("unknown" as const),
          }));

          return { items, nextCursor: page.nextToken };
        },
        processes: transport.startText
          ? {
              async start(input, ctx) {
                await requireRunning(input.sandbox.id, input.sandbox.reference);

                if (ctx.signal.aborted)
                  throw new AdapterError("UNAVAILABLE", "Process setup stopped");

                const command =
                  input.command.kind === "argv"
                    ? `/bin/bash -c 'exec "$@"' sandbar ${input.command.argv.map(shellQuote).join(" ")}`
                    : `/bin/bash -c ${shellQuote(input.command.script)}`;

                return transport.startText!(
                  input.sandbox.id,
                  command,
                  { cwd: input.cwd, env: input.env },
                  ctx,
                );
              },
            }
          : undefined,
        exec: {
          recovery: {
            version: 1,
            token: ExecToken,
          },
          async prepare(input) {
            await requireRunning(input.sandbox.id, input.sandbox.reference);

            if (
              input.command.kind === "argv" &&
              (!input.command.argv.length || input.command.argv.some((part) => part.includes("\0")))
            )
              throw new AdapterError("INVALID_ARGUMENT", "E2B argv is invalid");

            if (input.command.kind === "shell" && input.command.script.includes("\0"))
              throw new AdapterError("INVALID_ARGUMENT", "E2B shell script is invalid");

            if (input.cwd) requirePath(input.cwd);

            if (input.maxOutputBytes > MAX_BYTES)
              throw new AdapterError("CAPACITY", "E2B command output bound exceeded");

            return input;
          },
          async submit(input, ctx) {
            await requireRunning(input.sandbox.id, input.sandbox.reference);
            const paths = executionPaths(ctx.submissionId);

            if (ctx.signal.aborted)
              return ctx.pending({ maxOutputBytes: input.maxOutputBytes }, { pollAfterMs: 1000 });

            const command =
              input.command.kind === "argv"
                ? `/bin/bash -c 'exec "$@"' sandbar ${input.command.argv.map(shellQuote).join(" ")}`
                : `/bin/bash -c ${shellQuote(input.command.script)}`;

            const script = `${command} >${shellQuote(paths.stdout)} 2>${shellQuote(paths.stderr)}; printf '%s' "$?" >${shellQuote(paths.status)}`;

            try {
              await transport.run(input.sandbox.id, script, {
                cwd: input.cwd,
                env: input.env,
                timeoutMs: Math.max(1, Math.min(input.deadlineSeconds * 1000, 86_400_000)),
              });

              if (ctx.signal.aborted)
                return ctx.pending({ maxOutputBytes: input.maxOutputBytes }, { pollAfterMs: 1000 });

              const result = await readExecution(input.sandbox.id, paths, input.maxOutputBytes);

              if (!result)
                return ctx.pending({ maxOutputBytes: input.maxOutputBytes }, { pollAfterMs: 1000 });

              if (ctx.signal.aborted)
                return ctx.pending({ maxOutputBytes: input.maxOutputBytes }, { pollAfterMs: 1000 });

              await cleanup(input.sandbox.id, paths);

              return result;
            } catch {
              return ctx.pending({ maxOutputBytes: input.maxOutputBytes }, { pollAfterMs: 1000 });
            }
          },
          async observe(attempt) {
            if (!attempt.sandbox) return null;

            const token = ExecToken.safeParse(attempt.token);

            if (!token.success) return null;
            await requireRunning(attempt.sandbox.id, attempt.sandbox.reference);
            const paths = executionPaths(attempt.submissionId);

            return readExecution(attempt.sandbox.id, paths, token.data.maxOutputBytes);
          },
        },
        files: {
          maxBytes: MAX_BYTES,
          async read(input, ctx) {
            requirePath(input.path);
            await requireRunning(input.sandbox.id, input.sandbox.reference);
            ctx.signal.throwIfAborted();

            const result = await transport.read(
              input.sandbox.id,
              input.path,
              MAX_BYTES,
              ctx.signal,
            );

            if (result.truncated)
              throw new AdapterError("CAPACITY", "E2B file exceeds the read bound");

            return result.bytes;
          },
          write: {
            recovery: { version: 1, token: WriteToken },
            async prepare(input) {
              requirePath(input.path);
              await requireRunning(input.sandbox.id, input.sandbox.reference);

              if (input.bytes.length > MAX_BYTES)
                throw new AdapterError("CAPACITY", "E2B file write exceeds the byte bound");

              return input;
            },
            async submit(input, ctx) {
              await requireRunning(input.sandbox.id, input.sandbox.reference);

              if (!nativeId.test(ctx.submissionId))
                return ctx.reject("INVALID_ARGUMENT", "Invalid E2B write submission ID");

              if (ctx.signal.aborted)
                return ctx.unknown("E2B file write was not submitted after cancellation");

              const parent = input.path.slice(0, input.path.lastIndexOf("/")) || "/";

              const staged = input.overwrite
                ? undefined
                : `${parent}/.sandbar-write-${ctx.submissionId}`;

              if (staged === input.path)
                return ctx.reject(
                  "INVALID_ARGUMENT",
                  "E2B destination conflicts with write staging",
                );

              const token: WriteTokenData = {
                path: input.path,
                bytesWritten: input.bytes.length,
                digest: createHash("sha256").update(input.bytes).digest("hex"),
              };

              if (staged) token.staged = staged;

              let stage: "unknown" | "link" = "unknown";

              try {
                if (input.overwrite) {
                  await transport.write(input.sandbox.id, input.path, input.bytes);
                } else {
                  await transport.write(input.sandbox.id, staged!, input.bytes);

                  if (ctx.signal.aborted) return ctx.pending(token, { pollAfterMs: 1000 });

                  stage = "link";

                  const answer = await transport.run(
                    input.sandbox.id,
                    `if ln -T -- ${shellQuote(staged!)} ${shellQuote(input.path)} 2>/dev/null; then printf 'CREATED'; elif test -e ${shellQuote(input.path)}; then printf 'EXISTS'; else printf 'FAILED'; fi`,
                    { timeoutMs: 30_000 },
                  );

                  if (ctx.signal.aborted) return ctx.pending(token, { pollAfterMs: 1000 });

                  if (answer === "EXISTS") {
                    await transport.remove(input.sandbox.id, staged!).catch(() => {});

                    return ctx.reject("CONFLICT", "E2B file already exists");
                  }

                  if (answer !== "CREATED") return ctx.pending(token, { pollAfterMs: 1000 });

                  await transport.remove(input.sandbox.id, staged!).catch(() => {});
                }

                return { bytesWritten: input.bytes.length };
              } catch (error) {
                token.failure = classifyWriteFailure(error, stage);

                return ctx.pending(token, { pollAfterMs: 1000 });
              }
            },
            async observe(attempt, ctx) {
              if (!attempt.sandbox) return null;
              const token = WriteToken.safeParse(attempt.token);

              if (!token.success) return ctx.unknown("E2B file write lacks recovery evidence");
              await requireRunning(attempt.sandbox.id, attempt.sandbox.reference);
              const { path, staged, bytesWritten, digest, failure } = token.data;
              requirePath(path);

              if (staged) {
                const parent = path.slice(0, path.lastIndexOf("/")) || "/";

                if (staged !== `${parent}/.sandbar-write-${attempt.submissionId}`)
                  return ctx.unknown("E2B no-clobber stage does not match the submission");

                const same = await transport.run(
                  attempt.sandbox.id,
                  `if test ${shellQuote(staged)} -ef ${shellQuote(path)}; then printf 'SAME'; else printf 'DIFFERENT'; fi`,
                  { timeoutMs: 30_000 },
                );

                if (same !== "SAME")
                  return ctx.unknown(
                    writeFailureReason(
                      "E2B no-clobber write has no matching native inode",
                      failure,
                    ),
                  );
              }

              let result: { bytes: Uint8Array; truncated: boolean };

              try {
                result = await transport.read(attempt.sandbox.id, path, MAX_BYTES);
              } catch {
                return ctx.unknown(
                  writeFailureReason("E2B written file could not be confirmed", failure),
                );
              }

              const digestMatches =
                createHash("sha256").update(result.bytes).digest("hex") === digest;

              if (result.truncated || result.bytes.length !== bytesWritten || !digestMatches)
                return ctx.unknown(
                  writeFailureReason(
                    `E2B written bytes differ from the submitted content; expectedLength=${bytesWritten}, actualLength=${result.bytes.length}, truncated=${result.truncated}, digestMatches=${digestMatches}`,
                    failure,
                  ),
                );

              return { bytesWritten };
            },
          },
        },
      };
    },
  });
}

export const e2bAdapter = createE2BAdapter();

export { E2B_ENDPOINT, MAX_BYTES, type E2BTransport } from "./transport";
