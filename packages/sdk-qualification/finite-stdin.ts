import { expect } from "bun:test";
import { NonzeroExitError } from "sandbar-sdk";
import type { DirectSandboxHandle, ExecInput, ExecOutput } from "sandbar-sdk";

export const finiteStdinInput = "λ\0💜";

export async function assertFiniteStdinWorkflow(
  box: Pick<DirectSandboxHandle, "exec">,
  nativeInput?: () => Uint8Array | undefined,
): Promise<void> {
  const input: ExecInput = {
    command: {
      kind: "shell",
      script: "cat; printf out; printf err >&2; exit 7",
    },
    stdin: finiteStdinInput,
    cwd: "/tmp",
    env: { FINITE_STDIN_FIXTURE: "selected" },
    deadlineSeconds: 10,
    maxOutputBytes: 16,
  };

  let result: ExecOutput;

  try {
    result = await box.exec(input);
  } catch (error) {
    if (!(error instanceof NonzeroExitError)) throw error;
    result = error.result;
  }

  const bytes = new TextEncoder().encode(finiteStdinInput);
  const stdout = new Uint8Array(bytes.length + 3);
  stdout.set(bytes);
  stdout.set(new TextEncoder().encode("out"), bytes.length);

  expect(result).toMatchObject({
    exitCode: 7,
    stdout,
    stderr: new TextEncoder().encode("err"),
    truncated: false,
  });

  if (nativeInput) expect(nativeInput()).toEqual(bytes);
}
