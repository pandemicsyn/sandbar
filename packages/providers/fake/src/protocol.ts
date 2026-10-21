import { z } from "zod";
import { CreateEnv, ExecCommand } from "@sandbar-sdk/adapter/portable";
import { InvocationIdentity, NativeScope, SandboxRef } from "@sandbar/provider-spi";

export const FakeInventoryCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((cursor) => Number.isSafeInteger(Number(cursor)), "Cursor must be a safe integer");

/** The provider image every fake connection may borrow; it is never deleted. */
export const FAKE_STARTER_IMAGE = "fake-starter";

export const FakeImageId = z
  .string()
  .regex(/^(fake-starter|fake-image-[1-9][0-9]{0,8})$/, "Invalid fake image ID");

/** A fake provider image observation. Built images record their OCI source and submission. */
export const FakeImage = z.strictObject({
  id: FakeImageId,
  state: z.enum(["ready"]),
  visibility: z.enum(["public", "private"]),
  source: z.string().min(1).max(1024).nullable(),
  submissionId: z.string().min(1).max(128).nullable(),
  createdAt: z.iso.datetime().nullable(),
});

export type FakeImage = z.infer<typeof FakeImage>;

export const FakeImageDeleteResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("deleted"), imageId: FakeImageId }),
  z.strictObject({ status: z.literal("not_found"), imageId: FakeImageId }),
  z.strictObject({
    status: z.literal("rejected"),
    imageId: FakeImageId,
    reason: z.enum(["public", "in_use"]),
  }),
]);

export type FakeImageDeleteResult = z.infer<typeof FakeImageDeleteResult>;

export const FakeAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capabilities"), scope: NativeScope }),
  z.strictObject({
    kind: z.literal("create"),
    scope: NativeScope,
    identity: InvocationIdentity,
    image: z.string().min(1),
    networkPolicy: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    env: CreateEnv.optional(),
    lifetimeSeconds: z.number().int().positive().safe().optional(),
  }),
  z.strictObject({ kind: z.literal("inspect"), ref: SandboxRef }),
  z.strictObject({
    kind: z.literal("inventory"),
    scope: NativeScope,
    cursor: FakeInventoryCursor.optional(),
    limit: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("exec"),
    sandbox: SandboxRef,
    identity: InvocationIdentity,
    command: ExecCommand,
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    deadlineSeconds: z.number().int().min(1).max(3600),
    maxOutputBytes: z.number().int().min(0).max(1048576),
  }),
  z.strictObject({
    kind: z.literal("readFile"),
    sandbox: SandboxRef,
    path: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal("writeFile"),
    sandbox: SandboxRef,
    identity: InvocationIdentity,
    path: z.string().min(1).max(4096),
    bytesBase64: z.base64(),
    overwrite: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("destroy"), sandbox: SandboxRef, identity: InvocationIdentity }),
  z.strictObject({
    kind: z.literal("observe"),
    scope: NativeScope,
    submissionId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal("events"), scope: NativeScope }),
  z.strictObject({
    kind: z.literal("imageBuild"),
    scope: NativeScope,
    identity: InvocationIdentity,
    source: z.string().min(1).max(1024),
  }),
  z.strictObject({
    kind: z.literal("imageInspect"),
    scope: NativeScope,
    imageId: FakeImageId.optional(),
    submissionId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    kind: z.literal("imageList"),
    scope: NativeScope,
    cursor: FakeInventoryCursor.optional(),
    limit: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("imageDelete"),
    scope: NativeScope,
    identity: InvocationIdentity,
    imageId: FakeImageId,
  }),
]);

export type FakeAction = z.infer<typeof FakeAction>;

export const FakeEvent = z.strictObject({
  eventId: z.string().min(1),
  ref: z.object({
    scope: z.object({
      provider: z.string(),
      connectionId: z.string(),
      accountId: z.string(),
      region: z.string().optional(),
    }),
    nativeId: z.string(),
    kind: z.literal("sandbox"),
  }),
  sequence: z.number().int().nonnegative(),
  state: z.enum(["running", "destroyed"]),
  occurredAt: z.iso.datetime({ offset: true }),
});

export function validFakePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === ".") &&
    path.length <= 4096
  );
}

/** Bound fake file payloads before decoding in the client. */
export const FakeFileBytesBase64 = z
  .base64()
  .max(1_398_104)
  .refine((value) => Buffer.from(value, "base64").length <= 1024 * 1024, "File exceeds 1 MiB");
