import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessFixture } from "./processes.ts";
import { checkRecoveryTypes } from "./recovery-types.mjs";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const packages = [
  ["sandbar-adapter", "packages/adapter"],
  ["@sandbar/provider-spi", "packages/provider-spi"],
  ["@sandbar/provider-fake", "packages/providers/fake"],
  ["@sandbar/provider-daytona", "packages/providers/daytona"],
  ["sandbar-modal", "packages/providers/modal"],
  ["@sandbar/provider-e2b", "packages/providers/e2b"],
  ["sandbar-sdk", "packages/sdk"],
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

  if (mode === "observability")
    source = `
import { type TracerProvider } from "@opentelemetry/api";
import { Sandbar, type ObservabilityOptions, diagnosticContext } from "sandbar-sdk";
import { acme } from "@acme/sandbar-adapter";
async function flow(provider: TracerProvider) {
  const options: ObservabilityOptions = { tracing: { tracerProvider: provider } };
  const client = await Sandbar.connect({ adapter: acme, config: { region: "us" }, credentials: { token: "fixture" }, ...options });
  const safe = diagnosticContext(new Error("private"));
  await client.close();
  return safe.recoveryAvailable;
}
void flow;
`;
  else if (mode === "custom")
    source = `
import { Sandbar, Image, type ReadOptions, type SandboxHandle } from "sandbar-sdk";
import { acme } from "@acme/sandbar-adapter";
async function flow() {
  const client = await Sandbar.connect({ adapter: acme, config: { region: "us" }, credentials: { token: "fixture" } });
  const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
  const handle: SandboxHandle = box;
  const options: ReadOptions = { signal: new AbortController().signal };
  await handle.inspect(options);
  await handle.inspect({ ...options, pollMs: 500 });
  await handle.readFile("/file", options);
  await handle.readFile("/file");
  await box.destroy();
  await client.close();
}
// @ts-expect-error config must include region
void Sandbar.connect({ adapter: acme, config: {}, credentials: { token: "fixture" } });
void flow;
`;
  else if (mode === "modal")
    source = `
import { Sandbar, Image } from "sandbar-sdk";
import { modalAdapter } from "sandbar-modal";
async function flow() {
  const client = await Sandbar.connect({ adapter: modalAdapter, config: { appName: "existing", environment: "main" }, credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" } });
  const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked" });
  const bytes: Uint8Array = await box.readFile("/file");
  const exec = await box.exec({ command: { kind: "argv", argv: ["printf", "ready"] }, cwd: "/tmp", env: { KEY: "value" }, maxOutputBytes: 16 });
  const code: number | null = exec.exitCode;
  await box.writeFile("/file", new Uint8Array([0, 255]), { overwrite: false });
  const image = Image.oci("python:3.12-slim");
  await client.close();
  return { bytes, code, image };
}
void flow;
`;
  else if (mode === "daytona")
    source = `
import { Sandbar, Image } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
async function flow() {
  const client = await Sandbar.connect(daytona({ target: "us", apiKey: "fixture", ttlMinutes: 15 }));
  const built = await client.images.build({ source: Image.oci("alpine:3.21") });
  await client.sandboxes.create({ environment: Image.prepared(built.prepared), networkPolicy: "blocked" });
  const box = await client.sandboxes.create({ environment: Image.prepared("snap-1") });
  const result = await box.exec({ command: { kind: "shell", script: "printf ready" } });
  const text = result.stdoutText();
  await client.close();
  return text;
}
void flow;
`;
  else if (mode === "e2b")
    source = `
import { Sandbar, Image } from "sandbar-sdk";
import { e2b, createE2BAdapter } from "sandbar-sdk/e2b";
async function flow() {
  const client = await Sandbar.connect(e2b({ apiKey: "fixture" }));
  const built = await client.images.build({ source: Image.oci("node:24") });
  const prepared = Image.prepared(built.prepared);
  const builtBox = await client.sandboxes.create({ environment: prepared, networkPolicy: "blocked" });
  await builtBox.destroy();
  const box = await client.sandboxes.create({ environment: Image.prepared("template_1"), networkPolicy: "blocked" });
  const output = await box.exec({ command: { kind: "argv", argv: ["printf", "test"] } });
  const bytes: Uint8Array = await box.readFile("/tmp/file");
  await box.writeFile("/tmp/file", bytes, { overwrite: false });
  await client.close();
  return output;
}
void e2b({ apiKey: "fixture", templateId: "template_1" });
void createE2BAdapter;
void flow;
`;
  else if (mode === "builtins")
    source = `
import { Sandbar } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";
async function flow() {
  const daytonaClient = await Sandbar.connect(daytona({ apiKey: "fixture", target: "us" }));
  const e2bClient = await Sandbar.connect(e2b({ apiKey: "fixture", teamId: "team_1", templateId: "template_1" }));
  await daytonaClient.close();
  await e2bClient.close();
}
// @ts-expect-error Daytona requires an API key
void daytona({ target: "us" });
void e2b({ apiKey: "fixture", teamId: "team_1" });
void e2b({ apiKey: "fixture" });
void flow;
`;
  else if (mode === "direct")
    source = `
import { Sandbar, Image, type SandbarClient, type SandboxHandle, type DirectSandbarClient, type DirectSandboxHandle, type OutputPreview, type ExecOutput, outputText } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake/adapter";
async function flow() {
  const client: DirectSandbarClient = await Sandbar.connect({ adapter: createFakeAdapter({ url: "http://127.0.0.1:1234", token: "example-token-123456" }), config: {}, credentials: {} });
  const box: DirectSandboxHandle = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const commonClient: SandbarClient = client;
  const commonSandbox: SandboxHandle = box;
  const destroy: SandboxHandle["destroy"] = box.destroy;
  void commonClient; void commonSandbox; void destroy;
  const argv = ["fixture"] as const;
  const result = await box.exec(argv);
  const operation = await box.submitExec(argv);
  await operation.wait();
  const text: string = result.stdoutText();
  const oldNumeric: (maxBytes?: number) => string = result.stdoutText;
  const oldStderr: (maxBytes?: number) => string = result.stderrText;
  const oldOutputText: (bytes: Uint8Array, maxBytes?: number) => string = outputText;
  const preview: OutputPreview = result.stdoutPreview({ maxBytes: 4096 });
  const full: string = result.stdoutText({ full: true });
  const stderr: string = result.stderrText({ full: true });
  const standalone: string = outputText(result.stdout, { full: true });
  function acceptsOutput(output: ExecOutput) { return output.stdoutText(100); }
  void oldNumeric; void oldStderr; void oldOutputText; void preview; void full; void stderr; void standalone; void acceptsOutput;
  // @ts-expect-error full mode cannot mix in a display bound
  result.stdoutText({ full: true, maxBytes: 1 });
  // @ts-expect-error preview options cannot select full mode
  result.stderrPreview({ full: true });
  const volume=await client.volumes.create({name:"consumer-state"});
  const mounted=await client.sandboxes.create({environment:Image.prepared("base"),mounts:[volume.at("/mnt/data")]});
  const captured=await box.snapshot();
  const snapshot=await client.snapshots.get(captured.snapshot.reference);
  const restored=await snapshot.restore({networkPolicy:"blocked"});
  if(!restored.reference)throw Error("Restored sandbox reference missing");
  const reopenedBox=await client.sandboxes.get(JSON.parse(JSON.stringify(restored.reference)));
  if(reopenedBox.id!==restored.id||(await reopenedBox.inspect()).state!=="running")throw Error("Restored sandbox reopen failed");
  await restored.destroy();
  await mounted.destroy({storage:"allow-unconfirmed"});
  await snapshot.delete();await volume.delete();
  await client.close();
  return text;
}
void flow;
`;
  else throw new Error(`Unknown typecheck mode: ${mode}`);

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
import { Sandbar, Image, outputText } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake/adapter";
if (RootUnknown.name !== "OutcomeUnknownError") throw new Error("SDK error export unavailable");
const client = await Sandbar.connect({ adapter: createFakeAdapter({ url: process.env.FAKE_URL, token: process.env.FAKE_TOKEN }), config: {}, credentials: {} });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const command = { kind: "argv", argv: ["fixture", "packed"] };
  const result = await box.exec(command.argv);
  if (result.exitCode !== 0 || result.stdout.length !== 4 || result.stdout[0] !== 255 || result.stdout[1] !== 0) throw new Error("Binary execution output changed");
  if (result.stdoutText(1) !== "�…" || result.stderrText(0) !== "") throw new Error("Numeric text helpers changed");
  if (outputText(result.stdout, { full: true }) !== result.stdoutText({ full: true })) throw new Error("Full helpers disagree");
  const report = await box.exec(["fixture", "json"]);
  const preview = report.stdoutPreview({ maxBytes: 4096 });
  if (!preview.shortened || preview.text !== report.stdoutText(4096)) throw new Error("Preview metadata changed");
  if (report.truncated) throw new Error("Captured report may be incomplete");
  const parsed = JSON.parse(report.stdoutText({ full: true }));
  if (parsed.payload.length !== 20_000 || report.stderrPreview().shortened || report.stderrText({ full: true }) !== "diagnostic") throw new Error("Full JSON or independent stderr failed");
  const bytes = Uint8Array.from([0, 255, 129]);
  await box.writeFile("/data/packed", bytes);
  const loaded = await box.readFile("/data/packed");
  if (loaded.length !== bytes.length || loaded.some((value, index) => value !== bytes[index])) throw new Error("Binary file changed");
  await box.destroy();
  process.stdout.write("packed direct flow passed\\n");
} finally { await client.close(); }
`;

const daytonaSource = `
import { Sandbar, Image } from "sandbar-sdk";
import { createDaytonaAdapter } from "@sandbar/provider-daytona";
let name = "", mutations = 0, snapshotName = "", labels = {};
const files = new Map([["/file", Uint8Array.from([0,255])]]);
const origin = "https://proxy.app.daytona.io/toolbox";
const native = (state = "started") => ({ labels, id: "native-1", name, organizationId: "org-1", target: "us", state, networkBlockAll: true, public: false, toolboxProxyUrl: origin });
const mock = async (input, init = {}) => {
  const url = new URL(String(input));
  const json = value => Response.json(value);
  if (url.pathname === "/api/api-keys/current") return json({ organizationId: "org-1" });
  if (url.pathname === "/api/organizations/org-1") return json({ id: "org-1", sandboxLimitedNetworkEgress: false });
  if (url.pathname === "/api/regions") return json([{ id: "us", name: "United States", regionType: "shared", organizationId: "org-1" }]);
  if (url.pathname === "/api/snapshots/snap-1") return json({ id: "snap-1", organizationId: "org-1", state: "active", regionIds: ["us"], sandboxClass: "linux-vm" });
  if (url.pathname === "/api/snapshots" && init.method === "POST") {
    mutations++; snapshotName = JSON.parse(init.body).name;
    return json({ id: "built-1", name: snapshotName, imageName: "alpine:3.21", organizationId: "org-1", state: "active", regionIds: ["us"], sandboxClass: "container" });
  }
  if (url.pathname.startsWith("/api/snapshots/")) return snapshotName && [snapshotName, "built-1"].includes(decodeURIComponent(url.pathname.split("/").at(-1)))
    ? json({ id: "built-1", name: snapshotName, imageName: "alpine:3.21", organizationId: "org-1", state: "active", regionIds: ["us"], sandboxClass: "container" }) : new Response(null, { status: 404 });
  if (url.pathname === "/api/sandbox" && init.method === "POST") { mutations++; const body = JSON.parse(init.body); name = body.name; labels = body.labels; return json(native()); }
  if (url.pathname === "/api/sandbox/native-1" && init.method === "DELETE") { mutations++; return json(native("destroyed")); }
  if (url.pathname === "/api/sandbox/native-1") return json(native());
  if (url.pathname.endsWith("/process/execute")) {
    mutations++;
    const command = JSON.parse(init.body).command;
    if ((command.startsWith("mkdir -m 700 -- ") && !command.includes("SANDBAR-EXEC-V1"))) return json({ exitCode: 0, result: "" });
    if (command.startsWith("cat ")) {
      const match = /^cat '([^']+)' > '([^']+)'/.exec(command);
      if (!match) throw Error("Invalid packed Daytona write command");
      files.set(match[2], files.get(match[1]));
      files.delete(match[1]);
      return json({ exitCode: 0, result: "" });
    }
    return json({ exitCode: 0, result: "SANDBAR-EXEC-V1\\n0\\n2\\n1\\n 00 ff\\nSANDBAR-STDERR\\n 7f\\nSANDBAR-END\\n" });
  }
  if (url.pathname.endsWith("/files/upload-v2")) {
    mutations++;
    const path = url.searchParams.get("path");
    files.set(path, new Uint8Array(await init.body.get("file").arrayBuffer()));
    return json({ name: "file", path, type: "file" });
  }
  if (url.pathname.endsWith("/files/download")) {
    const bytes = files.get(url.searchParams.get("path"));
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }
  throw new Error("Unexpected fixture request: " + url.pathname);
};
const client = await Sandbar.connect({ adapter: createDaytonaAdapter(mock), config: { target: "us" }, credentials: { apiKey: "fixture-only" } });
try {
  const built = await client.images.build({ source: Image.oci("alpine:3.21") });
  if (built.prepared.value !== "built-1" || built.prepared.provider !== "daytona" || built.retainedResources[0]?.ownership !== "unknown" || mutations !== 1) throw Error("Daytona scoped build mismatch");
  const box = await client.sandboxes.create({ environment: Image.prepared(built.prepared), networkPolicy: "blocked" });
  if (!box.reference) throw Error("Missing packed sandbox reference");
  const fresh = await Sandbar.connect({ adapter: createDaytonaAdapter(mock), config: { target: "us" }, credentials: { apiKey: "rotated-fixture" } });
  try {
    const reopened = await fresh.sandboxes.get(JSON.parse(JSON.stringify(box.reference)));
    if ((await reopened.inspect()).state !== "running" || reopened.id !== box.id) throw Error("Packed sandbox reopening differs");
  } finally { await fresh.close(); }
  const result = await box.exec({ command: { kind: "shell", script: "printf test" } });
  if (result.stdout[0] !== 0 || result.stdout[1] !== 255 || result.stderr[0] !== 127) throw new Error("Binary output mismatch");
  await box.writeFile("/file", Uint8Array.from([0,255]), { overwrite: true });
  const stopped = new AbortController();
  stopped.abort();
  try { await box.readFile("/file", { signal: stopped.signal }); throw Error("Pre-aborted read succeeded"); }
  catch (error) { if (error.code !== "WAIT_ABORTED" || error.effect !== "none") throw error; }
  const bytes = await box.readFile("/file", { signal: new AbortController().signal });
  if (bytes[0] !== 0 || bytes[1] !== 255) throw new Error("Binary file mismatch");
  await box.destroy();
  if (mutations !== 7) throw new Error("Mutation replay in packed consumer: " + mutations);
  process.stdout.write("packed Daytona fixture flow passed\\n");
} finally { await client.close(); }
`;

const modalSource = `
import { Sandbar, Image } from "sandbar-sdk";
import { createModalAdapter } from "sandbar-modal";
let creates = 0, terminates = 0, closed = 0;
const records = new Map();
const files = new Map();
const executions = new Map();
let writePath = "";
const transport = {
  async lookupApp(name, environment) { if (name !== "existing" || environment !== "main") throw Error("Wrong App"); return "ap-fixture"; },
  async imageExists(id) { return id === "im-fixture"; },
  async create(input) {
    if (input.appId !== "ap-fixture" || (input.imageId !== "im-fixture" && input.ociReference !== "python:3.12-slim") || input.timeoutMs !== 300000 || input.regions?.[0] !== "us-east-1") throw Error("Wrong create input");
    creates++;
    records.set(input.name, { id: "sb-" + creates, tags: input.tags, running: true });
    return "sb-" + creates;
  },
  async findByName(_app, _environment, name) { return records.get(name) ?? null; },
  async *list(appId) { if (appId !== "ap-fixture") throw Error("Wrong inventory scope"); for (const record of records.values()) if (record.running) yield record; },
  async readBytes(id, path, maxBytes) { if (!id.startsWith("sb-") || maxBytes !== 1048576) throw Error("Wrong read"); return files.get(path) ?? Uint8Array.from([0, 255, 128]); },
  async fileExists(_id, path) { return files.has(path); },
  async start(input) {
    if (input.command[0] === "/bin/sh" && input.command[2]?.includes("cat >")) {
      writePath = input.command.at(-1);
      executions.set(input.execId, { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false });
    } else {
      if (input.command.join(" ") !== "printf ready" || input.cwd !== "/tmp" || input.env?.KEY !== "value") throw Error("Wrong exec input");
      executions.set(input.execId, { exitCode: 0, stdout: Uint8Array.from([0, 255]), stderr: new Uint8Array(), truncated: false });
    }
  },
  async stdin(_id, execId, bytes) { files.set(writePath, bytes.slice()); executions.set(execId, { exitCode: 0, stdout: new TextEncoder().encode(String(bytes.length) + "\\n"), stderr: new Uint8Array(), truncated: false }); },
  async result(_id, execId) { return executions.get(execId); },
  async terminate() { terminates++; for (const record of records.values()) record.running = false; return true; },
  async poll() { return "stopped"; },
  close() { closed++; },
};
const client = await Sandbar.connect({ adapter: createModalAdapter(() => transport), config: { appName: "existing", environment: "main", region: "us-east-1", timeoutSeconds: 300 }, credentials: { tokenId: "ak-fixture", tokenSecret: "as-fixture" } });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("im-fixture"), networkPolicy: "blocked", region: "us-east-1" });
  const bytes = await box.readFile("/file");
  if (bytes.length !== 3 || bytes[0] !== 0 || bytes[1] !== 255 || bytes[2] !== 128) throw Error("Binary read mismatch");
  const result = await box.exec({ command: { kind: "argv", argv: ["printf", "ready"] }, cwd: "/tmp", env: { KEY: "value" }, maxOutputBytes: 16 });
  if (result.exitCode !== 0 || result.stdout[0] !== 0 || result.stdout[1] !== 255) throw Error("Binary exec mismatch");
  await box.writeFile("/file", Uint8Array.from([0, 255, 129]), { overwrite: true });
  const roundtrip = await box.readFile("/file");
  if (roundtrip[2] !== 129) throw Error("Binary write mismatch");
  await box.destroy();
  const oci = await client.sandboxes.create({ environment: Image.oci("python:3.12-slim"), networkPolicy: "blocked", region: "us-east-1" });
  await oci.destroy();
  if (creates !== 2 || terminates !== 2) throw Error("Mutation replay in packed Modal consumer");
} finally { await client.close(); }
if (closed !== 1) throw Error("Owned provider was not released");
process.stdout.write("packed Modal fixture flow passed\\n");
`;

const e2bSource = `
import { Sandbar, Image, OutcomeUnknownError } from "sandbar-sdk";
import { createE2BAdapter } from "sandbar-sdk/e2b";
let creates = 0, kills = 0, closes = 0, buildName = "", retained = "";
let record;
let failWrite = false;
const snapshots=new Map(),volumes=new Map();
const files = new Map();
const binary = Uint8Array.from([0, 255, 129]);
const transport = {
  state:{async template(id){return snapshots.has(id+":default")?{templateId:id,names:[],public:false,builds:[{buildId:"11111111-1111-4111-8111-111111111111",status:"ready"}]}:null;},async verifyAddress(){},async tags(){return [{tag:"default",buildId:"11111111-1111-4111-8111-111111111111"}];},async capture(){const value={snapshotId:"snapshot_packed:default",names:[]};snapshots.set(value.snapshotId,value);return value;},async snapshots(input){return {items:[...snapshots.values()].filter(value=>!input.name||value.snapshotId===input.name).slice(0,input.limit)};},async deleteSnapshot(id){return snapshots.delete(id+":default");},async createVolume(name){const value={volumeId:"volume_packed",name};volumes.set(value.volumeId,value);return value;},async volume(id){return volumes.get(id);},async volumes(){return [...volumes.values()];},async deleteVolume(id){return volumes.delete(id);}},
  async verifyAuth() {},
  async verifyTeam(id) { if (id !== "team_1") throw Error("Wrong team"); },
  async verifyTemplate(team, template) { if ((team !== undefined && team !== "team_1") || !["template_1", "template_oci"].includes(template)) throw Error("Wrong template"); return template; },
  async buildImage(reference, name) { if (reference !== "node:24") throw Error("Wrong OCI reference"); buildName = name; return { templateId: "template_oci", buildId: "build_1" }; },
  async findBuild(_team, name) { return name === buildName ? { templateId: "template_oci", buildId: "build_1", status: "ready" } : null; },
  async create(input) {
    if (!["base", "template_1", "template_oci", "snapshot_packed:11111111-1111-4111-8111-111111111111"].includes(input.templateId) || input.allowInternetAccess !== false) throw Error("Wrong native create");
    creates++;
    record = { id: "sb_" + creates, templateId: input.templateId === "base" ? "canonical_base" : input.templateId.split(":")[0], metadata: input.metadata, state: "running",envdVersion:"0.5.1",volumeMounts:Object.entries(input.volumeMounts??{}).map(([path,name])=>({path,name})) };
    return record.id;
  },
  async get(id) { return record?.id === id ? record : null; },
  async list(metadata) { return { items: record && Object.entries(metadata).every(([k,v]) => record.metadata[k] === v) ? [record] : [] }; },
  async kill(id) { if (id !== record?.id) throw Error("Wrong kill"); retained = record.metadata.sandbar_build ? record.templateId : ""; kills++; record = undefined; return true; },
  async run(_id, script) {
    if (script.includes("ln -T --")) { const staged = [...files.keys()].find((path) => path.includes(".sandbar-write-")); if (!staged) throw Error("Missing staged file"); files.set("/tmp/no-clobber.bin", files.get(staged)); return "CREATED"; }
    if (script.includes(".status")) {
      const stdout = script.match(/\\/tmp\\/\\.sandbar-[A-Za-z0-9_-]+\\.stdout/)?.[0];
      if (!stdout) throw Error("Missing command correlation path");
      files.set(stdout, binary);
      files.set(stdout.replace(".stdout", ".stderr"), Uint8Array.of(254));
      files.set(stdout.replace(".stdout", ".status"), new TextEncoder().encode("0"));
    }
    return "";
  },
  async read(_id, path, max) { const bytes = files.get(path); if (!bytes) throw Error("Missing binary file " + path); return { bytes: bytes.slice(0,max), truncated: bytes.length > max }; },
  async write(_id, path, bytes) {
    if (path === "/tmp/packed-failure.bin" && failWrite) throw Object.assign(Error("private native body"), {name: "SandboxError", statusCode: 500});
    files.set(path, bytes);
    if (path === "/tmp/packed-lost-ack.bin") throw Error("private lost response");
  },
  async remove(_id, path) { files.delete(path); },
  close() { closes++; },
};
const client = await Sandbar.connect({ adapter: createE2BAdapter(() => transport), config: {}, credentials: { apiKey: "fixture" } });
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("base"), networkPolicy: "blocked" });
  const result = await box.exec({ command: { kind: "argv", argv: ["printf", "test"] }, maxOutputBytes: 8 });
  if (result.stdout[0] !== 0 || result.stdout[1] !== 255 || result.stderr[0] !== 254) throw Error("Binary command output changed");
  await box.writeFile("/tmp/packed.bin", binary, { overwrite: true });
  await box.writeFile("/tmp/no-clobber.bin", binary, { overwrite: false });
  const loaded = await box.readFile("/tmp/packed.bin");
  if (loaded.some((byte, i) => byte !== binary[i])) throw Error("Binary file changed");
  await box.writeFile("/tmp/packed-failure.bin", binary, {overwrite: true});
  failWrite = true;
  let failed = false;
  try { await box.writeFile("/tmp/packed-failure.bin", Uint8Array.of(2,254,0), {overwrite: true}); }
  catch (error) {
    failed = error instanceof OutcomeUnknownError && error.message.includes("error=SandboxError, httpStatus=500") && !error.message.includes("private native body");
  }
  if (!failed) throw Error("Packed E2B native write failure classification lost");
  await box.writeFile("/tmp/packed-lost-ack.bin", binary, {overwrite: true});
  const capture=await box.snapshot();
  const saved=structuredClone(capture.snapshot.reference);
  await box.destroy();
  const snapshot=await client.snapshots.get(saved);
  const caps=await client.capabilities();
  if(caps.snapshots.restore.status!=="supported"||caps.mounts.status!=="unsupported")throw Error("Packed state capabilities differ");
  if(saved.nativeId!=="snapshot_packed"||saved.generation!=="11111111-1111-4111-8111-111111111111")throw Error("Captured build identity missing");
  const restored=await snapshot.restore({networkPolicy:"blocked"});
  if(!restored.reference)throw Error("Restored sandbox reference missing");
  const reopenedBox=await client.sandboxes.get(JSON.parse(JSON.stringify(restored.reference)));
  if(reopenedBox.id!==restored.id||(await reopenedBox.inspect()).state!=="running")throw Error("Restored sandbox reopen failed");
  if(record.metadata.sandbar_snapshot!=="snapshot_packed:11111111-1111-4111-8111-111111111111")throw Error("Restore did not pin the captured UUID");
  await restored.destroy();
  await snapshot.delete();
  if(snapshots.size)throw Error("Containing snapshot cleanup failed");
  const volume=await client.volumes.create({name:"packed-data"});
  let mountRejected=false;try{await client.sandboxes.create({environment:Image.prepared("base"),mounts:[volume.at("/mnt/data")]});}catch(error){mountRejected=error.code==="UNSUPPORTED"&&error.effect==="none";}
  if(!mountRejected||!volumes.size)throw Error("Unsafe name-only mount dispatched");
  await volume.delete();if(volumes.size||snapshots.size)throw Error("Packed state artifact cleanup failed");
  const oci = await client.sandboxes.create({ environment: Image.oci("node:24"), networkPolicy: "blocked" });
  await oci.destroy();
  if (!buildName || retained !== "template_oci") throw Error("OCI retained template was hidden");
  const built = await client.images.build({ source: Image.oci("node:24") });
  if (built.prepared.value !== "template_oci" || built.prepared.provider !== "e2b" || built.retainedResources[0]?.ownership !== "unknown") throw Error("Scoped image build result mismatch");
  const fromBuild = await client.sandboxes.create({ environment: Image.prepared(built.prepared), networkPolicy: "blocked" });
  await fromBuild.destroy();
} finally { await client.close(); }
if (creates !== 4 || kills !== 4 || closes !== 1) throw Error("Packed E2B mutation or cleanup count mismatch");
process.stdout.write("packed E2B fixture flow passed\\n");
`;

const builtinsSource = `
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Factory construction performed provider I/O"); };
try {
  const daytonaAdapter = daytona({ apiKey: "fixture", target: "us", ttlMinutes: 15 });
  const e2bAdapter = e2b({ apiKey: "fixture" });
  if (daytonaAdapter.name !== "daytona" || e2bAdapter.name !== "e2b") throw Error("Built-in factory identity mismatch");
  if (!daytonaAdapter.bound || !e2bAdapter.bound) throw Error("Built-in factory did not bind public adapter contract");
  process.stdout.write("packed built-in SDK subpaths passed\\n");
} finally { globalThis.fetch = originalFetch; }
`;

const externalAdapterSource = `
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
export const metrics = { creates: 0, destroys: 0, closes: 0, observes: 0, builds: 0 };
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

`;

const customSource = `
import { Sandbar, Image, ResourceReference, assertResourceScope } from "sandbar-sdk";
import { acme, metrics } from "@acme/sandbar-adapter";
const client = await Sandbar.connect({
  adapter: acme,
  config: { region: "us" },
  credentials: { token: "fixture" },
});
try {
  const box = await client.sandboxes.create({ environment: Image.prepared("image-1") });
  const caps = await client.capabilities();
  if (caps.snapshots.capture.status !== "unsupported" || caps.volumes.status !== "unsupported") throw Error("Unimplemented state support was advertised");
  if ((await box.checkSnapshot({ requirements: { preserve: "filesystem" } })).status !== "unsupported") throw Error("Snapshot support mismatch");
  const required = { environment: Image.prepared("image-1"), requirements: { snapshot: { requirements: { preserve: "filesystem" } } } };
  if ((await client.sandboxes.checkCreate(required)).status !== "unsupported") throw Error("Required snapshot was accepted");
  try { await client.sandboxes.create(required); throw Error("Required snapshot allocated compute"); } catch (error) { if (error.code !== "UNSUPPORTED" || error.effect !== "none") throw error; }
  for (const kind of ["snapshot", "volume", "mount", "session"]) {
    const ref = ResourceReference.parse({ version: 1, kind, provider: "example.acme", scope: client.scope, nativeId: "native-1", generation: "g1", ownership: "unknown" });
    assertResourceScope(JSON.parse(JSON.stringify(ref)), { provider: "example.acme", scope: client.scope });
  }
  if (box.supports("exec")) throw Error("Unsupported operation was advertised");
  await box.destroy();
} finally { await client.close(); }
if (metrics.creates !== 1 || metrics.destroys !== 1 || metrics.closes !== 1) throw Error("Mutation or release count mismatch");
process.stdout.write("packed external adapter flow passed\\n");
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
  await writeFile(
    join(externalDir, "package.json"),
    JSON.stringify(
      {
        name: "@acme/sandbar-adapter",
        version: "0.0.1",
        type: "module",
        files: ["dist"],
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
        peerDependencies: { "sandbar-adapter": "0.0.0" },
        overrides: { "sandbar-adapter": archiveOverrides["sandbar-adapter"] },
        dependencies: {
          "sandbar-adapter": archiveOverrides["sandbar-adapter"],
          zod: "4.6.5",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(join(externalDir, "src/index.ts"), externalAdapterSource);
  await writeFile(
    join(externalDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        declaration: true,
        outDir: "dist",
        skipLibCheck: false,
        types: [],
      },
      include: ["src/index.ts"],
    }),
  );
  run("bun", ["install", "--no-save"], externalDir);
  run(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], externalDir);
  const externalManifest = JSON.parse(await readFile(join(externalDir, "package.json"), "utf8"));
  delete externalManifest.dependencies["sandbar-adapter"];
  delete externalManifest.overrides;
  await writeFile(join(externalDir, "package.json"), JSON.stringify(externalManifest, null, 2));
  const externalArchive = await pack(externalDir);

  const sdkDeps = { "sandbar-sdk": archiveOverrides["sandbar-sdk"] };

  const customDeps = {
    ...sdkDeps,
    "@acme/sandbar-adapter": `file:${externalArchive}`,
  };

  const directDeps = {
    ...sdkDeps,
    "@sandbar/provider-fake": archiveOverrides["@sandbar/provider-fake"],
  };

  const daytonaDeps = {
    ...sdkDeps,
    "@sandbar/provider-daytona": archiveOverrides["@sandbar/provider-daytona"],
  };

  const modalDeps = {
    ...sdkDeps,
    "sandbar-modal": archiveOverrides["sandbar-modal"],
  };

  const e2bDeps = { ...sdkDeps };

  const custom = join(temporary, "custom-consumer");
  const direct = join(temporary, "direct-consumer");
  const daytona = join(temporary, "daytona-consumer");
  const modal = join(temporary, "modal-consumer");
  const e2b = join(temporary, "e2b-consumer");
  const builtins = join(temporary, "builtins-consumer");
  const observability = join(temporary, "observability-consumer");
  await consumer(
    observability,
    {
      ...customDeps,
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/context-async-hooks": "2.11.0",
      "@opentelemetry/sdk-trace-node": "2.11.0",
      "@opentelemetry/sdk-trace-base": "2.11.0",
    },
    archiveOverrides,
    await readFile(join(root, "packages/sdk-qualification/observability/packed.mjs"), "utf8"),
  );
  await checkTypes(observability, "observability");

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], observability)}`);
  await consumer(custom, customDeps, archiveOverrides, customSource);
  await consumer(direct, directDeps, archiveOverrides, directSource);
  await consumer(daytona, daytonaDeps, archiveOverrides, daytonaSource);
  await consumer(modal, modalDeps, archiveOverrides, modalSource);
  await consumer(e2b, e2bDeps, archiveOverrides, e2bSource);
  await consumer(builtins, sdkDeps, archiveOverrides, builtinsSource);
  await checkTypes(custom, "custom");
  await checkTypes(direct, "direct");
  await checkRecoveryTypes(direct, root, run);
  await checkTypes(daytona, "daytona");
  await checkTypes(modal, "modal");
  await checkTypes(e2b, "e2b");
  await checkTypes(builtins, "builtins");
  await writeFile(
    join(custom, "text-streaming.ts"),
    await readFile(join(root, "apps/docs/examples/text-streaming.ts"), "utf8"),
  );
  await writeFile(
    join(custom, "streaming-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        types: [],
      },
      include: ["text-streaming.ts"],
    }),
  );
  run(join(root, "node_modules/.bin/tsc"), ["-p", "streaming-tsconfig.json"], custom);
  await writeFile(
    join(custom, "streaming.mjs"),
    await readFile(join(root, "packages/sdk-qualification/streaming-packed.mjs"), "utf8"),
  );

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["streaming.mjs"], custom)}`);
  inspectGraph(custom, ["sandbar-sdk", "@acme/sandbar-adapter"]);
  inspectGraph(direct, ["sandbar-sdk", "@sandbar/provider-fake"]);
  inspectGraph(daytona, ["sandbar-sdk", "@sandbar/provider-daytona"]);
  const modalGraph = inspectGraph(modal, ["sandbar-sdk", "sandbar-modal"]);
  inspectGraph(e2b, ["sandbar-sdk"]);
  const publicSdkGraph = inspectGraph(builtins, ["sandbar-sdk"]);

  if (publicSdkGraph.some((name) => name.startsWith("@sandbar/")))
    throw new Error(`SDK package leaked a private workspace dependency: ${publicSdkGraph}`);

  if (modalGraph.some((name) => name.startsWith("@sandbar/")))
    throw new Error(`Modal package leaked a private workspace dependency: ${modalGraph}`);

  if (publicSdkGraph.some((name) => ["modal", "sandbar-modal", "@grpc/grpc-js"].includes(name)))
    throw new Error(`SDK package retained Modal dependencies: ${publicSdkGraph}`);

  console.log(
    `Runtimes: Node ${run("node", ["--version"], direct)}, Bun ${run("bun", ["--version"], direct)}`,
  );
  await fixture.startFake();

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], custom)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], daytona)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], modal)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], e2b)}`);

  for (const runtime of ["node", "bun"])
    console.log(`${runtime}: ${run(runtime, ["consumer.mjs"], builtins)}`);

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
    await fixture.fakeControl("/_test/seed", {
      submissionId: "*",
      action: "exec",
      behavior: "normal",
      command: {
        command: { kind: "argv", argv: ["fixture", "json"] },
        exitCode: 0,
        stdoutBase64: Buffer.from(JSON.stringify({ payload: "x".repeat(20_000) })).toString(
          "base64",
        ),
        stderrBase64: Buffer.from("diagnostic").toString("base64"),
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
