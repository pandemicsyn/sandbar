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

for (const name of [
  "@sandbar-sdk/adapter",
  "sandbar-sdk",
  "@sandbar-sdk/daytona",
  "@sandbar-sdk/e2b",
  "@sandbar-sdk/vercel",
  "@sandbar-sdk/boxd",
  "@sandbar-sdk/boat",
  "@sandbar-sdk/runloop",
  "@sandbar-sdk/modal",
  "@sandbar-sdk/cli",
])
  if (!selected.has(name)) throw new Error(`Release graph lacks ${name}`);

const sdkName = selected.get("sandbar-sdk").manifest.name;

const adapterName = selected.get("@sandbar-sdk/adapter").manifest.name;

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

if (typeof Sandbar.connect !== "function" ||
    Image.prepared("fixture").kind !== "prepared")
  throw new Error("Packed SDK import failed");
`,
    types: `
import { Sandbar, Image } from ${JSON.stringify(sdkName)};

const direct: typeof Sandbar.connect = Sandbar.connect;

const image = Image.prepared("fixture");
void [direct, image];
`,
  },
];

for (const provider of ["daytona", "e2b"]) {
  const options =
    provider === "daytona" ? { apiKey: "fixture", target: "us" } : { apiKey: "fixture" };

  cases.push({
    name: provider,
    packageName: `@sandbar-sdk/${provider}`,
    overrides: [adapterName],
    runtime: `import { ${provider} } from "@sandbar-sdk/${provider}"; if (!${provider}(${JSON.stringify(options)}).bound) throw Error("Unbound factory");`,
    types: `import { ${provider} } from "@sandbar-sdk/${provider}"; const bound = ${provider}(${JSON.stringify(options)}); void bound;`,
  });
}

cases.push({
  name: "vercel",
  packageName: "@sandbar-sdk/vercel",
  overrides: [adapterName],
  runtime: `import { vercel, createVercelAdapter } from "@sandbar-sdk/vercel";
if (vercel.name !== "vercel" || createVercelAdapter().name !== "vercel") throw Error("Invalid Vercel definition");
vercel.config.parse({ teamId: "team", projectId: "project" });`,
  types: `import { vercel, createVercelAdapter } from "@sandbar-sdk/vercel";
const definition: typeof vercel = createVercelAdapter(); void definition;`,
});

cases.push({
  name: "boxd",
  packageName: "@sandbar-sdk/boxd",
  overrides: [adapterName],
  runtime: `import { boxdAdapter } from "@sandbar-sdk/boxd"; if (boxdAdapter.name !== "boxd") throw Error("Unexpected adapter");`,
  types: `import { boxdAdapter } from "@sandbar-sdk/boxd"; const name: string = boxdAdapter.name; void name;`,
});

cases.push({
  name: "boat",
  packageName: "@sandbar-sdk/boat",
  overrides: [adapterName],
  runtime: `import { boatAdapter } from "@sandbar-sdk/boat"; if (boatAdapter.name !== "boat") throw Error("Unexpected adapter");`,
  types: `import { boatAdapter } from "@sandbar-sdk/boat"; const name: string = boatAdapter.name; void name;`,
});

cases.push({
  name: "runloop",
  packageName: "@sandbar-sdk/runloop",
  overrides: [adapterName],
  runtime: `import { runloopAdapter } from "@sandbar-sdk/runloop"; if (runloopAdapter.name !== "runloop") throw Error("Unexpected adapter");`,
  types: `import { runloopAdapter } from "@sandbar-sdk/runloop"; const name: string = runloopAdapter.name; void name;`,
});

cases.push({
  name: "modal",
  packageName: "@sandbar-sdk/modal",
  overrides: [adapterName],
  runtime: `import { modalAdapter } from "@sandbar-sdk/modal"; if (modalAdapter.name !== "modal") throw Error("Unexpected adapter");`,
  types: `import { modalAdapter } from "@sandbar-sdk/modal"; const name: string = modalAdapter.name; void name;`,
});

const cliVersion = selected.get("@sandbar-sdk/cli").manifest.version;

// The CLI is a binary, not a library: each installer must link `sandbar` and run it.
cases.push({
  name: "cli",
  packageName: "@sandbar-sdk/cli",
  overrides: [adapterName, sdkName],
  runtime: `import { execFileSync } from "node:child_process";
const output = execFileSync("node_modules/.bin/sandbar", ["--version"], { encoding: "utf8" });
if (output.trim() !== ${JSON.stringify(cliVersion)}) throw Error(\`Unexpected CLI version \${output}\`);`,
  types: "export {};",
});

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
