import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../../../packages/cli/src/main.ts", import.meta.url));

const target = fileURLToPath(new URL("../src/content/docs/docs/cli/reference.md", import.meta.url));

// The page is rendered from `sandbar schema`, so it cannot drift from the CLI's command table.
const schema = JSON.parse(
  execFileSync(process.execPath, [main, "schema"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  }),
);

const cell = (text) => text.replaceAll("|", "\\|");

/** A table padded the way the repository formatter writes it, so --check stays stable. */
const markdownTable = (header, rows) => {
  const widths = header.map((title, column) =>
    Math.max(title.length, 3, ...rows.map((row) => row[column].length)),
  );

  const line = (row) => `| ${row.map((text, column) => text.padEnd(widths[column])).join(" | ")} |`;

  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
};

const table = (flags) => {
  const rows = Object.entries(flags)
    .filter(([name]) => name !== "help")
    .map(([name, spec]) => [
      `\`${cell(`${spec.short ? `-${spec.short}, ` : ""}--${name}${spec.value ? ` <${spec.value}>` : ""}`)}\``,
      cell(spec.description),
    ]);

  return rows.length ? markdownTable(["Flag", "Description"], rows) : "";
};

const code = (text) => text.replaceAll(/\{[^ ]*\}/g, (document) => `\`${document}\``);

const sections = schema.commands.map((command) =>
  [
    `## ${command.name}`,
    command.summary.endsWith(".") ? command.summary : `${command.summary}.`,
    "```sh\n" + command.usage + "\n```",
    table(command.flags),
    command.remoteExit
      ? "Exits with the remote command's exit code; failures of the CLI itself exit 125."
      : "",
    command.examples.length ? "Examples:\n\n```sh\n" + command.examples.join("\n") + "\n```" : "",
  ]
    .filter(Boolean)
    .join("\n\n"),
);

const output = `---
title: Command reference
description: Every sandbar command, flag and exit code, generated from the CLI.
---

> Generated from \`sandbar schema\`. Run \`bun run --cwd apps/docs cli:generate\` after changing a command.

## Global flags

These work with every command.

${table(schema.globalFlags)}

## Output

${code(schema.output.json).replace("With --json", "With `--json`")}. Diagnostics always go to stderr.

${code(schema.output.exec).replace(/^exec, sh and run/, "`exec`, `sh` and `run`")}.

## Exit codes

${markdownTable(
  ["Code", "Meaning"],
  schema.exitCodes.map((entry) => [String(entry.code), cell(entry.meaning)]),
)}

${sections.join("\n\n")}
`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");

  if (current !== output) {
    console.error(`${target} is stale; run bun run --cwd apps/docs cli:generate`);
    process.exit(1);
  }
} else await writeFile(target, output);
