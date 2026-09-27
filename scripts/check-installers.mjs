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

const runtimeSource = `
import { Sandbar, Image } from ${JSON.stringify(sdkName)};
import { daytona } from ${JSON.stringify(`${sdkName}/daytona`)};
import { modal } from ${JSON.stringify(`${sdkName}/modal`)};
import { defineAdapter } from "sandbar-adapter";
import { Sandbar as RemoteSandbar } from "sandbar-service/client";
if (typeof Sandbar.connect !== "function" ||
    typeof RemoteSandbar.connect !== "function" ||
    typeof daytona !== "function" ||
    typeof modal !== "function" ||
    typeof defineAdapter !== "function" ||
    Image.prepared("fixture").kind !== "prepared") {
  throw new Error("Packed public graph import failed");
}
`;

const typeSource = `
import { Sandbar, Image } from ${JSON.stringify(sdkName)};
import { daytona } from ${JSON.stringify(`${sdkName}/daytona`)};
import { modal } from ${JSON.stringify(`${sdkName}/modal`)};
import { defineAdapter } from "sandbar-adapter";
import { Sandbar as RemoteSandbar } from "sandbar-service/client";
import type { ServiceHandle } from "sandbar-service";
const direct: typeof Sandbar.connect = Sandbar.connect;
const remote: typeof RemoteSandbar.connect = RemoteSandbar.connect;
const factory: typeof daytona = daytona;
const modalFactory: typeof modal = modal;
const authoring: typeof defineAdapter = defineAdapter;
const image = Image.prepared("fixture");
function typedService(value: ServiceHandle): ServiceHandle { return value; }
void [direct, remote, factory, modalFactory, authoring, image, typedService];
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
    writeFileSync(join(directory, "consumer.mjs"), runtimeSource);
    writeFileSync(join(directory, "consumer.ts"), typeSource);
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
