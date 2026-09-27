import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../../../");
const lint = join(root, "node_modules/.bin/oxlint");
const config = join(root, ".oxlintrc.json");

function reportsPreferMatch(source: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), "sandbar-effect-lint-"));

  try {
    const file = join(directory, "probe.ts");
    writeFileSync(file, source);

    const result = Bun.spawnSync([lint, "--config", config, "--format", "json", file], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    const diagnostics = JSON.parse(output).diagnostics as Array<{ code: string }>;

    return diagnostics.some((diagnostic) => diagnostic.code === "anti-slop-effect(prefer-effect-match)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("suggests Match for repeated comparisons of a stable identifier", () => {
  expect(reportsPreferMatch('const kind = "a";\n\nexport const result = kind === "a" ? 1 : kind === "b" ? 2 : 3;\n')).toBe(true);
});

test("does not suggest changing evaluation count for a call or getter", () => {
  expect(reportsPreferMatch('const readTag = () => "a";\n\nexport const result = readTag() === "a" ? 1 : readTag() === "b" ? 2 : 3;\n')).toBe(false);
  expect(reportsPreferMatch('const source = { get tag() { return "a"; } };\n\nexport const result = source.tag === "a" ? 1 : source.tag === "b" ? 2 : 3;\n')).toBe(false);
});

test("does not suggest replacing coercive comparisons with strict matching", () => {
  expect(reportsPreferMatch('const value: unknown = 0;\n\nexport const result = value == "0" ? 1 : value == "1" ? 2 : 3;\n')).toBe(false);
});
