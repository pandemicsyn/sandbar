// Plain Node, no dependencies: GitHub runs these files directly from a checkout of the action.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const windows = process.platform === "win32";

/** An action input, trimmed; GitHub passes `with:` values as INPUT_<NAME> variables. */
export function input(name, fallback = "") {
  const value = process.env[`INPUT_${name.toUpperCase()}`]?.trim();

  return value || fallback;
}

/** Append one `name=value` line to a GitHub command file such as GITHUB_ENV. */
function appendCommand(file, name, value) {
  const path = process.env[file];

  if (!path) throw new Error(`${file} is not set; run this action in a GitHub Actions job`);

  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line`);
  appendFileSync(path, `${name}=${value}\n`);
}

/** Set a variable for this step and every later step in the job. */
export function exportVariable(name, value) {
  process.env[name] = value;
  appendCommand("GITHUB_ENV", name, value);
}

/** Put a folder on PATH for this step and every later step in the job. */
export function addPath(dir) {
  const path = process.env.GITHUB_PATH;

  if (!path) throw new Error("GITHUB_PATH is not set; run this action in a GitHub Actions job");
  appendFileSync(path, `${dir}\n`);
  process.env.PATH = `${dir}${windows ? ";" : ":"}${process.env.PATH ?? ""}`;
}

export function setOutput(name, value) {
  appendCommand("GITHUB_OUTPUT", name, value);
}

/** Remember a value for the post step, which reads it back as STATE_<name>. */
export function saveState(name, value) {
  appendCommand("GITHUB_STATE", name, value);
}

/** Run a program, streaming its output to the job log; throws when it exits non-zero. */
export function run(program, args, capture = false) {
  // npm and installed bins are .cmd shims on Windows, which need a shell to start.
  const result = spawnSync(program, args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    // Pass the environment explicitly so variables set by this step reach the child.
    env: process.env,
    shell: windows,
  });

  if (result.error) throw result.error;

  if (result.status !== 0)
    throw new Error(`${program} ${args.join(" ")} exited with ${result.status ?? result.signal}`);

  return capture ? result.stdout.trim() : "";
}

/** The folder npm puts global bins in for a given prefix. */
export function binDir(prefix) {
  return windows ? prefix : `${prefix}/bin`;
}

export function sandbarBin(prefix) {
  return windows ? `${prefix}\\sandbar.cmd` : `${prefix}/bin/sandbar`;
}
