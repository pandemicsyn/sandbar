import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One-time npm bootstrap: `npm trust` only accepts packages that already exist, so an
// owner publishes a 0.0.0 placeholder per public package before OIDC can be configured.
// Every later version comes from the Release npm packages workflow.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const repository = "pandemicsyn/sandbar";

const workflow = "release-npm.yml";

const environment = "npm";

const placeholderVersion = "0.0.0";

const paths = JSON.parse(readFileSync(join(root, "scripts/release-packages.json"), "utf8"));

const packages = paths.map((path) => {
  const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));

  return { path, manifest };
});

function npm(args, options = {}) {
  return spawnSync("npm", args, { cwd: root, encoding: "utf8", ...options });
}

function interactive(args) {
  const result = npm(args, { stdio: "inherit" });

  if (result.error || result.status !== 0)
    throw new Error(`npm ${args.join(" ")} failed (${result.status ?? result.error})`);
}

function registryVersions(name) {
  const result = npm(["view", name, "versions", "--json"]);

  if (result.status === 0) return [JSON.parse(result.stdout.trim())].flat();

  if (/E404/.test(result.stderr)) return null;
  throw new Error(`Cannot check registry state for ${name}: ${result.stderr}`);
}

function owners(name) {
  const result = npm(["owner", "ls", name]);

  if (result.status !== 0) throw new Error(`Cannot list npm owners for ${name}: ${result.stderr}`);

  return result.stdout
    .split("\n")
    .map((line) => line.split(" ")[0])
    .filter(Boolean);
}

function whoami() {
  const result = npm(["whoami"]);

  if (result.status !== 0)
    throw new Error("Run `npm login` with the account that will own the Sandbar packages");

  return result.stdout.trim();
}

function requireNpm() {
  const version = npm(["--version"]).stdout.trim();

  if (Bun.semver.order(version, "11.15.0") < 0)
    throw new Error(`npm ${version} found; npm trust requires npm 11.15.0 or later`);
}

function placeholder({ path, manifest }, directory) {
  const target = join(directory, manifest.name);

  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify(
      {
        name: manifest.name,
        version: placeholderVersion,
        description: `Placeholder for ${manifest.name}. Install a published Sandbar release instead.`,
        license: manifest.license,
        repository: manifest.repository,
        homepage: manifest.homepage ?? `https://github.com/${repository}#readme`,
        files: ["README.md", "LICENSE"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(target, "README.md"),
    `# ${manifest.name}\n\nThis ${placeholderVersion} version reserves the package name so releases can use npm trusted publishing. It contains no code.\n\nReleases are published from https://github.com/${repository}/blob/main/${path}.\n`,
  );
  copyFileSync(join(root, "LICENSE"), join(target, "LICENSE"));

  return target;
}

function state() {
  return packages.map((item) => ({ item, versions: registryVersions(item.manifest.name) }));
}

function report(rows) {
  for (const { item, versions } of rows)
    console.log(
      `${item.manifest.name}: ${versions ? `exists (${versions.join(", ")})` : "not on registry"}`,
    );
}

const mode = process.argv[2] ?? "plan";

if (!["plan", "publish", "trust"].includes(mode))
  throw new Error(`Unknown bootstrap mode: ${mode}; use plan, publish or trust`);

if (mode === "plan") {
  const directory = join(tmpdir(), `sandbar-npm-bootstrap-${process.pid}`);

  report(state());

  for (const item of packages) {
    const target = placeholder(item, directory);
    const result = npm(["pack", "--dry-run", "--json"], { cwd: target });

    if (result.status !== 0) throw new Error(`Cannot pack ${item.manifest.name}: ${result.stderr}`);
    const [packed] = JSON.parse(result.stdout);

    console.log(
      `${packed.id}: ${packed.files.map((file) => file.path).join(", ")} (${packed.size} bytes)`,
    );
  }

  console.log(`Placeholders written to ${directory}; nothing was published.`);
}

if (mode === "publish") {
  requireNpm();
  const user = whoami();
  const rows = state();

  for (const { item, versions } of rows) {
    if (versions && !owners(item.manifest.name).includes(user))
      throw new Error(`${item.manifest.name} exists and ${user} is not an owner; stopping`);
  }

  const directory = join(tmpdir(), `sandbar-npm-bootstrap-${process.pid}`);

  for (const { item, versions } of rows) {
    if (versions) {
      console.log(`${item.manifest.name} already exists and is owned by ${user}; skipping`);
      continue;
    }

    const target = placeholder(item, directory);

    interactive(["publish", target, "--access", "public", "--tag", "latest"]);
  }

  console.log("Placeholders published. Next: bun run release:bootstrap trust");
}

if (mode === "trust") {
  requireNpm();
  whoami();

  const requested = process.argv.slice(3);

  const unknown = requested.filter(
    (name) => !packages.some(({ manifest }) => manifest.name === name),
  );

  if (unknown.length) throw new Error(`Not in the release package list: ${unknown.join(", ")}`);

  const selected = requested.length
    ? packages.filter(({ manifest }) => requested.includes(manifest.name))
    : packages;

  for (const [index, { manifest }] of selected.entries()) {
    if (index > 0) await new Promise((done) => setTimeout(done, 2000));
    interactive([
      "trust",
      "github",
      manifest.name,
      "--file",
      workflow,
      "--repository",
      repository,
      "--environment",
      environment,
      "--allow-publish",
      "--yes",
    ]);
  }

  console.log(
    "Trusted publishing configured. Next: set each package to require 2FA and disallow tokens on npmjs.com.",
  );
}
