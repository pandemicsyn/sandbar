import { SandbarError, type DirectSandboxHandle, type ProcessExit } from "sandbar-sdk";

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

/** E2B native SIGKILL; active PID selection can race exit/reuse. */
export async function terminateJob(sandbox: DirectSandboxHandle): Promise<ProcessExit> {
  const job = await sandbox.processes.start({
    command: { kind: "shell", script: "printf ready; exec sleep 60" },
    maxOutputBytes: 4096,
  });

  const observation = AbortSignal.timeout(10_000);

  const drain = (async () => {
    for await (const chunk of job.output({ signal: observation })) {
      (chunk.stream === "stdout" ? console.log : console.error)(chunk.text);
    }
  })().then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );

  try {
    try {
      const request = await job.terminate({ signal: observation });
      console.log(request.status); // Acknowledgement, absence or previously confirmed exit.
    } catch (error) {
      if (!(error instanceof SandbarError) || error.code !== "OUTCOME_UNKNOWN") throw error;
      console.error("Termination acknowledgement is unknown", error);
    }

    await job.wait({ signal: observation });
    const output = await drain; // Same signal bounds a stream that never closes after exit.

    if (!output.ok) throw output.error;

    return await job.wait({ signal: observation });
  } finally {
    await job.detach(); // Local release; never a remote kill.
  }
}
