import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessFixture } from "../sdk-qualification/processes.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const packages = [
  ["@sandbar/contracts", "packages/contracts"],
  ["@sandbar/provider-spi", "packages/provider-spi"],
  ["@sandbar/core", "packages/core"],
  ["@sandbar/provider-fake", "packages/providers/fake"],
  ["@sandbar/sdk", "packages/sdk"],
  ["@sandbar/effect-prototype", "packages/effect-prototype"],
];

const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );

  return result.stdout.trim();
};

const temporary = await mkdtemp(join(tmpdir(), "sandbar-effect-packed-"));

const archives = join(temporary, "archives");

const fixture = new ProcessFixture();

try {
  await mkdir(archives);
  const dependencies = { effect: "3.22.2", zod: "4.6.5" };
  const sizes = {};

  for (const [name, directory] of packages) {
    const before = new Set(await readdir(archives));
    run("bun", ["pm", "pack", "--destination", archives], join(root, directory));

    const added = (await readdir(archives)).filter(
      (file) => !before.has(file) && file.endsWith(".tgz"),
    );

    if (added.length !== 1) throw new Error(`Expected one archive for ${name}`);
    const archive = join(archives, added[0]);
    dependencies[name] = `file:${archive}`;
    sizes[name] = (await stat(archive)).size;
  }

  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }),
  );
  await writeFile(
    join(consumer, "consumer.mjs"),
    `
import { EffectCreateClient } from "@sandbar/effect-prototype";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { SandbarError } from "@sandbar/sdk/direct";
const client = new EffectCreateClient({ provider: await fakeProvider({ url: process.env.FAKE_URL, token: process.env.FAKE_TOKEN }) });
try {
  for (const invalid of [
    () => client.sandboxes.create({ environment: { kind: "prepared", value: "" } }),
    () => client.recover({ version: 1, mode: "direct", kind: "create" }),
  ]) {
    try { await invalid(); throw new Error("Invalid input was accepted"); }
    catch (error) {
      if (!(error instanceof SandbarError) || error.code !== "INVALID_ARGUMENT") throw error;
    }
  }
  const box = await client.sandboxes.create({ environment: { kind: "prepared", value: "fake-starter" } });
  if (!box.id.startsWith("fake_sandbox_")) throw new Error("Invalid sandbox");
  process.stdout.write("experimental packed create passed\\n");
} finally { await client.close(); }
`,
  );
  await writeFile(
    join(consumer, "types.ts"),
    `
import { EffectCreateClient } from "@sandbar/effect-prototype";
import type { DirectOptions } from "@sandbar/sdk/direct";
declare const options: DirectOptions;
const client = new EffectCreateClient(options);
const result: Promise<string> = client.sandboxes.create({ environment: { kind: "prepared", value: "fake-starter" } }).then(box => box.id);
void result;
`,
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
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
  run("bun", ["install", "--no-save"], consumer);
  run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], consumer);
  await fixture.startFake();

  for (const runtime of ["node", "bun"])
    console.log(
      `${runtime}: ${run(runtime, ["consumer.mjs"], consumer, { FAKE_URL: fixture.fakeUrl, FAKE_TOKEN: fixture.fakeToken })}`,
    );
  console.log(
    JSON.stringify({
      runtimes: {
        node: run("node", ["--version"], consumer),
        bun: run("bun", ["--version"], consumer),
      },
      archiveBytes: sizes,
    }),
  );
} finally {
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
