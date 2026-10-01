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

const selected = new Map(
  packagePaths.map((path) => {
    const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
    const item = metadata.packages.find((entry) => entry.name === manifest.name);

    if (!item) throw new Error(`Release metadata lacks ${manifest.name}`);

    return [manifest.name, { manifest, tarball: `file:${join(artifacts, item.archive)}` }];
  }),
);

for (const name of ["sandbar-adapter", "sandbar-sdk"])
  if (!selected.has(name)) throw new Error(`Release graph lacks ${name}`);

const sdkName = selected.get("sandbar-sdk").manifest.name;

const adapterName = selected.get("sandbar-adapter").manifest.name;

const cases = [
  {
    name: "adapter",
    packageName: adapterName,
    overrides: [],
    runtime: `
import { defineAdapter } from ${JSON.stringify(adapterName)};
import { adapterSuite } from ${JSON.stringify(`${adapterName}/testing`)};
if (typeof defineAdapter !== "function" || typeof adapterSuite !== "function")
  throw new Error("Packed adapter import failed");
`,
    types: `
import { defineAdapter } from ${JSON.stringify(adapterName)};
import { adapterSuite } from ${JSON.stringify(`${adapterName}/testing`)};
const definition: typeof defineAdapter = defineAdapter;
const suite: typeof adapterSuite = adapterSuite;
void [definition, suite];
`,
  },
  {
    name: "sdk",
    packageName: sdkName,
    overrides: [adapterName],
    runtime: `
import { Sandbar, Image } from ${JSON.stringify(sdkName)};
import { daytona } from ${JSON.stringify(`${sdkName}/daytona`)};
if (typeof Sandbar.connect !== "function" || typeof daytona !== "function" ||
    Image.prepared("fixture").kind !== "prepared")
  throw new Error("Packed SDK import failed");
`,
    types: `
import { Sandbar, Image } from ${JSON.stringify(sdkName)};
import { daytona } from ${JSON.stringify(`${sdkName}/daytona`)};
const direct: typeof Sandbar.connect = Sandbar.connect;
const daytonaFactory: typeof daytona = daytona;
const image = Image.prepared("fixture");
void [direct, daytonaFactory, image];
`,
  },
];

const temporary = mkdtempSync(join(tmpdir(), "sandbar-installers-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}:\n${result.error ?? ""}${result.stdout}${result.stderr}`,
    );
}

try {
  for (const installer of ["npm", "pnpm", "bun"]) {
    for (const scenario of cases) {
      const directory = join(temporary, installer, scenario.name);

      const overrides = Object.fromEntries(
        scenario.overrides.map((name) => {
          if (!selected.get(scenario.packageName).manifest.dependencies?.[name])
            throw new Error(`${scenario.packageName} does not declare ${name}`);

          return [name, selected.get(name).tarball];
        }),
      );

      const packageFile = {
        name: `sandbar-installer-${installer}-${scenario.name}`,
        private: true,
        type: "module",
        dependencies: { [scenario.packageName]: selected.get(scenario.packageName).tarball },
        overrides,
        pnpm: { overrides },
      };

      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify(packageFile, null, 2));
      writeFileSync(join(directory, "consumer.mjs"), scenario.runtime);
      writeFileSync(join(directory, "consumer.ts"), scenario.types);

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

      run(installer, ["install", "--ignore-scripts"], directory);
      run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], directory);
      run("node", ["consumer.mjs"], directory);
      run("bun", ["consumer.mjs"], directory);

      console.log(
        `${installer} installed isolated ${scenario.name}; strict types and runtime imports passed`,
      );
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
