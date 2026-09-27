import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseReport, renderLiveMatrix } from "./report";

const directory = fileURLToPath(new URL("./results/", import.meta.url));

const output = fileURLToPath(
  new URL(
    "../../../apps/docs/src/content/docs/docs/providers/live-qualification.md",
    import.meta.url,
  ),
);

const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

const reports = await Promise.all(
  files.map(async (name) => parseReport(JSON.parse(await readFile(join(directory, name), "utf8")))),
);

const generated = renderLiveMatrix(reports);

if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== generated)
    throw new Error("Provider live matrix has drifted; run bun provider-qualification/render.ts");
} else {
  await writeFile(output, generated);
}
