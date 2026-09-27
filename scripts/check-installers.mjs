import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const artifacts = process.env.RELEASE_ARTIFACTS;

if (!artifacts) throw new Error("RELEASE_ARTIFACTS must point to qualified tarballs");

const metadata = JSON.parse(readFileSync(join(artifacts, "release-metadata.json"), "utf8"));

const packagePaths = JSON.parse(readFileSync(join(root, "scripts/release-packages.json"), "utf8"));

if (!packagePaths.includes("packages/sdk")) throw new Error("Release graph has no SDK package");

const sdkManifest = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8"));

const sdkName = metadata.packages.find((item) => item.name === sdkManifest.name)?.name;

if (!sdkName) throw new Error("Release metadata has no SDK package");

const dependencies = Object.fromEntries(
  metadata.packages.map((item) => [item.name, `file:${join(artifacts, item.archive)}`]),
);

const source = `
import { Sandbar, Image } from ${JSON.stringify(`${sdkName}/remote`)};
if (typeof Sandbar.connect !== "function" || Image.prepared("fixture").kind !== "prepared") {
  throw new Error("Packed remote SDK import failed");
}
`;

const temporary = mkdtempSync(join(tmpdir(), "sandbar-installers-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error ?? ""}${result.stdout}${result.stderr}`,
    );
}

try {
  for (const installer of ["npm", "pnpm", "bun"]) {
    const directory = join(temporary, installer);

    const packageFile = {
      name: `sandbar-installer-${installer}`,
      private: true,
      type: "module",
      dependencies,
      overrides: dependencies,
      pnpm: { overrides: dependencies },
    };

    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageFile, null, 2));
    writeFileSync(join(directory, "consumer.mjs"), source);
    writeFileSync(join(directory, "consumer.ts"), source);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: ["consumer.ts"],
      }),
    );

    const args =
      installer === "bun" ? ["install", "--ignore-scripts"] : ["install", "--ignore-scripts"];

    run(installer, args, directory);
    run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], directory);
    run("node", ["consumer.mjs"], directory);
    run("bun", ["consumer.mjs"], directory);
    console.log(
      `${installer} installed qualified tarballs; strict types, Node and Bun imports passed`,
    );
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
