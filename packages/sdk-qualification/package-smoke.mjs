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
  ["@sandbar/adapter", "packages/adapter"],
  ["@sandbar/provider-spi", "packages/provider-spi"],
  ["@sandbar/core", "packages/core"],
  ["@sandbar/provider-fake", "packages/providers/fake"],
  ["@sandbar/provider-daytona", "packages/providers/daytona"],
  ["@sandbar/provider-modal", "packages/providers/modal"],
  ["sandbar-sdk", "packages/sdk"],
  ["@sandbar/service", "packages/service"],
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
  const packageDirectory = resolve(root, directory);
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const before = new Set(await readdir(archives));
  run("bun", ["pm", "pack", "--destination", archives], packageDirectory);

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

async function consumer(directory, dependencies, overrides, source) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies, overrides }, null, 2),
  );
  await writeFile(join(directory, "consumer.mjs"), source);
  run("bun", ["install", "--no-save"], directory);
}

async function checkTypes(directory, mode) {
  let source;

  if (mode === "service")
    source = `
import { createService, type ServiceHandle } from "@sandbar/service";
import { asyncAcme } from "@acme/sandbar-adapter";
async function flow(): Promise<ServiceHandle> {
  return createService({
    storage: { url: "/tmp/control.sqlite", keyFile: "/tmp/key" },
    auth: { setupTokenFile: "/tmp/setup" },
    adapters: [asyncAcme],
  });
}
void flow;
`;
  else if (mode === "custom")
    source = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { acme } from "@acme/sandbar-adapter";
async function flow() {
  const client = await Sandbar.connect({ adapter: acme, config: { region: "us" }, credentials: { token: "fixture" } });
  const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
  await box.destroy();
  await client.close();
}
// @ts-expect-error config must include region
void Sandbar.connect({ adapter: acme, config: {}, credentials: { token: "fixture" } });
void flow;
`;
  else if (mode === "modal")
    source = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { modalProvider } from "@sandbar/provider-modal";
async function flow() {
  const provider = await modalProvider({ tokenId: "ak-fixture", tokenSecret: "as-fixture", appName: "existing", environment: "main" });
  const client = Sandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked" });
  const bytes: Uint8Array = await box.readFile("/file");
  await client.close();
  return bytes;
}
void flow;
`;
  else if (mode === "daytona")
    source = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { daytonaProvider } from "@sandbar/provider-daytona";
async function flow() {
  const provider = await daytonaProvider({ apiKey: "fixture", target: "us" });
  const client = Sandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: Image.prepared("snap-1") });
  const result = await box.exec({ command: { kind: "shell", script: "printf ready" } });
  const text = result.stdoutText();
  await client.close();
  return text;
}
void flow;
`;
  else if (mode === "direct")
    source = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { fakeProvider } from "@sandbar/provider-fake/client";
async function flow() {
  const provider = await fakeProvider({ url: "http://127.0.0.1:1234", token: "example-token-123456" });
  const client = Sandbar.direct({ provider });
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const argv = ["fixture"] as const;
  const result = await box.exec(argv);
  const operation = await box.submitExec(argv);
  await operation.wait();
  const text: string = result.stdoutText();
  await client.close();
  return text;
}
void flow;
`;
  else
    source = `
import { Sandbar, Image } from "sandbar-sdk/remote";
async function flow() {
  const client = Sandbar.connect({ url: "https://sandbar.example", token: "example-token-123456", projectId: "project_1" });
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const argv = ["fixture"] as const;
  const result = await box.exec(argv);
  const operation = await box.submitExec(argv);
  await operation.wait();
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
import { OutcomeUnknownError as RootUnknown } from "sandbar-sdk";
import { Sandbar, Image, OutcomeUnknownError as DirectUnknown } from "sandbar-sdk/direct";
import { OutcomeUnknownError as RemoteUnknown } from "sandbar-sdk/remote";
import { fakeProvider } from "@sandbar/provider-fake/client";
if (RootUnknown !== DirectUnknown || RootUnknown !== RemoteUnknown) throw new Error("SDK entry points disagree on error identity");
const client = Sandbar.direct({ provider: await fakeProvider({ url: process.env.FAKE_URL, token: process.env.FAKE_TOKEN }) });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const command = { kind: "argv", argv: ["fixture", "packed"] };
  const result = await box.exec(command.argv);
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
import { OutcomeUnknownError as RootUnknown } from "sandbar-sdk";
import { Sandbar, Image, OutcomeUnknownError as RemoteUnknown } from "sandbar-sdk/remote";
if (RootUnknown !== RemoteUnknown) throw new Error("Remote-only SDK entry point disagrees on error identity");
if (typeof Sandbar.connect !== "function" || Image.prepared("fake-starter").kind !== "prepared") throw new Error("Remote-only export unavailable");
process.stdout.write("packed remote import passed\\n");
`;

const daytonaSource = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { daytonaProvider } from "@sandbar/provider-daytona";
let name = "", mutations = 0;
const origin = "https://proxy.app.daytona.io/toolbox";
const native = (state = "started") => ({ id: "native-1", name, organizationId: "org-1", target: "us", state, networkBlockAll: true, public: false, toolboxProxyUrl: origin });
const mock = async (input, init = {}) => {
  const url = new URL(String(input));
  const json = value => Response.json(value);
  if (url.pathname === "/api/api-keys/current") return json({ organizationId: "org-1" });
  if (url.pathname === "/api/organizations/org-1") return json({ id: "org-1", sandboxLimitedNetworkEgress: false });
  if (url.pathname === "/api/regions") return json([{ id: "us", name: "United States", regionType: "shared", organizationId: "org-1" }]);
  if (url.pathname === "/api/snapshots/snap-1") return json({ id: "snap-1", organizationId: "org-1", state: "active", regionIds: ["us"], sandboxClass: "linux-vm" });
  if (url.pathname === "/api/sandbox" && init.method === "POST") { mutations++; name = JSON.parse(init.body).name; return json(native()); }
  if (url.pathname === "/api/sandbox/native-1" && init.method === "DELETE") { mutations++; return json(native("destroyed")); }
  if (url.pathname === "/api/sandbox/native-1") return json(native());
  if (url.pathname.endsWith("/process/execute")) { mutations++; return json({ exitCode: 0, result: "SANDBAR-EXEC-V1\\n0\\n2\\n1\\n 00 ff\\nSANDBAR-STDERR\\n 7f\\nSANDBAR-END\\n" }); }
  if (url.pathname.endsWith("/files/upload-v2")) { mutations++; return json({ name: "file", path: "/file", type: "file" }); }
  if (url.pathname.endsWith("/files/download")) return new Response(Uint8Array.from([0,255]));
  throw new Error("Unexpected fixture request: " + url.pathname);
};
const provider = await daytonaProvider({ apiKey: "fixture-only", target: "us", fetch: mock });
const client = Sandbar.direct({ provider });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("snap-1") });
  const result = await box.exec({ command: { kind: "shell", script: "printf test" } });
  if (result.stdout[0] !== 0 || result.stdout[1] !== 255 || result.stderr[0] !== 127) throw new Error("Binary output mismatch");
  await box.writeFile("/file", Uint8Array.from([0,255]), { overwrite: true });
  const bytes = await box.readFile("/file");
  if (bytes[0] !== 0 || bytes[1] !== 255) throw new Error("Binary file mismatch");
  await box.destroy();
  if (mutations !== 4) throw new Error("Mutation replay in packed consumer: " + mutations);
  process.stdout.write("packed Daytona fixture flow passed\\n");
} finally { await client.close(); }
`;

const modalSource = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { modalProvider } from "@sandbar/provider-modal";
let creates = 0, terminates = 0, closed = 0;
const records = new Map();
const transport = {
  async lookupApp(name, environment) { if (name !== "existing" || environment !== "main") throw Error("Wrong App"); return "ap-fixture"; },
  async imageExists(id) { return id === "im-fixture"; },
  async create(input) {
    if (input.appId !== "ap-fixture" || input.imageId !== "im-fixture" || input.timeoutMs !== 300000 || input.regions?.[0] !== "us-east-1") throw Error("Wrong create input");
    creates++;
    records.set(input.name, { id: "sb-1", tags: input.tags, running: true });
    return "sb-1";
  },
  async findByName(_app, _environment, name) { return records.get(name) ?? null; },
  async *list(appId) { if (appId !== "ap-fixture") throw Error("Wrong inventory scope"); for (const record of records.values()) if (record.running) yield record; },
  async readBytes(id, path, maxBytes) { if (id !== "sb-1" || path !== "/file" || maxBytes !== 1048576) throw Error("Wrong read"); return Uint8Array.from([0, 255, 128]); },
  async terminate(id) { if (id !== "sb-1") throw Error("Wrong termination"); terminates++; for (const record of records.values()) record.running = false; return true; },
  close() { closed++; },
};
const provider = await modalProvider({ tokenId: "ak-fixture", tokenSecret: "as-fixture", appName: "existing", environment: "main", region: "us-east-1", timeoutSeconds: 300 }, transport);
const client = Sandbar.direct({ provider });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked", region: "us-east-1" });
  const bytes = await box.readFile("/file");
  if (bytes.length !== 3 || bytes[0] !== 0 || bytes[1] !== 255 || bytes[2] !== 128) throw Error("Binary read mismatch");
  await box.destroy();
  if (creates !== 1 || terminates !== 1) throw Error("Mutation replay in packed Modal consumer");
} finally { await client.close(); }
if (closed !== 1) throw Error("Owned provider was not released");
process.stdout.write("packed Modal fixture flow passed\\n");
`;

const externalAdapterSource = `
import { z } from "zod";
import { defineAdapter } from "@sandbar/adapter";
export const metrics = { creates: 0, destroys: 0, closes: 0, observes: 0 };
export const acme = defineAdapter({
  name: "example.acme",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials, host }) {
    if (credentials.token !== "fixture") throw Error("Wrong fixture token");
    host.onClose(() => { metrics.closes++; });
    return {
      scope: { authority: { kind: "account", id: "fixture-account" }, partition: { region: config.region } },
      supports: { images: ["prepared"], network: ["blocked"] },
      async create(input, ctx) {
        if (!ctx.submissionId || input.image.value !== "image-1") throw Error("Wrong request");
        metrics.creates++;
        return { id: "box-1", state: "running" };
      },
      async destroy(box, _ctx) {
        if (box.id !== "box-1") throw Error("Wrong sandbox");
        metrics.destroys++;
        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});
export const asyncAcme = defineAdapter({
  name: "example.async-acme",
  config: z.strictObject({ region: z.string().min(1) }),
  credentials: z.strictObject({ token: z.string().min(1) }),
  async connect({ config, credentials }) {
    if (credentials.token !== "fixture") throw Error("Wrong fixture token");
    return {
      scope: { authority: { kind: "account", id: "fixture-account" }, partition: { region: config.region } },
      supports: { images: ["prepared"], network: ["blocked"] },
      create: {
        recovery: { version: 1, token: z.strictObject({ jobId: z.string() }) },
        async submit(_input, ctx) { metrics.creates++; return ctx.pending({ jobId: "job-1" }, { pollAfterMs: 1000 }); },
        async observe(attempt) {
          if (z.strictObject({ jobId: z.string() }).parse(attempt.token).jobId !== "job-1") throw Error("Wrong recovery token");
          metrics.observes++;
          return { id: "box-1", state: "running" };
        },
      },
      async destroy() { metrics.destroys++; return { computeStopped: true, retainedResources: [] }; },
    };
  },
});
`;

const customSource = `
import { Sandbar, Image } from "sandbar-sdk/direct";
import { acme, metrics } from "@acme/sandbar-adapter";
const client = await Sandbar.connect({
  adapter: acme,
  config: { region: "us" },
  credentials: { token: "fixture" },
});
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
  if (box.supports("exec")) throw Error("Unsupported operation was advertised");
  await box.destroy();
} finally { await client.close(); }
if (metrics.creates !== 1 || metrics.destroys !== 1 || metrics.closes !== 1) throw Error("Mutation or release count mismatch");
process.stdout.write("packed external adapter flow passed\\n");
`;

const serviceSource = `
import { createService } from "@sandbar/service";
import { asyncAcme, metrics } from "@acme/sandbar-adapter";
import { writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "sandbar-packed-service-"));
const keyFile = join(directory, "key"), setupTokenFile = join(directory, "setup"), url = join(directory, "control.sqlite");
await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32))); await chmod(keyFile, 0o600);
await writeFile(setupTokenFile, "long-packed-service-setup-token"); await chmod(setupTokenFile, 0o600);
const options = { storage: { url, keyFile }, auth: { setupTokenFile }, adapters: [asyncAcme] };
let service = await createService(options);
let origin = "";
let bearer = "";
const start = async () => { const binding = await service.listen({ port: 0 }); origin = \`http://127.0.0.1:\${binding.port}\`; };
const request = async (path, method = "GET", body, key) => {
  const headers = {};
  if (bearer) headers.Authorization = \`Bearer \${bearer}\`;
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(origin + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
const until = async (check) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw Error("Timed out waiting for packed service recovery");
};
try {
  await start();
  const setup = await request("/v1/setup", "POST", { setupToken: "long-packed-service-setup-token" });
  bearer = setup.body.token;
  if (setup.status !== 200 && setup.status !== 201) throw Error("Setup failed: " + JSON.stringify(setup));
  const project = await request("/v1/projects", "POST", { name: "Packed" });
  const projectId = project.body.id;
  const conn = await request(\`/v1/projects/\${projectId}/provider-connections\`, "POST", {
    provider: "example.async-acme", name: "Acme", configuration: { region: "us" }, credentials: { token: "fixture" },
  });
  if (conn.status !== 201) throw Error("Connection failed: " + JSON.stringify(conn));
  const verified = await request(\`/v1/projects/\${projectId}/provider-connections/\${conn.body.id}/verify\`, "POST");
  if (verified.status !== 200) throw Error("Verification failed");
  const admitted = await request(\`/v1/projects/\${projectId}/sandboxes\`, "POST", {
    environment: { kind: "prepared", imageId: "image-1" }, network: { policy: "blocked" }, connectionId: conn.body.id,
  }, Bun.randomUUIDv7());
  if (admitted.status !== 202) throw Error("Admission failed: " + JSON.stringify(admitted));
  const operationId = admitted.body.operation.id;
  await until(async () => {
    const op = await request(\`/v1/projects/\${projectId}/operations/\${operationId}\`);
    return metrics.creates === 1 && op.body.status === "running";
  });
  await service.close();
  service = await createService(options);
  await start();
  await request(\`/v1/projects/\${projectId}/operations/\${operationId}/reconcile\`, "POST");
  await until(async () => (await request(\`/v1/projects/\${projectId}/operations/\${operationId}\`)).body.status === "succeeded");
  if (metrics.creates !== 1 || metrics.observes < 1) throw Error("Packed service replayed an effect or skipped observation");
  process.stdout.write("packed service HTTP restart flow passed\\n");
} finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
`;

const temporary = await mkdtemp(join(tmpdir(), "sandbar-packed-sdk-"));

const archives = join(temporary, "archives");

const fixture = new ProcessFixture();

try {
  await mkdir(archives);
  const packed = {};

  for (const [name, directory] of packages) packed[name] = await pack(directory);

  const archiveOverrides = Object.fromEntries(
    packages.map(([name]) => [name, `file:${packed[name]}`]),
  );

  const externalDir = join(temporary, "external-adapter");
  await mkdir(join(externalDir, "src"), { recursive: true });
  await writeFile(join(externalDir, "package.json"), JSON.stringify({
    name: "@acme/sandbar-adapter",
    version: "0.0.1",
    type: "module",
    files: ["dist"],
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    peerDependencies: { "@sandbar/adapter": "0.0.0" },
    overrides: { "@sandbar/adapter": archiveOverrides["@sandbar/adapter"] },
    dependencies: {
      "@sandbar/adapter": archiveOverrides["@sandbar/adapter"],
      zod: "4.6.5",
    },
  }, null, 2));
  await writeFile(join(externalDir, "src/index.ts"), externalAdapterSource);
  await writeFile(join(externalDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, declaration: true, outDir: "dist", skipLibCheck: false, types: [],
    },
    include: ["src/index.ts"],
  }));
  run("bun", ["install", "--no-save"], externalDir);
  run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], externalDir);
  const externalManifest = JSON.parse(await readFile(join(externalDir, "package.json"), "utf8"));
  delete externalManifest.dependencies["@sandbar/adapter"];
  delete externalManifest.overrides;
  await writeFile(join(externalDir, "package.json"), JSON.stringify(externalManifest, null, 2));
  const externalArchive = await pack(externalDir);

  const remoteDeps = { "sandbar-sdk": archiveOverrides["sandbar-sdk"] };

  const customDeps = {
    ...remoteDeps,
    "@acme/sandbar-adapter": `file:${externalArchive}`,
  };

  const directDeps = {
    ...remoteDeps,
    "@sandbar/provider-fake": archiveOverrides["@sandbar/provider-fake"],
  };

  const daytonaDeps = {
    ...remoteDeps,
    "@sandbar/provider-daytona": archiveOverrides["@sandbar/provider-daytona"],
  };

  const modalDeps = {
    ...remoteDeps,
    "@sandbar/provider-modal": archiveOverrides["@sandbar/provider-modal"],
  };

  const remote = join(temporary, "remote-consumer");
  const custom = join(temporary, "custom-consumer");
  const direct = join(temporary, "direct-consumer");
  const daytona = join(temporary, "daytona-consumer");
  const modal = join(temporary, "modal-consumer");
  const service = join(temporary, "service-consumer");
  await consumer(remote, remoteDeps, archiveOverrides, remoteSource);
  await consumer(custom, customDeps, archiveOverrides, customSource);
  await consumer(direct, directDeps, archiveOverrides, directSource);
  await consumer(daytona, daytonaDeps, archiveOverrides, daytonaSource);
  await consumer(modal, modalDeps, archiveOverrides, modalSource);
  await consumer(service, { ...customDeps, "@sandbar/service": archiveOverrides["@sandbar/service"] }, archiveOverrides, serviceSource);

  if ((await readdir(join(remote, "node_modules", "@sandbar"))).includes("provider-fake"))
    throw new Error("Remote-only consumer installed the fake provider");
  await checkTypes(custom, "custom");
  await checkTypes(service, "service");
  await checkTypes(direct, "direct");
  await checkTypes(daytona, "daytona");
  await checkTypes(modal, "modal");
  await checkTypes(remote, "remote");
  inspectGraph(remote, ["sandbar-sdk"]);
  inspectGraph(custom, ["sandbar-sdk", "@acme/sandbar-adapter"]);
  inspectGraph(direct, ["sandbar-sdk", "@sandbar/provider-fake"]);
  inspectGraph(daytona, ["sandbar-sdk", "@sandbar/provider-daytona"]);
  inspectGraph(modal, ["sandbar-sdk", "@sandbar/provider-modal"]);
  console.log(`bun: ${run("bun", ["consumer.mjs"], service)}`);
  console.log(
    `Runtimes: Node ${run("node", ["--version"], remote)}, Bun ${run("bun", ["--version"], remote)}`,
  );

  for (const runtime of ["node", "bun"]) run(runtime, ["consumer.mjs"], remote);
  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], custom)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], daytona)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], modal)}`);
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
    `Packed consumer graph: ${inspectGraph(direct, ["sandbar-sdk", "@sandbar/provider-fake"]).join(", ")}`,
  );
} finally {
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
