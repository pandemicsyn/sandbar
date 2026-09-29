import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../", import.meta.url));

const guide = await readFile(resolve(docs, "src/content/docs/docs/observability.mdx"), "utf8");

const snippets = [...guide.matchAll(/```ts\s*\n([\s\S]*?)```/g)].map((match) => match[1]);

assert(snippets.length > 0, "The actual guide must supply its TypeScript snippets");

const directory = await mkdtemp(resolve(docs, "examples/.observability-snippets-"));

try {
  const files = [];

  for (const [index, source] of snippets.entries()) {
    const path = resolve(directory, `snippet-${index}.ts`);
    await writeFile(path, `${source}\nexport {};\n`);
    files.push(path);
  }

  // Code components render these same checked files, without a copied code fence.
  for (const [, relative] of guide.matchAll(/import \w+ from "([^"\n]+\.ts)\?raw"/g)) {
    const path = resolve(docs, "src/content/docs/docs", relative);
    await readFile(path);
    files.push(path);
  }

  assert.equal(files.length, snippets.length + 6, "All six rendered source files must be checked");
  const config = resolve(directory, "tsconfig.json");
  await writeFile(config, JSON.stringify({ extends: resolve(docs, "../../tsconfig.json"), files }));

  const result = spawnSync(
    "bun",
    [resolve(docs, "../../node_modules/typescript/bin/tsc"), "-p", config],
    {
      cwd: docs,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(`Compiled ${snippets.length} actual guide snippets and 6 rendered example files`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
