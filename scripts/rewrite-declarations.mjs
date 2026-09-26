import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2] ?? "dist";
const extension = (path) => /\.(?:js|mjs|cjs|json|d\.ts)$/.test(path) ? path : `${path}.js`;

async function rewrite(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) { await rewrite(file); continue; }
    if (!entry.name.endsWith(".d.ts")) continue;
    const original = await readFile(file, "utf8");
    const updated = original
      .replace(/(\bfrom\s+["'])(\.\.?\/[^"']+)(["'])/g, (_match, before, target, after) => `${before}${extension(target)}${after}`)
      .replace(/(\bimport\(\s*["'])(\.\.?\/[^"']+)(["']\s*\))/g, (_match, before, target, after) => `${before}${extension(target)}${after}`);
    if (updated !== original) await writeFile(file, updated);
  }
}

await rewrite(directory);
