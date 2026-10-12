import { z } from "zod";
import { AdapterError, type ExecInput } from "@sandbar-sdk/adapter";

// Executed by the managed Node 24 image. User argv is JSON data, never interpolated code.
// A private directory and exclusive receipt prevent concurrent executions from colliding.
export const captureHelper = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const spec = JSON.parse(process.argv[1]);
const dir = fs.mkdtempSync('/tmp/sandbar-exec-');
fs.chmodSync(dir, 0o700);
const path = dir + '/receipt.json';
console.log(path);
let size = 0, truncated = false, timedOut = false, failure = false;
const output = { stdout: [], stderr: [] };
let inputBytes;
if (spec.stdinPath) {
  const fd = fs.openSync(spec.stdinPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const b = Buffer.alloc(1048577); let size=0;
    for(let n;size<b.length && (n=fs.readSync(fd,b,size,b.length-size));) size+=n;
    if(size>1048576) throw new Error('Finite stdin exceeds byte bound');
    inputBytes=b.subarray(0,size);
  } finally { fs.closeSync(fd); }
  fs.unlinkSync(spec.stdinPath);
}
const child = spawn(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd, env: { ...process.env, ...spec.env },
  stdio: ['pipe', 'pipe', 'pipe'], detached: true
});
child.stdin.on('error', () => {});
child.stdin.end(inputBytes);
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}, spec.timeoutMs);
for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
  const keep = Math.min(chunk.length, spec.maxBytes - size);
  if (keep) output[stream].push(chunk.subarray(0, keep));
  size += keep;
  if (keep < chunk.length) truncated = true;
});
child.on('error', () => { failure = true; });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  if (Number.isInteger(code) && !failure && !timedOut)
    console.log(JSON.stringify({ sandbarExit: 1, exitCode: code }));
  const receipt = { version: 1, exitCode: code, signal, timedOut, failure, truncated,
    stdout: Buffer.concat(output.stdout).toString('base64'),
    stderr: Buffer.concat(output.stderr).toString('base64') };
  fs.writeFileSync(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
});
`;

const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const receipt = z.strictObject({
  version: z.literal(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  failure: z.boolean(),
  truncated: z.boolean(),
  stdout: base64,
  stderr: base64,
});

export function captureSpec(input: ExecInput) {
  return {
    argv:
      input.command.kind === "argv" ? input.command.argv : ["/bin/sh", "-c", input.command.script],
    cwd: input.cwd,
    env: input.env,
    maxBytes: input.maxOutputBytes,
    timeoutMs: input.deadlineSeconds * 1000,
  };
}

export function decodeReceipt(bytes: Uint8Array, maxBytes: number) {
  const parsed = receipt.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );

  if (!parsed.success) throw new AdapterError("INTERNAL", "Invalid execution receipt");
  const value = parsed.data;
  const stdout = Buffer.from(value.stdout, "base64");
  const stderr = Buffer.from(value.stderr, "base64");

  if (stdout.length + stderr.length > maxBytes)
    throw new AdapterError("INTERNAL", "Execution receipt exceeds output bound");

  if (value.failure) throw new AdapterError("UNAVAILABLE", "Guest command could not start");

  if (value.timedOut) throw new AdapterError("TIMEOUT", "Guest command deadline exceeded");

  if ((value.exitCode === null) !== (value.signal !== null))
    throw new AdapterError("INTERNAL", "Inconsistent guest exit evidence");

  return { exitCode: value.exitCode, stdout, stderr, truncated: value.truncated };
}
