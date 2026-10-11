import type { ExecOutput, SandboxHandle } from "sandbar-sdk";

/** Echo finite UTF-8 or binary input through the ordinary command result. */
export function finiteStdinEcho(
  box: SandboxHandle,
  stdin: string | Uint8Array,
): Promise<ExecOutput> {
  return box.exec({
    command: { kind: "argv", argv: ["cat"] },
    stdin,
  });
}
