import { expect } from "bun:test";
import type { ProcessReference, SandboxReference } from "sandbar-sdk";
import type { RunLedger } from "../provider-qualification/ledger";
import { configuredProvider } from "./providers";

// This child performs no allocations. Private references arrive on stdin, never command-line arguments.
const input: {
  connection: RunLedger["connection"];
  sandbox: SandboxReference;
  process: ProcessReference<"bytes">;
} = JSON.parse(await Bun.stdin.text());

const profile = await configuredProvider(input.connection);

const client = await profile.factory(async () => {
  throw new Error("Fresh process reopen forbids control-plane mutations");
});

try {
  const sandbox = await client.sandboxes.get(input.sandbox);

  const process = await sandbox.processes.reopen(input.process, {
    signal: AbortSignal.timeout(20_000),
  });

  const signal = AbortSignal.timeout(20_000);

  try {
    expect(process.outputGap).toBe(true);
    expect((await process.status({ signal })).state).toBe("running");
    const received: number[] = [];

    const drain = (async () => {
      for await (const chunk of process.output({ signal })) {
        if (received.length + chunk.bytes.length > 1024) throw new Error("Reopen output overflow");
        expect(chunk.stream).toBe("stdout");
        received.push(...chunk.bytes);
      }
    })();

    const done = Promise.all([drain, process.wait({ signal })]);
    await process.write(Uint8Array.of(0, 255, 128, 10), { signal });
    await process.closeStdin({ signal });
    const [, exit] = await done;
    expect(received).toEqual([0, 255, 128, 10]);
    expect(exit).toEqual({ exitCode: 0, outputComplete: false });
  } finally {
    await process.detach();
  }
} finally {
  await client.close();
}

console.log("reopened");
