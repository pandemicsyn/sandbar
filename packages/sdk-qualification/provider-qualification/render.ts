import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  officialSupport,
  renderSupportDetails,
  renderSupportMatrix,
  renderSupportOverview,
} from "./support";
import { loadProviderProfile } from "./profile";
import { parseReport, renderLiveMatrix } from "./report";

const option = (name: string) => {
  const index = process.argv.indexOf(name);

  if (index < 0) return undefined;
  const value = process.argv[index + 1];

  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);

  return resolve(value);
};

const profilePath = option("--profile");

const external = profilePath ? await loadProviderProfile(profilePath) : undefined;

const metadata = external ? [external.support] : officialSupport;

const directory = option("--results") ?? fileURLToPath(new URL("./results/", import.meta.url));

const output = fileURLToPath(new URL("./LIVE-EVIDENCE.md", import.meta.url));

const supportPage = fileURLToPath(
  new URL("../../../apps/docs/src/content/docs/docs/providers/support.md", import.meta.url),
);

const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();

if (files.some((name) => !metadata.some((profile) => name === `${profile.id}.json`)))
  throw new Error("Keep one results JSON per declared provider");

const reports = await Promise.all(
  files.map(async (name) => {
    const report = parseReport(JSON.parse(await readFile(join(directory, name), "utf8")));

    if (
      [...report.records, ...(report.historicalEvidence ?? [])].some(
        (record) => `${record.provider}.json` !== name,
      )
    )
      throw new Error(`Provider summary identity differs: ${name}`);

    return report;
  }),
);

// Experimental official adapters keep their results beside their own packages.
const packageReports = external
  ? []
  : await Promise.all(
      ["boxd", "vercel"].map(async (name) =>
        parseReport(
          JSON.parse(
            await readFile(
              fileURLToPath(
                new URL(
                  `../../providers/${name}/qualification/results/${name}.json`,
                  import.meta.url,
                ),
              ),
              "utf8",
            ),
          ),
        ),
      ),
    );

const outputDirectory = option("--output");

if (external && !outputDirectory) throw new Error("External metadata requires --output directory");

const targets = [
  [
    outputDirectory ? join(outputDirectory, "live-qualification.md") : output,
    external
      ? renderLiveMatrix(
          reports,
          Object.fromEntries(metadata.map((profile) => [profile.id, profile.name])),
          "./support.md",
        )
      : // The repository copy has no docs frontmatter; it links back to the published overview.
        renderLiveMatrix(
          reports,
          Object.fromEntries(metadata.map((profile) => [profile.id, profile.name])),
          "https://sandbarsdk.dev/docs/providers/support/",
        ).replace(/^---\n[\s\S]*?\n---\n\n/, "# Live test evidence\n\n") +
        `\n${renderSupportDetails(reports, metadata)}`,
  ],
  [
    outputDirectory ? join(outputDirectory, "support.md") : supportPage,
    external
      ? renderSupportMatrix(reports, metadata)
      : renderSupportOverview([...reports, ...packageReports], metadata),
  ],
] as const;

for (const [path, generated] of targets) {
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== generated)
      throw new Error(`Provider support page drifted: ${path}`);
  } else await writeFile(path, generated);
}
