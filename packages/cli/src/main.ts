#!/usr/bin/env node
import { main } from "./cli";

const controller = new AbortController();

let interrupted = false;

// The first signal cancels local waits so run can still clean up; a second one exits now.
// Harness timeouts usually send SIGTERM (or SIGHUP when the terminal goes away), not SIGINT.
const signalExitCodes = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;

let exitCode = 130;

for (const [name, code] of Object.entries(signalExitCodes))
  process.on(name, () => {
    if (interrupted) process.exit(code);
    interrupted = true;
    exitCode = code;
    controller.abort(new Error(`Interrupted by ${name}`));
  });

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of process.stdin) chunks.push(new Uint8Array(chunk));

  return new Uint8Array(Buffer.concat(chunks));
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
  readStdin,
  streams: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
});

// An interrupted run reports 128 + signal like other CLIs, whatever happened before it.
process.exitCode = interrupted ? exitCode : code;
