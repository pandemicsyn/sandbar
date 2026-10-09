import {
  Image,
  type AdapterDirectClient,
  type AdapterSandbox,
  type ProcessExit,
  type ProcessOutput,
} from "sandbar-sdk";

export type OutputSink = (chunk: ProcessOutput) => void | Promise<void>;

/** Stream build progress to an application-owned sink without keeping a transcript. */
export async function buildWithProgress(
  box: AdapterSandbox,
  argv: string[],
  sink: OutputSink,
  signal?: AbortSignal,
): Promise<ProcessExit> {
  const job = await box.processes.start(
    { command: { kind: "argv", argv }, output: { mode: "stream" } },
    { signal },
  );

  const output = (async () => {
    for await (const chunk of job.output({ signal })) await sink(chunk);
  })();

  const completion = Promise.allSettled([output, job.wait({ signal })]);

  try {
    const [logs, exit] = await completion;

    if (exit.status === "rejected") throw exit.reason;

    if (logs.status === "rejected") throw logs.reason;

    return await job.wait({ signal });
  } finally {
    await job.detach();
  }
}

/** Send multiple requests, then EOF, while independently consuming output. */
export async function interactiveWorker(
  box: AdapterSandbox,
  argv: string[],
  requests: AsyncIterable<string | Uint8Array>,
  sink: OutputSink,
  signal?: AbortSignal,
): Promise<ProcessExit> {
  const job = await box.processes.start(
    { command: { kind: "argv", argv }, stdin: "pipe", output: { mode: "stream" } },
    { signal },
  );

  const output = (async () => {
    for await (const chunk of job.output({ signal })) await sink(chunk);
  })();

  const completion = Promise.allSettled([output, job.wait({ signal })]);

  try {
    for await (const request of requests) await job.write(request, { signal });
    await job.closeStdin({ signal });
    const [logs, exit] = await completion;

    if (exit.status === "rejected") throw exit.reason;

    if (logs.status === "rejected") throw logs.reason;

    return await job.wait({ signal });
  } finally {
    await job.detach();
  }
}

/** The adapter setup must explicitly permit the desired preview access. */
export async function serverWorkspace(
  client: AdapterDirectClient,
  preparedImage: string,
  argv: string[],
  port: number,
  sink: OutputSink,
  use: (url: string, headers: Record<string, string>) => Promise<void>,
  request: typeof fetch = fetch,
): Promise<void> {
  try {
    const box = await client.sandboxes.create({ environment: Image.prepared(preparedImage) });

    try {
      const job = await box.processes.start({
        command: { kind: "argv", argv },
        output: { mode: "stream" },
      });

      const outputAbort = new AbortController();

      const output = (async () => {
        for await (const chunk of job.output({ signal: outputAbort.signal })) await sink(chunk);
      })();

      // Observe rejection immediately even while readiness/use is in progress.
      const logs = output.then(
        () => ({ ok: true as const }),
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Retain a rejected user sink result without inspecting or logging its payload.
        (error: unknown) => ({ ok: false as const, error }),
      );

      try {
        const preview = await box.preview(port);
        const headers = preview.access === "protected" ? preview.headers : {};
        const readiness = AbortSignal.timeout(15_000);

        while (true) {
          readiness.throwIfAborted();
          const status = await job.status({ signal: readiness });

          if (status.state === "exited") throw new Error("Server exited before becoming ready");

          try {
            const response = await request(preview.url, {
              headers,
              redirect: "error",
              signal: readiness,
            });

            await response.body?.cancel();

            if (response.ok) break;
          } catch (error) {
            if (readiness.aborted) throw error;
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }

        await use(preview.url, headers);
      } finally {
        try {
          const cleanup = AbortSignal.timeout(10_000);
          await job.terminate({ signal: cleanup });
          await job.wait({ signal: cleanup });
        } finally {
          outputAbort.abort();
          await job.detach();
          await logs;
        }
      }
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
