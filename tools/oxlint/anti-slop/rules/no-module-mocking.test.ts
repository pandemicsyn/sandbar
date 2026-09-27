import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../../");
const lint = join(root, "node_modules/.bin/oxlint");
const config = join(root, ".oxlintrc.json");

function reportsModuleMocking(source: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), "sandbar-mocking-lint-"));

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

    return diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(no-module-mocking)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("rejects module mocking through test framework namespace imports", () => {
  expect(reportsModuleMocking('import * as vitest from "vitest";\n\nvitest.vi.mock("./module");\n')).toBe(true);
  expect(reportsModuleMocking('import * as globals from "@jest/globals";\n\nglobals.jest.mock("./module");\n')).toBe(true);
});

test("keeps unrelated namespaces valid", () => {
  expect(reportsModuleMocking('import * as helpers from "./helpers";\n\nhelpers.vi.mock("./module");\n')).toBe(false);
});
