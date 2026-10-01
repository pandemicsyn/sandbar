import type { SandboxHandle } from "sandbar-sdk";

/** Caller wait and provider command limits are separate; local abort does not kill compute. */
export async function runWithWaitBudget(box: SandboxHandle) {
  return await box.exec(
    { command: { kind: "argv", argv: ["node", "job.js"] }, deadlineSeconds: 10 },
    { signal: AbortSignal.timeout(15_000) },
  );
}
