import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPath,
  binDir,
  exportVariable,
  input,
  run,
  sandbarBin,
  saveState,
  setOutput,
} from "./lib.mjs";

const VersionSpec = /^[0-9A-Za-z.^~<>=*+-]{1,64}$/;

const ProviderId = /^[a-z][a-z0-9-]{0,63}$/;

/** An official id, or a scoped package name with an optional version, as `adapter add` takes. */
const AdapterName =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9A-Za-z.^~<>=*+-]{1,64})?$/;

try {
  const version = input("version", "latest");

  const adapters = input("adapters")
    .split(/[\s,]+/)
    .filter(Boolean);

  const provider = input("provider");
  const temp = process.env.RUNNER_TEMP || tmpdir();

  if (!VersionSpec.test(version))
    throw new Error(`version ${version} is not an npm version or tag`);

  for (const name of adapters)
    if (!AdapterName.test(name)) throw new Error(`${name} is not a provider id or package name`);

  if (provider && !ProviderId.test(provider)) throw new Error(`${provider} is not a provider id`);

  // A prefix in the job's temp folder needs no root and never touches the runner's own Node.
  const prefix = join(temp, "sandbar-cli");
  run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-fund",
    "--no-audit",
    `@sandbar-sdk/cli@${version}`,
  ]);

  addPath(binDir(prefix));
  const sandbar = sandbarBin(prefix);

  const stateDir = input("state-dir", join(temp, "sandbar", "state"));
  exportVariable("SANDBAR_STATE_DIR", stateDir);

  if (provider) exportVariable("SANDBAR_PROVIDER", provider);

  // `adapter add` installs each official adapter at the CLI's version and skips npm when nothing changed.
  if (adapters.length) run(sandbar, ["adapter", "add", ...adapters]);

  const installed = run(sandbar, ["--version"], true);
  setOutput("version", installed);
  setOutput("state-dir", stateDir);
  saveState("sandbar", sandbar);
  saveState("stateDir", stateDir);
  saveState("cleanup", input("cleanup", "true") === "true" ? "true" : "false");
  console.log(`Sandbar CLI ${installed} ready; state in ${stateDir}`);
} catch (cause) {
  console.log(`::error::${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}
