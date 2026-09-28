import { execFileSync } from "node:child_process";

const sdkPaths = [
  "packages/sdk",
  "packages/adapter",
  "packages/providers",
  "packages/core",
  "packages/provider-spi",
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "scripts/rewrite-declarations.mjs",
];

/** A reviewed harness branch may qualify unchanged SDK sources already merged on origin/main. */
export function qualificationRevisions(root: string, mergedRef = "origin/main") {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  if (git(["status", "--porcelain"]))
    throw new Error("Live qualification requires a clean checkout");
  const sdkCommit = git(["rev-parse", `${mergedRef}^{commit}`]);
  const harnessCommit = git(["rev-parse", "HEAD"]);

  try {
    git(["merge-base", "--is-ancestor", sdkCommit, "origin/main"]);
    git(["diff", "--quiet", sdkCommit, harnessCommit, "--", ...sdkPaths]);
  } catch {
    throw new Error(
      "Live qualification requires SDK sources and dependency pins identical to a merged origin/main commit",
    );
  }

  return { sdkCommit, harnessCommit };
}
