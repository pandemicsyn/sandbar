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

/** Branch and merged runs identify the exact clean sources they exercise. */
export function qualificationRevisions(root: string, sourceRef = "HEAD") {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  if (git(["status", "--porcelain"]))
    throw new Error("Live qualification requires a clean checkout");
  const sdkCommit = git(["rev-parse", `${sourceRef}^{commit}`]);
  const harnessCommit = git(["rev-parse", "HEAD"]);

  try {
    git(["diff", "--quiet", sdkCommit, harnessCommit, "--", ...sdkPaths]);
  } catch {
    throw new Error(
      "Live qualification requires SDK sources and dependency pins identical to the selected source commit",
    );
  }

  return { sdkCommit, harnessCommit };
}

/** Unverified evidence never blocks owned cleanup; only suppress its public certification report. */
export function reconciliationRevisions(root: string, sourceRef = "HEAD") {
  try {
    return qualificationRevisions(root, sourceRef);
  } catch {
    return undefined;
  }
}
