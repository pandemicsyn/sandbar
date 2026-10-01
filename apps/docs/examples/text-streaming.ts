import type { DirectSandboxHandle, ProcessExit } from "sandbar-sdk";

/** Finite E2B text only. Native decoding does not preserve arbitrary bytes. */
export async function textStreaming(sandbox: DirectSandboxHandle): Promise<ProcessExit> {
  const process = await sandbox.processes.start({
    command: { kind: "argv", argv: ["/bin/sh", "-c", "printf hello; printf err >&2; exit 7"] },
    maxOutputBytes: 4096,
  });

  try {
    for await (const chunk of process.output()) {
      const destination = chunk.stream === "stdout" ? console.log : console.error;
      destination(chunk.text);
    }

    return await process.wait(); // Ordinary nonzero result; outputComplete after drain.
  } finally {
    await process.detach(); // Releases local observation; never kills compute.
  }
}
