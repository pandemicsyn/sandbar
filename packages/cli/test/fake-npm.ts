#!/usr/bin/env bun
// A stand-in for npm in `sandbar adapter` tests: it never reaches a registry. Each installed
// package re-exports the test fixture under every official adapter export name.
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { providers } from "../src/providers";

const args = process.argv.slice(2);

if (process.env.FAKE_NPM_LOG)
  await appendFile(process.env.FAKE_NPM_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);

if (process.env.FAKE_NPM_FAIL) {
  console.error("npm error code E404\nnpm error 404 Not Found - GET https://registry.example/x");
  process.exit(1);
}

const prefixAt = args.indexOf("--prefix");

const prefix = prefixAt === -1 ? process.cwd() : args[prefixAt + 1]!;

const specs = args.filter(
  (arg, index) => index > 0 && !arg.startsWith("-") && index !== prefixAt + 1,
);

const manifestPath = join(prefix, "package.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const fixture = join(import.meta.dir, "fake-adapter.ts");

const exportNames = [...new Set(providers.map((provider) => provider.export))];

for (const spec of specs) {
  const at = spec.indexOf("@", 1);
  const name = at === -1 ? spec : spec.slice(0, at);
  const version = at === -1 || !/^\d/.test(spec.slice(at + 1)) ? "9.9.9" : spec.slice(at + 1);
  const directory = join(prefix, "node_modules", name);

  if (args[0] === "uninstall") {
    await rm(directory, { recursive: true, force: true });
    delete manifest.dependencies?.[name];
    continue;
  }

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name, version, type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(directory, "index.js"),
    name.includes("not-an-adapter")
      ? "export const helper = 1;\n"
      : `export { fake, ${exportNames.map((exported) => `fake as ${exported}`).join(", ")} } from ${JSON.stringify(fixture)};\n`,
  );
  manifest.dependencies = { ...manifest.dependencies, [name]: version };
}

await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`changed ${specs.length} packages`);
