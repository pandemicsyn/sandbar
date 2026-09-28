import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualificationRevisions, reconciliationRevisions } from "./revisions";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("only unchanged merged SDK sources qualify from a clean harness branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbar-revisions-"));
  directories.push(root);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  await mkdir(join(root, "packages/sdk"), { recursive: true });
  await writeFile(join(root, "packages/sdk/source.ts"), "export const version = 1;\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "merged SDK"]);
  const sdkCommit = git(["rev-parse", "HEAD"]);
  git(["update-ref", "refs/remotes/origin/main", sdkCommit]);
  await writeFile(join(root, "harness.ts"), "// qualification harness\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "reviewed harness"]);
  expect(qualificationRevisions(root)).toEqual({
    sdkCommit,
    harnessCommit: git(["rev-parse", "HEAD"]),
  });
  expect(reconciliationRevisions(root)).toEqual({
    sdkCommit,
    harnessCommit: git(["rev-parse", "HEAD"]),
  });
  expect(reconciliationRevisions(root, "HEAD")).toBeUndefined();
  expect(() => qualificationRevisions(root, "HEAD")).toThrow("merged origin/main");
  await writeFile(join(root, "packages/sdk/source.ts"), "export const version = 2;\n");
  expect(reconciliationRevisions(root)).toBeUndefined();
  expect(() => qualificationRevisions(root)).toThrow("clean checkout");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "unmerged SDK behavior"]);
  expect(reconciliationRevisions(root)).toBeUndefined();
  expect(() => qualificationRevisions(root)).toThrow("merged origin/main");
});
