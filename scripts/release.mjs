import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const entries = JSON.parse(readFileSync(join(root, "scripts/release-packages.json"), "utf8"));

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }

  return result.stdout.trim();
}

function load() {
  if (!Array.isArray(entries) || !entries.length || new Set(entries).size !== entries.length)
    throw new Error("Release package list must be nonempty and unique");
  const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8"));

  const packages = entries.map((path) => {
    if (!/^packages\/[a-z0-9/-]+$/.test(path)) throw new Error(`Invalid release path: ${path}`);
    const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));

    if (manifest.private !== false)
      throw new Error(
        `${manifest.name} is private; public package naming and manifest setup are incomplete`,
      );

    if (!versionPattern.test(manifest.version))
      throw new Error(`${manifest.name} has invalid release version ${manifest.version}`);

    if (lock.workspaces?.[path]?.version !== manifest.version)
      throw new Error(
        `${manifest.name} lockfile version is stale; regenerate bun.lock after Changesets versioning`,
      );

    if (manifest.repository?.url !== "git+https://github.com/pandemicsyn/sandbar.git")
      throw new Error(`${manifest.name} needs the exact Sandbar repository URL for npm provenance`);

    return { path, manifest };
  });

  const names = new Set(packages.map(({ manifest }) => manifest.name));

  if (names.size !== packages.length) throw new Error("Duplicate release package names");
  const version = packages[0].manifest.version;

  if (packages.some(({ manifest }) => manifest.version !== version))
    throw new Error("Public packages must share one lockstep release version");

  for (const { manifest } of packages) {
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      if (name.startsWith("@sandbar/") || name.startsWith("sandbar-")) {
        if (!names.has(name))
          throw new Error(`${manifest.name} depends on unpublished internal package ${name}`);

        if (range !== "workspace:*")
          throw new Error(`${manifest.name} must use workspace:* for ${name} in source`);
      }
    }
  }

  const byName = new Map(packages.map((item) => [item.manifest.name, item]));
  const ordered = [];
  const active = new Set();
  const done = new Set();

  function visit(item) {
    const name = item.manifest.name;

    if (active.has(name)) throw new Error(`Cyclic release dependency at ${name}`);

    if (done.has(name)) return;
    active.add(name);

    for (const dependency of Object.keys(item.manifest.dependencies ?? {})) {
      const internal = byName.get(dependency);

      if (internal) visit(internal);
    }

    active.delete(name);
    done.add(name);
    ordered.push(item);
  }

  for (const item of packages) visit(item);

  return { ordered, version, names };
}

function validateRef(version, real) {
  if (!real) return;
  const expected = `v${version}`;
  const requested = process.env.RELEASE_REF;

  if (requested !== expected)
    throw new Error(`Real release requires exact tag ${expected}; got ${requested}`);
  const tagged = run("git", ["rev-parse", `refs/tags/${expected}^{commit}`]);
  const head = run("git", ["rev-parse", "HEAD"]);

  if (tagged !== head) throw new Error(`${expected} does not point to checked-out HEAD`);
  run("git", ["merge-base", "--is-ancestor", head, "origin/main"]);
}

function releaseTag(version) {
  const request = process.env.NPM_TAG || "auto";

  if (!["auto", "latest", "next"].includes(request)) throw new Error(`Invalid npm tag: ${request}`);
  const prerelease = version.includes("-");
  const tag = request === "auto" ? (prerelease ? "next" : "latest") : request;

  if (prerelease && tag === "latest") throw new Error("Prereleases cannot be published to latest");

  return { tag, prerelease };
}

function packAll(plan, directory) {
  mkdirSync(directory, { recursive: true });
  const packed = [];

  for (const item of plan.ordered) {
    const before = new Set(readdirSync(directory));
    run("bun", ["pm", "pack", "--destination", directory], join(root, item.path));

    const added = readdirSync(directory).filter(
      (name) => name.endsWith(".tgz") && !before.has(name),
    );

    if (added.length !== 1) throw new Error(`Expected one tarball for ${item.manifest.name}`);
    const archive = join(directory, added[0]);
    const manifest = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"]));

    if (
      manifest.name !== item.manifest.name ||
      manifest.version !== plan.version ||
      manifest.private === true
    )
      throw new Error(`Packed identity mismatch for ${item.manifest.name}`);

    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      if (String(range).startsWith("workspace:") || String(range).startsWith("file:"))
        throw new Error(`${manifest.name} leaked a workspace or local dependency: ${name}`);

      if (plan.names.has(name) && !Bun.semver.satisfies(plan.version, String(range)))
        throw new Error(`${manifest.name} packed incompatible range ${name}@${range}`);
    }

    const files = run("tar", ["-tzf", archive]).split("\n");

    if (files.some((name) => name.includes("/src/") || name.endsWith(".test.d.ts")))
      throw new Error(`${manifest.name} tarball contains source or test declarations`);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    packed.push({ ...item, archive, integrity });
    console.log(`${manifest.name}@${manifest.version} ${integrity}`);
  }

  return packed;
}

function registryIntegrity(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status === 0) return JSON.parse(result.stdout.trim());

  if (/E404/.test(result.stderr)) return null;
  throw new Error(`Cannot check registry state for ${name}@${version}: ${result.stderr}`);
}

function registryTags(name) {
  const result = spawnSync("npm", ["view", name, "dist-tags", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status === 0) return JSON.parse(result.stdout.trim());

  if (/E404/.test(result.stderr)) return {};
  throw new Error(`Cannot check npm dist-tags for ${name}: ${result.stderr}`);
}

async function verifyRegistry(item, version, tag) {
  for (let attempt = 0; attempt < 12; attempt++) {
    if (
      registryIntegrity(item.manifest.name, version) === item.integrity &&
      registryTags(item.manifest.name)[tag] === version
    )
      return;
    await new Promise((done) => setTimeout(done, 5000));
  }

  throw new Error(
    `${item.manifest.name}@${version} did not appear with the expected integrity and ${tag} dist-tag`,
  );
}

function notes(plan) {
  const sections = [];

  for (const item of plan.ordered) {
    const path = join(root, item.path, "CHANGELOG.md");

    if (!existsSync(path)) throw new Error(`Missing changelog for ${item.manifest.name}`);
    const lines = readFileSync(path, "utf8").split("\n");
    const start = lines.findIndex((line) => line === `## ${plan.version}`);

    if (start < 0) throw new Error(`${item.manifest.name} changelog lacks ${plan.version}`);
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));

    const body = lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim();

    sections.push(`## ${item.manifest.name}\n\n${body}`);
  }

  return `# Sandbar v${plan.version}\n\n${sections.join("\n\n")}\n`;
}

const mode = process.argv[2] ?? "check";

if (!["check", "dry-run", "publish"].includes(mode))
  throw new Error(`Unknown release mode: ${mode}`);

const plan = load();

const real = mode === "publish";

const { tag, prerelease } = releaseTag(plan.version);

validateRef(plan.version, real);

if (mode === "check") {
  console.log(
    `Release manifests valid: ${plan.ordered.map((item) => item.manifest.name).join(", ")} @ ${plan.version}`,
  );
  process.exit(0);
}

if (real && (process.env.GITHUB_ACTIONS !== "true" || process.env.RELEASE_APPROVED !== "true"))
  throw new Error("Publication must run from the approved GitHub release job");

const directory = process.env.RELEASE_ARTIFACTS || join(tmpdir(), `sandbar-release-${process.pid}`);

const packed = packAll(plan, directory);

const releaseNotes = notes(plan);

const notesFile = join(directory, "RELEASE_NOTES.md");

writeFileSync(notesFile, releaseNotes);

const metadata = {
  commit: run("git", ["rev-parse", "HEAD"]),
  version: plan.version,
  notesHash: createHash("sha256").update(releaseNotes).digest("hex"),
  packages: packed.map((item) => ({
    name: item.manifest.name,
    archive: basename(item.archive),
    integrity: item.integrity,
  })),
};

if (!real) {
  writeFileSync(join(directory, "release-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
} else {
  const qualified = process.env.RELEASE_QUALIFIED_ARTIFACTS;

  if (!qualified) throw new Error("Missing qualified release artifact directory");
  const expected = JSON.parse(readFileSync(join(qualified, "release-metadata.json"), "utf8"));

  if (JSON.stringify(expected) !== JSON.stringify(metadata))
    throw new Error("Publish tarballs, notes, or commit differ from the qualified dry run");
}

if (!real) {
  console.log(`Dry run complete: ${packed.length} tarballs, npm tag ${tag}, notes ${notesFile}`);
  process.exit(0);
}

const state = packed.map((item) => ({
  item,
  existing: registryIntegrity(item.manifest.name, plan.version),
}));

for (const { item, existing } of state) {
  if (existing && existing !== item.integrity)
    throw new Error(
      `${item.manifest.name}@${plan.version} already exists with different bytes; publication stopped`,
    );
}

for (const { item, existing } of state) {
  if (existing && registryTags(item.manifest.name)[tag] !== plan.version)
    throw new Error(
      `${item.manifest.name}@${plan.version} exists, but npm dist-tag ${tag} does not point to it`,
    );
}

for (const { item, existing } of state) {
  if (!existing) run("npm", ["publish", item.archive, "--tag", tag, "--access", "public"]);
  else
    console.log(`${item.manifest.name}@${plan.version} already published with matching integrity`);
  await verifyRegistry(item, plan.version, tag);
}

const existingRelease = spawnSync(
  "gh",
  ["release", "view", `v${plan.version}`, "--json", "body", "--jq", ".body"],
  {
    cwd: root,
    encoding: "utf8",
  },
);

if (existingRelease.status === 0) {
  if (existingRelease.stdout.trim() !== releaseNotes.trim())
    throw new Error("GitHub release exists with different notes; inspect it manually");
} else {
  const args = [
    "release",
    "create",
    `v${plan.version}`,
    "--verify-tag",
    "--target",
    run("git", ["rev-parse", "HEAD"]),
    "--notes-file",
    notesFile,
  ];

  if (prerelease) args.push("--prerelease");
  run("gh", args);
}

console.log(`Published ${plan.version} with npm tag ${tag} and matching GitHub release notes`);
