import { z } from "zod";
import { ExecCommand } from "@sandbar/contracts";
import { InvocationIdentity, NativeRef, NativeScope } from "@sandbar/provider-spi";

export const FakeAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capabilities"), scope: NativeScope }),
  z.strictObject({ kind: z.literal("create"), scope: NativeScope, identity: InvocationIdentity, image: z.string().min(1), networkPolicy: z.string().min(1) }),
  z.strictObject({ kind: z.literal("inspect"), ref: NativeRef }),
  z.strictObject({ kind: z.literal("inventory"), scope: NativeScope, cursor: z.string().optional(), limit: z.number().int().min(1).max(100) }),
  z.strictObject({ kind: z.literal("exec"), sandbox: NativeRef, identity: InvocationIdentity, command: ExecCommand, cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), deadlineSeconds: z.number().int().min(1).max(3600), maxOutputBytes: z.number().int().min(0).max(1048576) }),
  z.strictObject({ kind: z.literal("readFile"), sandbox: NativeRef, path: z.string().min(1).max(4096) }),
  z.strictObject({ kind: z.literal("writeFile"), sandbox: NativeRef, path: z.string().min(1).max(4096), bytesBase64: z.base64(), overwrite: z.boolean() }),
  z.strictObject({ kind: z.literal("destroy"), sandbox: NativeRef, identity: InvocationIdentity }),
  z.strictObject({ kind: z.literal("observe"), scope: NativeScope, submissionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("events"), scope: NativeScope }),
]);
export type FakeAction = z.infer<typeof FakeAction>;

export function validFakePath(path: string): boolean {
  return path.startsWith("/") && !path.includes("\0") && !path.split("/").some(part => part === ".." || part === ".") && path.length <= 4096;
}
