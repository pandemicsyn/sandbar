import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "./openapi";

const path = fileURLToPath(new URL("../openapi.json", import.meta.url));
const output = `${JSON.stringify(openApiDocument, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(path, "utf8").catch(() => "");
  if (current !== output) { console.error("OpenAPI document differs from executable contract schemas"); process.exitCode = 1; }
} else {
  await writeFile(path, output);
}
