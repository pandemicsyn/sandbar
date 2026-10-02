import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ResourceReference } from "sandbar-sdk";
import type { RunLedger } from "./ledger";

/** A separate OS process performs only scoped public get/inspect, never allocations. */
export async function reopenInFreshProcess(
  input: {
    provider: string;
    connection: RunLedger["connection"];
    reference: ResourceReference;
    profilePath?: string;
    sandboxProbe?: {
      path: string;
      base64: string;
      inactive?: boolean;
      expires: import("sandbar-sdk").Deadline;
    };
  },
  signal: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./reopen-child.ts", import.meta.url))],
      {
        stdio: ["pipe", "pipe", "ignore"],
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();

      if (output.length > 128) child.kill();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && output.trim() === "reopened") resolve();
      else reject(new Error("Fresh-process snapshot reopen/inspect failed"));
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}
