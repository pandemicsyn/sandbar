import { spawnSync } from "node:child_process";
import {
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
