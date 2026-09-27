import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessFixture } from "./processes.ts";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const packages = [
  ["@sandbar/contracts", "packages/contracts"],
  ["@sandbar/provider-spi", "packages/provider-spi"],
  ["@sandbar/core", "packages/core"],
  ["@sandbar/provider-fake", "packages/providers/fake"],
  ["@sandbar/sdk", "packages/sdk"],
];

const forbidden = new Set([
  "@sandbar/store",
  "@sandbar/service-runtime",
  "hono",
  "drizzle-orm",
  "drizzle-kit",
  "mysql2",
  "better-sqlite3",
  "bun:sqlite",
]);

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed in ${cwd}:\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );

  return result.stdout.trim();
}

async function pack(directory) {
  const manifest = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
  const before = new Set(await readdir(archives));
  run("bun", ["pm", "pack", "--destination", archives], join(root, directory));

  const added = (await readdir(archives)).filter(
    (file) => !before.has(file) && file.endsWith(".tgz"),
  );

  if (added.length !== 1)
    throw new Error(`Expected one archive for ${manifest.name}, got ${added.join(", ")}`);
  const archive = join(archives, added[0]);
  const contents = run("tar", ["-tzf", archive], root).split("\n");

  if (contents.some((path) => path.includes("/src/") || path.endsWith(".test.d.ts")))
    throw new Error(`${manifest.name} archive contains source or test declarations`);
  const packed = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"], root));

  const exports = z
    .record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))
    .parse(packed.exports ?? {});

  for (const value of Object.values(exports)) {
    const stringTarget = z.string().safeParse(value);
    const targets = stringTarget.success ? [stringTarget.data] : Object.values(value);

    if (targets.some((target) => !String(target).startsWith("./dist/")))
      throw new Error(`${manifest.name} has an export outside dist`);
  }

  return archive;
}

function inspectGraph(directory, initial) {
  const visited = new Set();

  function walk(name) {
    if (visited.has(name)) return;

    if (forbidden.has(name)) throw new Error(`Forbidden runtime dependency ${name}`);
    visited.add(name);
    const file = join(directory, "node_modules", ...name.split("/"), "package.json");
    const manifest = JSON.parse(run("cat", [file], directory));

    for (const dependency of Object.keys(manifest.dependencies ?? {})) walk(dependency);
  }

  for (const name of initial) walk(name);

  return [...visited];
}

async function consumer(directory, dependencies, source) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      { private: true, type: "module", dependencies, overrides: dependencies },
      null,
      2,
    ),
  );
  await writeFile(join(directory, "consumer.mjs"), source);
  run("bun", ["install", "--no-save"], directory);
}

async function checkTypes(directory, mode) {
  const source =
    mode === "direct"
      ? `
import { Sandbar, Image } from "@sandbar/sdk/direct";
import { fakeProvider } from "@sandbar/provider-fake/client";
async function flow() {
  const provider = await fakeProvider({ url: "http://127.0.0.1:1234", token: "example-token-123456" });
  const client = Sandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const result = await box.exec({ command: { kind: "argv", argv: ["fixture"] } });
  const text: string = result.stdoutText();
  await client.close();
  return text;
}
void flow;
`
      : `
import { Sandbar, Image } from "@sandbar/sdk/remote";
async function flow() {
  const client = Sandbar.connect({ url: "https://sandbar.example", token: "example-token-123456", projectId: "project_1" });
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const result = await box.exec({ command: { kind: "argv", argv: ["fixture"] } });
  const text: string = result.stdoutText();
  await client.close();
  return text;
}
void flow;
`;

  await writeFile(join(directory, "types.ts"), source);
  await writeFile(
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
      include: ["types.ts"],
    }),
  );
  run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], directory);
}

const directSource = `
import { OutcomeUnknownError as RootUnknown } from "@sandbar/sdk";
import { Sandbar, Image, OutcomeUnknownError as DirectUnknown } from "@sandbar/sdk/direct";
import { OutcomeUnknownError as RemoteUnknown } from "@sandbar/sdk/remote";
import { fakeProvider } from "@sandbar/provider-fake/client";
if (RootUnknown !== DirectUnknown || RootUnknown !== RemoteUnknown) throw new Error("SDK entry points disagree on error identity");
const client = Sandbar.direct({ provider: await fakeProvider({ url: process.env.FAKE_URL, token: process.env.FAKE_TOKEN }) });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const command = { kind: "argv", argv: ["fixture", "packed"] };
  const result = await box.exec({ command });
  if (result.exitCode !== 0 || result.stdout.length !== 4 || result.stdout[0] !== 255 || result.stdout[1] !== 0) throw new Error("Binary execution output changed");
  const bytes = Uint8Array.from([0, 255, 129]);
  await box.writeFile("/data/packed", bytes);
  const loaded = await box.readFile("/data/packed");
  if (loaded.length !== bytes.length || loaded.some((value, index) => value !== bytes[index])) throw new Error("Binary file changed");
  await box.destroy();
  process.stdout.write("packed direct flow passed\\n");
} finally { await client.close(); }
`;

const remoteSource = `
import { OutcomeUnknownError as RootUnknown } from "@sandbar/sdk";
import { Sandbar, Image, OutcomeUnknownError as RemoteUnknown } from "@sandbar/sdk/remote";
if (RootUnknown !== RemoteUnknown) throw new Error("Remote-only SDK entry point disagrees on error identity");
if (typeof Sandbar.connect !== "function" || Image.prepared("fake-starter").kind !== "prepared") throw new Error("Remote-only export unavailable");
process.stdout.write("packed remote import passed\\n");
`;

const temporary = await mkdtemp(join(tmpdir(), "sandbar-packed-sdk-"));

const archives = join(temporary, "archives");

const fixture = new ProcessFixture();

try {
  await mkdir(archives);
  const packed = {};

  for (const [name, directory] of packages) packed[name] = await pack(directory);

  const remoteDeps = Object.fromEntries(
    packages.flatMap(([name]) =>
      name === "@sandbar/provider-fake" ? [] : [[name, `file:${packed[name]}`]],
    ),
  );

  const directDeps = Object.fromEntries(packages.map(([name]) => [name, `file:${packed[name]}`]));
  const remote = join(temporary, "remote-consumer");
  const direct = join(temporary, "direct-consumer");
  await consumer(remote, remoteDeps, remoteSource);
  await consumer(direct, directDeps, directSource);
  await checkTypes(direct, "direct");
  await checkTypes(remote, "remote");
  inspectGraph(remote, ["@sandbar/sdk"]);
  inspectGraph(direct, ["@sandbar/sdk", "@sandbar/provider-fake"]);
  console.log(
    `Runtimes: Node ${run("node", ["--version"], remote)}, Bun ${run("bun", ["--version"], remote)}`,
  );

  for (const runtime of ["node", "bun"]) run(runtime, ["consumer.mjs"], remote);
  await fixture.startFake();

  for (const runtime of ["node", "bun"]) {
    await fixture.fakeControl("/_test/seed", {
      submissionId: "*",
      action: "exec",
      behavior: "normal",
      command: {
        command: { kind: "argv", argv: ["fixture", "packed"] },
        exitCode: 0,
        stdoutBase64: Buffer.from([255, 0, 128, 97]).toString("base64"),
      },
    });
    console.log(
      `${runtime}: ${run(runtime, ["consumer.mjs"], direct, { FAKE_URL: fixture.fakeUrl, FAKE_TOKEN: fixture.fakeToken })}`,
    );
  }

  console.log(
    `Packed consumer graph: ${inspectGraph(direct, ["@sandbar/sdk", "@sandbar/provider-fake"]).join(", ")}`,
  );
} finally {
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
