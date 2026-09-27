import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const lockPath = join(root, "bun.lock");

function external(text) {
  const lock = Bun.JSONC.parse(text);

  return Object.fromEntries(
    Object.entries(lock.packages ?? {}).filter(
      ([, value]) => !Array.isArray(value) || !String(value[0]).includes("@workspace:"),
    ),
  );
}

function assertExternalUnchanged(before, after) {
  if (!isDeepStrictEqual(external(before), external(after)))
    throw new Error(
      "Lock refresh changed external package resolutions or integrity; inspect bun.lock before preparing a version branch",
    );
}

if (process.argv[2] === "--verify-external") {
  assertExternalUnchanged(
    readFileSync(process.argv[3], "utf8"),
    readFileSync(process.argv[4], "utf8"),
  );
  console.log("External lock resolutions and integrity unchanged");
  process.exit(0);
}

const before = readFileSync(lockPath, "utf8");

let updated = before;

const releasePaths = JSON.parse(readFileSync(join(root, "scripts/release-packages.json"), "utf8"));

for (const path of releasePaths) {
  const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
  const marker = `    ${JSON.stringify(path)}: {`;
  const start = updated.indexOf(marker);

  if (start < 0 || updated.indexOf(marker, start + marker.length) >= 0)
    throw new Error(`Expected one workspace lock entry for ${path}`);

  const end = updated.indexOf("\n    },", start);

  if (end < 0) throw new Error(`Unterminated workspace lock entry for ${path}`);

  const block = updated.slice(start, end);
  const versionLine = /(\n      "version": ")[^"]+("[,\n])/;

  if (!versionLine.test(block)) throw new Error(`Missing workspace lock version for ${path}`);

  updated =
    updated.slice(0, start) +
    block.replace(
      versionLine,
      (_match, prefix, suffix) => `${prefix}${manifest.version}${suffix}`,
    ) +
    updated.slice(end);
}

assertExternalUnchanged(before, updated);

writeFileSync(lockPath, updated);

const install = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });

if (install.error || install.status !== 0)
  throw new Error(
    `Frozen Bun install failed after workspace lock update: ${install.error ?? install.status}`,
  );

assertExternalUnchanged(before, readFileSync(lockPath, "utf8"));

console.log(
  "Workspace lock versions refreshed; external package resolutions and integrity unchanged",
);
