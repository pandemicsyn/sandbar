#!/usr/bin/env node
import { main } from "./cli";

const controller = new AbortController();

let interrupted = false;

// The first interrupt cancels local waits so run can still clean up; a second one exits now.
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  controller.abort(new Error("Interrupted"));
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

process.exitCode = interrupted && code === 0 ? 130 : code;
