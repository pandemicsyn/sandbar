import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const target = fileURLToPath(
  new URL("../src/content/docs/docs/reference/generated-typescript.md", import.meta.url),
);

const surfaces = [
  ["SDK", "sandbar-sdk", "packages/sdk/dist/index.d.ts"],
  ["Daytona adapter", "sandbar-sdk/daytona", "packages/sdk/dist/daytona.d.ts"],
  ["E2B adapter", "sandbar-sdk/e2b", "packages/sdk/dist/e2b.d.ts"],
  ["Experimental Modal adapter", "sandbar-modal", "packages/providers/modal/dist/index.d.ts"],
  ["Adapter authoring", "sandbar-adapter", "packages/adapter/dist/index.d.ts"],
  ["Adapter test kit", "sandbar-adapter/testing", "packages/adapter/dist/testing.d.ts"],
];

const kindOf = (node) => {
  if (ts.isClassDeclaration(node)) return "class";

  if (ts.isInterfaceDeclaration(node)) return "interface";

  if (ts.isTypeAliasDeclaration(node)) return "type";

  if (ts.isFunctionDeclaration(node)) return "function";

  if (ts.isVariableStatement(node)) return "value";

  if (ts.isEnumDeclaration(node)) return "enum";

  return "declaration";
};

const entries = async (path) => {
  const source = ts.createSourceFile(
    path,
    await readFile(`${root}${path}`, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  if (source.parseDiagnostics.length) throw Error(`Invalid declaration file: ${path}`);
  const names = new Map();

  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause))
        for (const element of node.exportClause.elements)
          names.set(
            element.name.text,
            node.isTypeOnly || element.isTypeOnly ? "type" : "re-export",
          );
      continue;
    }

    if (
      !ts.canHaveModifiers(node) ||
      !ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;

    if (ts.isVariableStatement(node)) {
      for (const item of node.declarationList.declarations)
        if (ts.isIdentifier(item.name)) names.set(item.name.text, "value");
    } else if ("name" in node && node.name && ts.isIdentifier(node.name))
      names.set(node.name.text, kindOf(node));
  }

  return [...names].sort(([a], [b]) => a.localeCompare(b));
};

const lines = [
  "---",
  "title: Generated TypeScript API index",
  "description: Exported API names generated from the built package declarations.",
  "---",
  "",
  "> Generated from the package declaration files. Run `bun run --cwd apps/docs typescript:generate` after building packages. The [TypeScript SDK reference](/docs/reference/typescript/) explains behavior and recovery guarantees.",
  "",
];

for (const [title, packageName, path] of surfaces) {
  const rows = (await entries(path)).map(([name, kind]) => [`\`${name}\``, kind]);
  const nameWidth = Math.max("Export".length, ...rows.map(([name]) => name.length));
  const kindWidth = Math.max("Kind".length, ...rows.map(([, kind]) => kind.length));

  lines.push(
    `## ${title}`,
    "",
    `Import from \`${packageName}\`.`,
    "",
    `| ${"Export".padEnd(nameWidth)} | ${"Kind".padEnd(kindWidth)} |`,
    `| ${"-".repeat(nameWidth)} | ${"-".repeat(kindWidth)} |`,
    ...rows.map(([name, kind]) => `| ${name.padEnd(nameWidth)} | ${kind.padEnd(kindWidth)} |`),
    "",
  );
}

const output = lines.join("\n");

if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8").catch(() => "")) !== output) {
    console.error("TypeScript API index drift: run bun run --cwd apps/docs typescript:generate");
    process.exitCode = 1;
  }
} else await writeFile(target, output);
