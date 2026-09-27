import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const temporary = mkdtempSync(join(tmpdir(), "sandbar-release-fixture-"));

let sdkName = "";

function run(command, args, cwd = temporary, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error ?? ""}${result.stdout}${result.stderr}`,
    );

  return result.stdout.trim();
}

function copyTree(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !path.split("/").includes("node_modules") && !path.split("/").includes(".git"),
  });
}

function changeset(name, summary) {
  writeFileSync(
    join(temporary, ".changeset", `${name}.md`),
    `---\n${JSON.stringify(sdkName)}: patch\n---\n\n${summary}\n`,
  );
}

try {
  for (const name of ["package.json", "bun.lock", "tsconfig.json", ".gitignore"]) {
    cpSync(join(root, name), join(temporary, name));
  }

  for (const name of ["packages", "scripts", ".changeset"]) {
    copyTree(join(root, name), join(temporary, name));
  }

  for (const app of readdirSync(join(root, "apps"))) {
    const manifest = join(root, "apps", app, "package.json");

    if (existsSync(manifest)) {
      mkdirSync(join(temporary, "apps", app), { recursive: true });
      cpSync(manifest, join(temporary, "apps", app, "package.json"));
    }
  }

  for (const file of readdirSync(join(temporary, ".changeset"))) {
    if (file.endsWith(".md") && file !== "README.md") rmSync(join(temporary, ".changeset", file));
  }

  const paths = JSON.parse(readFileSync(join(temporary, "scripts/release-packages.json"), "utf8"));
  const names = [];

  for (const path of paths) {
    const file = join(temporary, path, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8"));

    manifest.version = "0.1.0";
    manifest.private = false;
    manifest.repository = { type: "git", url: "git+https://github.com/pandemicsyn/sandbar.git" };
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(
      join(temporary, path, "CHANGELOG.md"),
      "# Changelog\n\n## 0.1.0\n\nFixture release.\n",
    );
    names.push(manifest.name);

    if (path === "packages/sdk") sdkName = manifest.name;
  }

  if (!sdkName) throw new Error("Fixture release graph has no SDK");

  const configPath = join(temporary, ".changeset/config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));

  config.fixed = [names];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  run("bun", ["scripts/refresh-workspace-lock.mjs"]);

  if (!existsSync(join(temporary, "node_modules/.bin/changeset")))
    run("bun", ["add", "-d", "@changesets/cli@3.0.0", "@changesets/changelog-github@1.0.0"]);

  run("git", ["init", "-b", "main"]);
  run("git", ["config", "user.name", "Release Fixture"]);
  run("git", ["config", "user.email", "release-fixture@example.invalid"]);
  run("git", ["add", "."]);
  run("git", ["commit", "-m", "fixture baseline"]);

  const githubToken = process.env.GITHUB_TOKEN || run("gh", ["auth", "token"]);

  changeset("fixture-stable", "Verify a stable fixture release.");
  run("bunx", ["changeset", "version"], temporary, { GITHUB_TOKEN: githubToken });
  run("bun", ["scripts/refresh-workspace-lock.mjs"]);
  run("bun", ["install", "--frozen-lockfile"]);
  run("bun", ["scripts/release.mjs", "check"]);
  const stableArtifacts = join(temporary, "stable-artifacts");

  run("bun", ["scripts/release.mjs", "dry-run"], temporary, { RELEASE_ARTIFACTS: stableArtifacts });
  run("bun", ["scripts/check-installers.mjs"], temporary, { RELEASE_ARTIFACTS: stableArtifacts });
  run("bun", ["packages/sdk-qualification/package-smoke.mjs"]);
  console.log(
    "Stable fixture: version, frozen lock, tarballs, npm/pnpm/Bun installs, Node/Bun consumers passed",
  );

  run("git", ["add", ".changeset", "packages", "package.json", "bun.lock"]);
  run("git", ["commit", "-m", "version fixture packages"]);
  run("git", ["update-ref", "refs/remotes/origin/main", run("git", ["rev-parse", "HEAD"])]);
  run("git", ["tag", "v0.1.1"]);
  rmSync(stableArtifacts, { recursive: true, force: true });
  run("bun", ["scripts/release.mjs", "dry-run"], temporary, { RELEASE_ARTIFACTS: stableArtifacts });

  const qualified = JSON.parse(
    readFileSync(join(stableArtifacts, "release-metadata.json"), "utf8"),
  );

  const registryFile = join(temporary, "fake-registry.json");

  const releaseFile = join(temporary, "fake-github-release.json");

  const fakeBin = join(temporary, "fake-bin");

  const first = qualified.packages[0];

  mkdirSync(fakeBin);
  writeFileSync(
    registryFile,
    JSON.stringify({
      packages: { [first.name]: first.integrity },
      tags: { [first.name]: { latest: "0.1.1" } },
    }),
  );
  writeFileSync(
    join(fakeBin, "npm"),
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const state = JSON.parse(fs.readFileSync(process.env.FAKE_REGISTRY_STATE, "utf8"));
const metadata = JSON.parse(fs.readFileSync(path.join(process.env.RELEASE_QUALIFIED_ARTIFACTS, "release-metadata.json"), "utf8"));
const args = process.argv.slice(2);
if (args[0] === "view") {
  const name = args[2] === "dist-tags" ? args[1] : args[1].slice(0, args[1].lastIndexOf("@"));
  if (!state.packages[name]) { console.error("E404"); process.exit(1); }
  console.log(JSON.stringify(args[2] === "dist-tags" ? state.tags[name] : state.packages[name]));
} else if (args[0] === "publish") {
  const item = metadata.packages.find(x => x.archive === path.basename(args[1]));
  if (!item || state.packages[item.name]) process.exit(2);
  state.packages[item.name] = item.integrity;
  state.tags[item.name] = { [args[args.indexOf("--tag") + 1]]: metadata.version };
  fs.writeFileSync(process.env.FAKE_REGISTRY_STATE, JSON.stringify(state));
} else process.exit(3);
`,
  );
  writeFileSync(
    join(fakeBin, "gh"),
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "release") process.exit(3);
if (args[1] === "view") {
  if (!fs.existsSync(process.env.FAKE_RELEASE_FILE)) process.exit(1);
  console.log(JSON.parse(fs.readFileSync(process.env.FAKE_RELEASE_FILE, "utf8")).body);
} else if (args[1] === "create") {
  const file = args[args.indexOf("--notes-file") + 1];
  fs.writeFileSync(process.env.FAKE_RELEASE_FILE, JSON.stringify({ body: fs.readFileSync(file, "utf8") }));
} else process.exit(3);
`,
  );
  chmodSync(join(fakeBin, "npm"), 0o755);
  chmodSync(join(fakeBin, "gh"), 0o755);

  const publishEnv = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    RELEASE_ARTIFACTS: join(temporary, "publish-artifacts"),
    RELEASE_QUALIFIED_ARTIFACTS: stableArtifacts,
    RELEASE_REF: "v0.1.1",
    RELEASE_APPROVED: "true",
    GITHUB_ACTIONS: "true",
    FAKE_REGISTRY_STATE: registryFile,
    FAKE_RELEASE_FILE: releaseFile,
  };

  run("bun", ["scripts/release.mjs", "publish"], temporary, publishEnv);
  const published = JSON.parse(readFileSync(registryFile, "utf8"));

  if (
    Object.keys(published.packages).length !== qualified.packages.length ||
    !existsSync(releaseFile)
  )
    throw new Error(
      "Partial publish fixture did not complete remaining packages and release notes",
    );

  rmSync(publishEnv.RELEASE_ARTIFACTS, { recursive: true, force: true });
  run("bun", ["scripts/release.mjs", "publish"], temporary, publishEnv);

  const conflicting = {
    ...published,
    packages: { ...published.packages, [first.name]: "sha512-conflicting-fixture" },
  };

  writeFileSync(registryFile, JSON.stringify(conflicting));
  rmSync(publishEnv.RELEASE_ARTIFACTS, { recursive: true, force: true });

  const blocked = spawnSync("bun", ["scripts/release.mjs", "publish"], {
    cwd: temporary,
    env: { ...process.env, ...publishEnv },
    encoding: "utf8",
  });

  if (blocked.status === 0 || !blocked.stderr.includes("already exists with different bytes"))
    throw new Error("Conflicting existing registry version was not rejected");

  const wrongTag = {
    ...published,
    tags: { ...published.tags, [first.name]: { latest: "0.1.0" } },
  };

  writeFileSync(registryFile, JSON.stringify(wrongTag));
  rmSync(publishEnv.RELEASE_ARTIFACTS, { recursive: true, force: true });

  const tagBlocked = spawnSync("bun", ["scripts/release.mjs", "publish"], {
    cwd: temporary,
    env: { ...process.env, ...publishEnv },
    encoding: "utf8",
  });

  if (tagBlocked.status === 0 || !tagBlocked.stderr.includes("dist-tag"))
    throw new Error("Existing registry version with wrong dist-tag was not rejected");

  writeFileSync(registryFile, JSON.stringify(published));
  console.log(
    "Mock registry: partial publish completed, exact rerun skipped, conflicting bytes and tags rejected",
  );

  const lockPath = join(temporary, "bun.lock");
  const beforeMutation = readFileSync(lockPath, "utf8");
  const beforePath = join(temporary, "bun-before-negative.lock");

  writeFileSync(beforePath, beforeMutation);
  const mutated = Bun.JSONC.parse(beforeMutation);

  const entry = Object.entries(mutated.packages).find(
    ([, value]) =>
      Array.isArray(value) &&
      !String(value[0]).includes("@workspace:") &&
      String(value[3]).startsWith("sha512-"),
  );

  if (!entry) throw new Error("No external lock integrity entry to mutate");

  entry[1][3] = "sha512-deliberately-invalid-fixture";
  writeFileSync(lockPath, JSON.stringify(mutated, null, 2));

  const rejected = spawnSync(
    "bun",
    ["scripts/refresh-workspace-lock.mjs", "--verify-external", beforePath, lockPath],
    {
      cwd: temporary,
      encoding: "utf8",
    },
  );

  if (
    rejected.status === 0 ||
    !rejected.stderr.includes("external package resolutions or integrity")
  )
    throw new Error("External lock drift was not rejected");

  writeFileSync(lockPath, beforeMutation);
  console.log("Changed external lock integrity was rejected before version commit");

  run("bunx", ["changeset", "pre", "enter", "next"]);
  changeset("fixture-next", "Verify a prerelease fixture.");
  run("bunx", ["changeset", "version"], temporary, { GITHUB_TOKEN: githubToken });
  run("bun", ["scripts/refresh-workspace-lock.mjs"]);
  run("bun", ["install", "--frozen-lockfile"]);
  const nextArtifacts = join(temporary, "next-artifacts");

  const nextOutput = run("bun", ["scripts/release.mjs", "dry-run"], temporary, {
    RELEASE_ARTIFACTS: nextArtifacts,
  });

  if (!nextOutput.includes("npm tag next")) throw new Error("Prerelease did not select next");

  const latest = spawnSync("bun", ["scripts/release.mjs", "check"], {
    cwd: temporary,
    env: { ...process.env, NPM_TAG: "latest" },
    encoding: "utf8",
  });

  if (latest.status === 0 || !latest.stderr.includes("Prereleases cannot be published to latest"))
    throw new Error("Prerelease promotion to latest was not rejected");

  run("bun", ["scripts/check-installers.mjs"], temporary, { RELEASE_ARTIFACTS: nextArtifacts });
  run("bun", ["packages/sdk-qualification/package-smoke.mjs"]);
  console.log("Prerelease fixture: next tag, latest rejection and packed consumers passed");
} finally {
  if (process.env.KEEP_RELEASE_FIXTURE === "true") console.log(`Fixture retained at ${temporary}`);
  else rmSync(temporary, { recursive: true, force: true });
}
