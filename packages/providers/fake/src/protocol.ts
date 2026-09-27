import { z } from "zod";
import { ExecCommand } from "@sandbar/contracts";
import { InvocationIdentity, NativeScope, SandboxRef } from "@sandbar/provider-spi";

export const FakeInventoryCursor = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((cursor) => Number.isSafeInteger(Number(cursor)), "Cursor must be a safe integer");

export const FakeAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capabilities"), scope: NativeScope }),
  z.strictObject({
    kind: z.literal("create"),
    scope: NativeScope,
    identity: InvocationIdentity,
    image: z.string().min(1),
    networkPolicy: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
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
