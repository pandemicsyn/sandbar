import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Json } from "@sandbar-sdk/adapter";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { readTar } from "../src/tar";
import { defaultPushDir, scripts, shellQuote } from "../src/transfer";

const token = "local-test-token-12345";

const main = join(import.meta.dir, "..", "src", "main.ts");

const fixture = join(import.meta.dir, "fake-adapter.ts");

let root: string;

let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

let dir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbar-cli-"));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });
});

afterAll(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await control("/_test/reset", {});
  dir = await mkdtemp(join(root, "case-"));
  await writeConfig({ default: "fake", profiles: { fake: { module: fixture, export: "fake" } } });
});

async function writeConfig(config: Json) {
  await writeFile(join(dir, "sandbar.json"), JSON.stringify(config));
}

async function control(path: string, body: Json) {
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.ok).toBe(true);
}

type FakeResource = {
  ref: { nativeId: string };
  state: "running" | "destroyed";
  lifetimeSeconds?: number;
  labels?: Record<string, string>;
  env?: Record<string, string>;
};

async function fakeResources(): Promise<FakeResource[]> {
  const response = await fetch(new URL("/_test/state", server.url), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return (await response.json()).resources;
}

async function seedExec(command: string[] | string, exitCode: number, stdout: string, stderr = "") {
  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    command: {
      command: Array.isArray(command)
        ? { kind: "argv", argv: command }
        : { kind: "shell", script: command },
      exitCode,
      stdoutBase64: Buffer.from(stdout).toString("base64"),
      stderrBase64: Buffer.from(stderr).toString("base64"),
    },
  });
}

type Result = { code: number; stdout: string; stderr: string };

async function cli(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
  cwd = dir,
): Promise<Result> {
  const child = Bun.spawn(["bun", main, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      SANDBAR_CONFIG: join(dir, "sandbar.json"),
      SANDBAR_STATE_DIR: join(dir, "state"),
      SANDBAR_FAKE_URL: server.url.origin,
      SANDBAR_FAKE_TOKEN: token,
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

function envelope(result: Result) {
  const lines = result.stdout.trim().split("\n");

  expect(lines).toHaveLength(1);

  return JSON.parse(lines[0]!);
}

/** A stand-in adapter package `@acme/sandbar-fake` that re-exports the test fixture. */
async function adapterPackage(
  root: string,
  exports: Json,
  source = `export * from ${JSON.stringify(fixture)};\n`,
  entry = "index.js",
) {
  const directory = join(root, "@acme", "sandbar-fake");
  await mkdir(join(directory, dirname(entry)), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "@acme/sandbar-fake", type: "module", exports }),
  );
  await writeFile(join(directory, entry), source);
}

async function storeNames() {
  try {
    return (await readdir(join(dir, "state", "sandboxes"))).sort();
  } catch {
    return [];
  }
}

describe("sandbar CLI against the fake provider", () => {
  test("create, ls, inspect and rm keep the store and provider in step", async () => {
    const created = await cli(["create", "--name", "web", "--prepared", "fake-starter"]);

    expect(created).toMatchObject({ code: 0, stdout: "web\n" });
    expect(await storeNames()).toEqual(["web.json"]);

    const record = JSON.parse(await readFile(join(dir, "state", "sandboxes", "web.json"), "utf8"));

    expect(record).toMatchObject({
      format: 1,
      status: "created",
      profile: "fake",
      reference: { kind: "sandbox", provider: "fake", ownership: "verified-created" },
    });

    const listed = envelope(await cli(["ls", "--json"]));

    expect(listed).toMatchObject({
      ok: true,
      data: { sandboxes: [{ name: "web", state: "running", provider: "fake" }] },
    });

    const inspected = envelope(await cli(["inspect", "web", "--json"]));

    expect(inspected.data.info.state).toBe("running");

    const removed = await cli(["rm", "web", "--json"]);

    expect(removed.code).toBe(0);
    expect(envelope(removed).data.removed).toEqual([
      { name: "web", result: "destroyed", retainedResources: [] },
    ]);
    expect(await storeNames()).toEqual([]);
    expect(envelope(await cli(["ls", "--json"])).data.sandboxes).toEqual([]);
  });

  test("--ttl sets this sandbox's lifetime on create and run, and bad values fail before any effect", async () => {
    await cli(["create", "--name", "short", "--prepared", "fake-starter", "--ttl", "30m"]);
    await cli(["create", "--name", "plain", "--prepared", "fake-starter"]);
    await seedExec(["true"], 0, "");
    expect(
      (await cli(["run", "--prepared", "fake-starter", "--ttl", "2h", "--", "true"])).code,
    ).toBe(0);

    expect((await fakeResources()).map((resource) => resource.lifetimeSeconds)).toEqual([
      1800,
      undefined,
      7200,
    ]);

    for (const ttl of ["0", "soon", "1.5h"]) {
      const bad = await cli(["create", "--prepared", "fake-starter", "--ttl", ttl, "--json"]);

      expect(envelope(bad).error.message).toContain("--ttl must be a duration");
    }

    const over = await cli(["create", "--prepared", "fake-starter", "--ttl", "25h", "--json"]);

    expect(envelope(over).error).toMatchObject({ code: "UNSUPPORTED", outcome: "rejected" });
    expect(envelope(over).error.message).toContain("1-86400 seconds");
    expect(await fakeResources()).toHaveLength(3);
  });

  test("a native id from the store also names the sandbox", async () => {
    const created = envelope(await cli(["create", "--prepared", "fake-starter", "--json"]));

    expect(created.data.name).toMatch(/^sb-[0-9a-f]{5}$/);

    const inspected = await cli(["inspect", created.data.id, "--json"]);

    expect(envelope(inspected).data.name).toBe(created.data.name);
  });

  test("exec passes stdout, stderr and the remote exit code through", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await seedExec(["make", "test"], 7, "building\n", "1 failed\n");

    const result = await cli(["exec", "box", "--", "make", "test"]);

    expect(result).toEqual({ code: 7, stdout: "building\n", stderr: "1 failed\n" });

    await seedExec(["echo", "hi"], 0, "hi\n");
    const json = await cli(["exec", "box", "--json", "--", "echo", "hi"]);

    expect(json.code).toBe(0);
    expect(envelope(json)).toEqual({
      ok: true,
      data: { exitCode: 0, stdout: "hi\n", stderr: "", truncated: false },
    });
  });

  test("exec reports CLI-side failures with 125 so they differ from remote exit codes", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);

    const missing = await cli(["exec", "nope", "--json", "--", "true"]);

    expect(missing.code).toBe(125);
    expect(envelope(missing).error.code).toBe("NOT_FOUND");

    const unseeded = await cli(["exec", "box", "--", "true"]);

    expect(unseeded.code).toBe(125);
  });

  test("run creates, executes and always destroys", async () => {
    await seedExec(["python3", "-c", "print(2 + 2)"], 3, "4\n");

    const result = await cli([
      "run",
      "--prepared",
      "fake-starter",
      "--",
      "python3",
      "-c",
      "print(2 + 2)",
    ]);

    expect(result).toMatchObject({ code: 3, stdout: "4\n" });
    expect(await storeNames()).toEqual([]);

    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
  });

  test("run --keep leaves the sandbox and its record", async () => {
    await seedExec(["true"], 0, "");

    const result = await cli([
      "run",
      "--keep",
      "--name",
      "kept",
      "--prepared",
      "fake-starter",
      "--",
      "true",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("kept sandbox kept");
    expect(await storeNames()).toEqual(["kept.json"]);
  });

  test("cp and cat move files both ways", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await writeFile(join(dir, "in.txt"), "hello sandbox\n");

    const uploaded = await cli(["cp", "in.txt", "box:/work/in.txt", "--json"]);

    expect(envelope(uploaded)).toEqual({
      ok: true,
      data: { sandbox: "box", path: "/work/in.txt", bytes: 14 },
    });
    expect(await cli(["cat", "box:/work/in.txt"])).toMatchObject({
      code: 0,
      stdout: "hello sandbox\n",
    });
    expect(envelope(await cli(["cat", "box:/work/in.txt", "--json"])).data.text).toBe(
      "hello sandbox\n",
    );

    expect((await cli(["cp", "box:/work/in.txt", "out.txt"])).code).toBe(0);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello sandbox\n");
  });

  test("names are unique unless --if-not-exists reuses the live sandbox", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"]);

    const conflict = await cli(["create", "--name", "web", "--prepared", "fake-starter", "--json"]);

    expect(conflict.code).toBe(1);
    expect(envelope(conflict).error).toMatchObject({ code: "CONFLICT", retryable: false });

    const reused = envelope(
      await cli([
        "create",
        "--name",
        "web",
        "--prepared",
        "fake-starter",
        "--if-not-exists",
        "--json",
      ]),
    );

    expect(reused.data).toMatchObject({ name: "web", existing: true });
    expect(await fakeResources()).toHaveLength(1);
  });

  test("limits.maxSandboxes stops create before any provider call", async () => {
    await writeConfig({
      default: "fake",
      profiles: { fake: { module: fixture, export: "fake" } },
      limits: { maxSandboxes: 1 },
    });
    await cli(["create", "--prepared", "fake-starter"]);

    const refused = await cli(["create", "--prepared", "fake-starter", "--json"]);

    expect(refused.code).toBe(4);
    expect(envelope(refused).error.code).toBe("LIMIT_REACHED");
    expect(await fakeResources()).toHaveLength(1);
  });

  test("a rejected create releases the name", async () => {
    await control("/_test/seed", { submissionId: "*", action: "create", behavior: "reject" });

    const result = await cli(["create", "--name", "web", "--prepared", "fake-starter", "--json"]);

    expect(result.code).toBe(7);
    expect(envelope(result).error).toMatchObject({
      code: "CAPACITY",
      retryable: true,
      outcome: "rejected",
    });
    expect(await storeNames()).toEqual([]);
  });

  test("an uncertain create keeps the record and exits 6", async () => {
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "ambiguous_before_effect",
    });

    const result = await cli(["create", "--name", "web", "--prepared", "fake-starter", "--json"]);

    expect(result.code).toBe(6);
    expect(envelope(result).error).toMatchObject({ outcome: "unknown", known: { sandbox: "web" } });

    const record = JSON.parse(await readFile(join(dir, "state", "sandboxes", "web.json"), "utf8"));

    expect(record.status).toBe("unknown");
    expect(record.recovery).toMatchObject({ kind: "create" });
    expect(envelope(result).error.known.recovery).toEqual(record.recovery);

    const refused = await cli(["rm", "web"]);

    expect(refused.code).toBe(4);
    expect((await cli(["rm", "web", "--force"])).code).toBe(0);
    expect(await storeNames()).toEqual([]);
  });

  test("usage errors exit 2 with a hint", async () => {
    const unknownFlag = await cli(["create", "--nmae", "x", "--json"]);

    expect(unknownFlag.code).toBe(2);
    expect(envelope(unknownFlag).error.hint).toContain("--name");

    const unknownCommand = await cli(["creat"]);

    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toContain("sandbar create");

    expect((await cli(["exec", "box"])).code).toBe(125);
  });

  test("a create without an image says how to pick one", async () => {
    const result = await cli(["create", "--name", "web", "--json"]);

    expect(result.code).toBe(2);
    expect(envelope(result).error).toMatchObject({ code: "INVALID_ARGUMENT", outcome: "rejected" });
    expect(envelope(result).error.hint).toContain("--prepared");
    expect(await storeNames()).toEqual([]);
  });

  test("a missing profile or provider credential is a usage error", async () => {
    await writeConfig({});

    const none = await cli(["create", "--json"]);

    expect(none.code).toBe(2);
    expect(envelope(none).error.message).toBe("No provider selected");

    const missing = await cli(["create", "--provider", "daytona", "--json"]);

    expect(missing.code).toBe(2);
    expect(envelope(missing).error.message).toContain("DAYTONA_API_KEY");
    expect(envelope(missing).error.message).toContain("DAYTONA_TARGET");
  });

  test("doctor connects without creating and reports create support as data", async () => {
    const run = await cli(["doctor", "--json"]);
    const result = envelope(run);

    expect(run.code).toBe(0);
    expect(result.data).toMatchObject({ profile: "fake", provider: "fake", connected: true });
    expect(result.data.create.status).toBe("unavailable");
    expect(await fakeResources()).toHaveLength(0);
  });

  test("schema and help describe every command", async () => {
    const schema = JSON.parse((await cli(["schema"])).stdout);
    const names = schema.commands.map((command: { name: string }) => command.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "create",
        "ls",
        "inspect",
        "rm",
        "exec",
        "sh",
        "run",
        "cp",
        "cat",
        "doctor",
      ]),
    );
    expect(schema.exitCodes.map((entry: { code: number }) => entry.code)).toContain(125);

    const manifest = JSON.parse(
      await readFile(join(import.meta.dir, "..", "package.json"), "utf8"),
    );

    const version = await cli(["--version"]);

    expect(schema.cliVersion).toBe(manifest.version);
    expect(version).toMatchObject({ code: 0, stdout: `${manifest.version}\n` });
    expect(JSON.parse((await cli(["-V", "--json"])).stdout)).toEqual({
      ok: true,
      data: { version: manifest.version },
    });

    const help = await cli(["exec", "--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: sandbar exec");
    expect((await cli(["--help"])).stdout).toContain("Quick start");
  });

  test("adapters load from ~/.config/sandbar/adapters, including nested conditional exports", async () => {
    await writeConfig({
      default: "acme",
      profiles: { acme: { module: "@acme/sandbar-fake", export: "fake" } },
    });

    const missing = await cli(["doctor", "--json"]);

    expect(missing.code).toBe(4);
    expect(envelope(missing).error.code).toBe("ADAPTER_NOT_INSTALLED");

    await adapterPackage(
      join(dir, ".config", "sandbar", "adapters", "node_modules"),
      { ".": { node: { import: { types: "./lib/entry.d.ts", default: "./lib/entry.js" } } } },
      undefined,
      "lib/entry.js",
    );

    expect((await cli(["doctor", "--json"])).code).toBe(0);
  });

  test("an installed adapter that fails to load is not reported as missing", async () => {
    await writeConfig({
      default: "acme",
      profiles: { acme: { module: "@acme/sandbar-fake", export: "fake" } },
    });
    await adapterPackage(
      join(dir, ".config", "sandbar", "adapters", "node_modules"),
      "./index.js",
      'import "@acme/not-installed-dependency";\n',
    );

    const result = await cli(["doctor", "--json"]);

    expect(result.code).toBe(4);
    expect(envelope(result).error).toMatchObject({ code: "ADAPTER_LOAD_FAILED" });
    expect(envelope(result).error.message).toContain("@acme/not-installed-dependency");
  });

  test("SANDBAR_JSON=1 switches every command to JSON", async () => {
    const result = await cli(["ls"], { SANDBAR_JSON: "1" });

    expect(envelope(result)).toEqual({ ok: true, data: { sandboxes: [] } });
  });

  test("sh takes the script after -- so it may start with a dash", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await seedExec("-n is fine", 0, "ok\n");

    expect(await cli(["sh", "box", "--", "-n is fine"])).toMatchObject({ code: 0, stdout: "ok\n" });
    expect((await cli(["sh", "box", "--", "a", "b"])).code).toBe(125);
  });

  test("rm recovers a create whose response was lost and destroys the sandbox", async () => {
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "lost_after_effect",
    });

    const result = await cli(["create", "--name", "web", "--prepared", "fake-starter", "--json"]);

    expect(result.code).toBe(6);
    expect(envelope(result).error.known).toMatchObject({
      sandbox: "web",
      reference: null,
      recovery: { kind: "create" },
    });
    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["running"]);

    const removed = await cli(["rm", "web", "--json"]);

    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("recovered the uncertain create");
    expect(envelope(removed).data.removed).toMatchObject([{ name: "web", result: "destroyed" }]);
    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
    expect(await storeNames()).toEqual([]);
  });

  test("a sandbox named from-file is an ordinary store record", async () => {
    await cli(["create", "--name", "from-file", "--prepared", "fake-starter"]);

    expect((await cli(["rm", "from-file"])).code).toBe(0);
    expect(await storeNames()).toEqual([]);
    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
  });

  test("ls --remote lists provider sandboxes and adopt records one without owning it", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"]);
    const elsewhere = { SANDBAR_STATE_DIR: join(dir, "elsewhere") };
    const create = ["create", "--prepared", "fake-starter", "--json"];
    const other = envelope(await cli(create, elsewhere)).data.id;
    const gone = envelope(await cli(create, elsewhere)).data.id;
    await cli(["rm", "--all"], elsewhere);
    // Another store created and destroyed two sandboxes; this store only knows web.
    expect(await storeNames()).toEqual(["web.json"]);

    const listed = envelope(await cli(["ls", "--remote", "--json"]));
    const web = JSON.parse(await readFile(join(dir, "state", "sandboxes", "web.json"), "utf8"));
    expect(listed.data).toMatchObject({ provider: "fake", coverage: "provider-scope" });
    expect(listed.data.complete).toBe(true);
    expect(
      listed.data.sandboxes.map((row: { id: string; name: string | null; state: string }) => [
        row.id,
        row.name,
        row.state,
      ]),
    ).toEqual([
      [web.reference.nativeId, "web", "running"],
      [other, null, "destroyed"],
      [gone, null, "destroyed"],
    ]);
    expect(listed.data.sandboxes[1]).toMatchObject({ reopenable: true, ownership: "unknown" });

    const human = await cli(["ls", "--remote"]);
    expect(human.code).toBe(0);
    expect(human.stdout.split("\n")[0]).toMatch(
      /^ID\s+STATE\s+NAME\s+OWNERSHIP\s+CREATED\s+LABELS$/,
    );
    expect(human.stderr).toContain("fake lists every sandbox");

    // A destroyed listed sandbox is never recorded.
    const destroyed = await cli(["adopt", gone, "--json"]);
    expect(envelope(destroyed)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(destroyed.code).toBe(3);

    const live = envelope(await cli(create, elsewhere)).data.id;
    const adopted = envelope(await cli(["adopt", live, "--name", "borrowed", "--json"]));
    expect(adopted.data).toMatchObject({ name: "borrowed", id: live, adopted: true });
    expect(await storeNames()).toEqual(["borrowed.json", "web.json"]);

    const borrowed = JSON.parse(
      await readFile(join(dir, "state", "sandboxes", "borrowed.json"), "utf8"),
    );

    // The record keeps the reference the reopen returned.
    expect(borrowed.reference).toEqual(adopted.data.reference);
    expect(borrowed.reference).toMatchObject({ kind: "sandbox", nativeId: live });
    expect(envelope(await cli(["inspect", "borrowed", "--json"])).data.info.state).toBe("running");

    const again = envelope(await cli(["adopt", live, "--json"]));
    expect(again).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(envelope(await cli(["adopt", "missing-id", "--json"])).error.code).toBe("NOT_FOUND");
    expect((await cli(["ls", "--remote", "--offline"])).code).toBe(2);

    const all = envelope(await cli(["rm", "--all", "--json"]));
    expect(all.data).toMatchObject({
      removed: [{ name: "web", result: "destroyed" }],
      skipped: [{ name: "borrowed", result: "skipped" }],
    });

    const refused = await cli(["rm", "borrowed", "--json"]);
    expect(envelope(refused)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await cli(["rm", "borrowed", "--force"])).code).toBe(0);
    expect(await storeNames()).toEqual([]);
  });

  test("gc destroys provider-listed sandboxes by label and age, then forgets their records", async () => {
    const elsewhere = { SANDBAR_STATE_DIR: join(dir, "elsewhere") };
    const create = ["create", "--prepared", "fake-starter", "--json"];
    await cli(["create", "--name", "web", "--prepared", "fake-starter", "--label", "run=1"]);
    // A killed job's sandbox: its own store is gone, only the provider still lists it.

    const orphan = envelope(
      await cli([...create, "--label", "run=1", "--label", "job=a"], elsewhere),
    ).data.id;

    const other = envelope(await cli([...create, "--label", "run=2"], elsewhere)).data.id;
    const unlabelled = envelope(await cli(create, elsewhere)).data.id;

    const listed = envelope(await cli(["ls", "--remote", "--json"])).data.sandboxes;
    expect(listed.find((row: { id: string }) => row.id === orphan)).toMatchObject({
      labels: { run: "1", job: "a" },
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });

    expect((await cli(["gc"])).code).toBe(2);
    expect((await cli(["gc", "web", "--label", "run=1"])).code).toBe(2);
    expect((await cli(["gc", "--label", "run=1", "--older-than", "soon"])).code).toBe(2);

    const dry = envelope(await cli(["gc", "--label", "run=1", "--dry-run", "--json"]));
    expect(dry.data).toMatchObject({ provider: "fake", complete: true, dryRun: true, skipped: [] });
    expect(
      dry.data.removed.map((row: { name: string; result: string }) => [row.name, row.result]),
    ).toEqual([
      ["web", "would-destroy"],
      [orphan, "would-destroy"],
    ]);
    expect((await fakeResources()).every((resource) => resource.state === "running")).toBe(true);

    // The fake records creation in early 2026, so a ten-year cutoff leaves everything alone.
    const young = envelope(
      await cli(["gc", "--label", "run=1", "--older-than", "3650d", "--json"]),
    );

    expect(young.data.removed).toEqual([]);

    // Every given label must match.
    const narrow = envelope(await cli(["gc", "--label", "run=1", "--label", "job=a", "--json"]));
    expect(narrow.data.removed).toMatchObject([{ name: orphan, id: orphan, result: "destroyed" }]);

    const human = await cli(["gc", "--label", "run=1", "--older-than", "1h"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/^NAME\s+RESULT\s+CREATED\nweb\s+destroyed\s/);
    expect(await storeNames()).toEqual([]);

    const states = Object.fromEntries(
      (await fakeResources()).map((resource) => [resource.ref.nativeId, resource.state]),
    );

    expect(states[orphan]).toBe("destroyed");
    expect(states[other]).toBe("running");
    expect(states[unlabelled]).toBe("running");

    const none = await cli(["gc", "--label", "run=1"]);
    expect(none.code).toBe(0);
    expect(none.stderr).toContain("no sandboxes matched");
  });

  test("ls --remote and adopt match stored sandboxes by scope, not native id alone", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"]);
    const path = join(dir, "state", "sandboxes", "web.json");
    const web = JSON.parse(await readFile(path, "utf8"));
    const id = web.reference.nativeId;

    // The same native id in another project of the same provider, like two Vercel `worker`s.
    web.reference.scope.partition = { ...web.reference.scope.partition, project: "elsewhere" };
    await writeFile(path, JSON.stringify(web));

    const listed = envelope(await cli(["ls", "--remote", "--json"]));
    expect(listed.data.sandboxes).toMatchObject([{ id, name: null }]);

    const adopted = envelope(await cli(["adopt", id, "--name", "here", "--json"]));
    expect(adopted.data).toMatchObject({ name: "here", id, adopted: true });

    const relisted = envelope(await cli(["ls", "--remote", "--json"]));
    expect(relisted.data.sandboxes).toMatchObject([{ id, name: "here" }]);
    expect(envelope(await cli(["adopt", id, "--json"])).error.code).toBe("CONFLICT");

    // An id that names two stored sandboxes is refused rather than guessed.
    const ambiguous = envelope(await cli(["inspect", id, "--json"]));
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(envelope(await cli(["inspect", "here", "--json"])).data.info.state).toBe("running");
  });

  test("rm --all skips records it cannot destroy and reports them", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"]);
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "ambiguous_before_effect",
    });
    await cli(["create", "--name", "lost", "--prepared", "fake-starter"]);

    const result = await cli(["rm", "--all", "--json"]);

    expect(result.code).toBe(0);
    expect(envelope(result).data).toMatchObject({
      removed: [{ name: "web", result: "destroyed" }],
      skipped: [{ name: "lost", result: "skipped" }],
    });
    expect(await storeNames()).toEqual(["lost.json"]);
  });

  test("rm keeps going after a failure and exits 8 with per-sandbox results", async () => {
    await cli(["create", "--name", "a", "--prepared", "fake-starter"]);
    await cli(["create", "--name", "b", "--prepared", "fake-starter"]);
    await control("/_test/seed", { submissionId: "*", action: "destroy", behavior: "reject" });

    const result = await cli(["rm", "a", "b", "--json"]);
    const error = envelope(result).error;

    expect(result.code).toBe(8);
    expect(error).toMatchObject({ code: "PARTIAL", outcome: "partial" });
    expect(error.details.removed.map((item: { name: string }) => item.name)).toEqual(["b"]);
    expect(error.details.failed.map((item: { name: string }) => item.name)).toEqual(["a"]);
    expect(await storeNames()).toEqual(["a.json"]);
  });

  test("a run whose cleanup fails prints one document with the command result", async () => {
    await seedExec(["echo", "hi"], 0, "hi\n");
    await control("/_test/seed", { submissionId: "*", action: "destroy", behavior: "reject" });

    const result = await cli([
      "run",
      "--json",
      "--name",
      "job",
      "--prepared",
      "fake-starter",
      "--",
      "echo",
      "hi",
    ]);

    expect(result.code).toBe(125);
    expect(envelope(result).error).toMatchObject({
      code: "CLEANUP_FAILED",
      outcome: "partial",
      known: { sandbox: "job", exec: { exitCode: 0, stdout: "hi\n" } },
    });
    expect(await storeNames()).toEqual(["job.json"]);
  });

  test("a relative SANDBAR_STATE_DIR is relative to the working directory", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"], {
      SANDBAR_STATE_DIR: "./run1",
    });

    expect(await readdir(join(dir, "run1", "sandboxes"))).toEqual(["web.json"]);
  });

  test("ls warns about an unreadable record and lists the rest", async () => {
    await cli(["create", "--name", "web", "--prepared", "fake-starter"]);
    await writeFile(join(dir, "state", "sandboxes", "broken.json"), "{");

    const result = await cli(["ls", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("broken.json");
    expect(envelope(result).data.sandboxes.map((row: { name: string }) => row.name)).toEqual([
      "web",
    ]);
  });

  test("cp --no-clobber also protects local files", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await writeFile(join(dir, "in.txt"), "new\n");
    await cli(["cp", "in.txt", "box:/work/in.txt"]);
    await writeFile(join(dir, "out.txt"), "keep\n");

    expect((await cli(["cp", "--no-clobber", "box:/work/in.txt", "out.txt"])).code).toBe(1);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("keep\n");
  });

  test("project node_modules supply adapters only when opted in", async () => {
    await writeConfig({
      default: "acme",
      profiles: { acme: { module: "@acme/sandbar-fake", export: "fake" } },
    });
    await adapterPackage(join(dir, "node_modules"), "./index.js");

    expect((await cli(["doctor", "--json"])).code).toBe(4);
    expect((await cli(["doctor", "--json"], { SANDBAR_PROJECT_ADAPTERS: "1" })).code).toBe(0);
  });

  describe("password-manager credentials", () => {
    const secretId = "0b8c4a9e-6f1d-4e2a-9c3b-5d7e8f9a0b1c";

    // Stand-ins for each manager's CLI: they print the secret only for the expected reference.
    const tools = {
      op: `[ "$1 $2 $3" = "read --no-newline op://dev/fake/token" ] && printf %s "$FAKE_SECRET" && exit 0`,
      bws: `[ "$1 $2 $3" = "secret get ${secretId}" ] && printf '{"id":"%s","value":"%s"}' "$3" "$FAKE_SECRET" && exit 0`,
      pass: `[ "$1 $2" = "show dev/fake" ] && printf '%s\\nuser: ci\\n' "$FAKE_SECRET" && exit 0`,
    };

    async function installTools() {
      const bin = join(dir, "bin");
      await mkdir(bin);

      for (const [name, body] of Object.entries(tools)) {
        const path = join(bin, name);
        await writeFile(path, `#!/bin/sh\n${body}\necho "no such item" >&2\nexit 1\n`);
        await chmod(path, 0o755);
      }

      return { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_SECRET: token };
    }

    async function useToken(reference: string) {
      await writeConfig({
        default: "guarded",
        profiles: {
          guarded: { module: fixture, export: "guarded", credentials: { token: reference } },
        },
      });
    }

    for (const reference of ["op://dev/fake/token", `bws://${secretId}`, "pass://dev/fake"])
      test(`${reference.split(":")[0]} references are read when the profile connects`, async () => {
        const env = await installTools();
        await useToken(reference);

        const result = await cli(["create", "--name", "web", "--prepared", "fake-starter"], env);

        expect(result).toMatchObject({ code: 0, stdout: "web\n" });
        expect(await readFile(join(dir, "state", "sandboxes", "web.json"), "utf8")).not.toContain(
          token,
        );
      });

    test("an unreadable reference is an auth error that names the reference", async () => {
      const env = await installTools();
      await useToken("op://dev/missing/token");

      const result = await cli(["create", "--prepared", "fake-starter", "--json"], env);

      expect(result.code).toBe(5);
      expect(envelope(result).error).toMatchObject({ code: "SECRET_UNAVAILABLE" });
      expect(envelope(result).error.message).toContain("op://dev/missing/token");
      expect(envelope(result).error.message).toContain("no such item");
      expect(await storeNames()).toEqual([]);
    });

    test("a missing manager CLI says what to install", async () => {
      await useToken("pass://dev/fake");

      const result = await cli(["create", "--prepared", "fake-starter", "--json"]);

      expect(result.code).toBe(4);
      expect(envelope(result).error).toMatchObject({ code: "SECRET_TOOL_MISSING" });
      expect(envelope(result).error.hint).toContain("passwordstore.org");
    });
  });

  describe("skill", () => {
    const installed = (base: string, agent: string) =>
      join(base, agent, "skills", "sandbar-cli", "SKILL.md");

    test("prints the bundled skill", async () => {
      const bundled = await readFile(
        join(import.meta.dir, "..", "..", "..", "skills", "sandbar-cli", "SKILL.md"),
        "utf8",
      );

      expect(await cli(["skill"])).toMatchObject({ code: 0, stdout: bundled });
    });

    test("install writes .agents and, where Claude Code is set up, .claude", async () => {
      await mkdir(join(dir, ".claude"));

      const first = envelope(await cli(["skill", "install", "--json"]));

      expect(first.data.installed.map((entry: { result: string }) => entry.result)).toEqual([
        "written",
        "written",
      ]);
      expect(await readFile(installed(dir, ".claude"), "utf8")).toContain("name: sandbar-cli");

      const again = envelope(await cli(["skill", "install", "--json"]));

      expect(again.data.installed.map((entry: { result: string }) => entry.result)).toEqual([
        "unchanged",
        "unchanged",
      ]);
    });

    test("install never replaces a copy installed another way", async () => {
      const foreign = installed(dir, ".agents");
      await mkdir(join(foreign, ".."), { recursive: true });
      await writeFile(foreign, "my own notes\n");

      const result = await cli(["skill", "install", "--json"]);

      expect(result.code).toBe(1);
      expect(envelope(result).error.code).toBe("CONFLICT");
      expect(await readFile(foreign, "utf8")).toBe("my own notes\n");
    });

    test("--project installs into the working directory", async () => {
      const project = join(dir, "project");
      await mkdir(project);

      const result = await cli(
        ["skill", "install", "--project"],
        { HOME: join(dir, "home") },
        undefined,
        project,
      );

      expect(result.code).toBe(0);
      expect(await readFile(installed(project, ".agents"), "utf8")).toContain(
        "sandbar skill install",
      );
    });
  });

  describe("shell completion", () => {
    const values = async (...words: string[]) => {
      const lines = (await cli(["__complete", "--", ...words])).stdout.trim().split("\n");

      return {
        values: lines.slice(0, -1).map((line) => line.split("\t")[0]),
        directive: lines.at(-1),
      };
    };

    test("completes commands, flags and provider ids", async () => {
      expect((await values("")).values).toContain("exec");
      expect((await values("exec", "web", "--ti")).values).toContain("--timeout");
      expect((await values("--provider", "")).values).toEqual([
        "daytona",
        "e2b",
        "boxd",
        "boat",
        "runloop",
        "vercel",
        "modal",
      ]);
      expect((await values("--config", "")).directive).toBe(":2");
    });

    test("completes sandbox names from the store without calling the provider", async () => {
      await cli(["create", "--name", "web", "--prepared", "fake-starter"]);
      await control("/_test/reset", {});

      expect((await values("exec", "")).values).toEqual(["web"]);
      expect((await values("exec", "web", "")).values).toEqual([]);
      expect(await values("cp", "")).toEqual({ values: ["web:"], directive: ":3" });
      expect((await values("exec", "web", "--", "")).directive).toBe(":2");
    });

    test("profile names come from sandbar.json", async () => {
      expect((await values("--profile", "")).values).toEqual(["fake"]);
    });

    test("prints a script for each shell", async () => {
      for (const shell of ["zsh", "bash", "fish"])
        expect((await cli(["completion", shell])).stdout).toContain("sandbar __complete");
      expect((await cli(["completion", "tcsh"])).code).toBe(2);
    });
  });

  describe("findings from the first live run", () => {
    test("run --json names the sandbox it created and destroyed", async () => {
      await seedExec(["true"], 0, "");

      const result = await cli([
        "run",
        "--json",
        "--name",
        "job",
        "--prepared",
        "fake-starter",
        "--",
        "true",
      ]);

      const resources = await fakeResources();

      expect(envelope(result).data.sandbox).toEqual({
        name: "job",
        id: resources[0]!.ref.nativeId,
        kept: false,
      });
    });

    test("inspect prints the reference once", async () => {
      await cli(["create", "--name", "web", "--prepared", "fake-starter"]);

      const data = envelope(await cli(["inspect", "web", "--json"])).data;

      expect(data.reference).toMatchObject({ kind: "sandbox" });
      expect(data.info.reference).toBeUndefined();
    });

    test("providers does not ask for variables a profile already sets", async () => {
      await writeConfig({
        profiles: {
          us: { provider: "daytona", config: { target: "us" }, credentials: { apiKey: "k" } },
        },
      });

      const daytona = envelope(await cli(["providers", "--json"])).data.providers.find(
        (row: { id: string }) => row.id === "daytona",
      );

      expect(daytona.missingEnv).toEqual([]);

      await writeConfig({
        profiles: { e2b: { provider: "e2b", credentials: { apiKey: "env:E2B_API_KEY" } } },
      });

      const e2b = envelope(await cli(["providers", "--json"])).data.providers.find(
        (row: { id: string }) => row.id === "e2b",
      );

      expect(e2b.missingEnv).toEqual(["E2B_API_KEY"]);
    });

    test("an interrupted run destroys its sandbox and says so", async () => {
      await control("/_test/seed", {
        submissionId: "*",
        action: "exec",
        delayObservations: 100,
        command: { command: { kind: "argv", argv: ["sleep", "60"] }, exitCode: 0 },
      });

      const child = Bun.spawn(
        [
          "bun",
          main,
          "run",
          "--json",
          "--name",
          "job",
          "--prepared",
          "fake-starter",
          "--",
          "sleep",
          "60",
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: dir,
            SANDBAR_CONFIG: join(dir, "sandbar.json"),
            SANDBAR_STATE_DIR: join(dir, "state"),
            SANDBAR_FAKE_URL: server.url.origin,
            SANDBAR_FAKE_TOKEN: token,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      for (let attempt = 0; attempt < 100 && !(await fakeResources()).length; attempt++)
        await Bun.sleep(50);
      await Bun.sleep(300);
      child.kill("SIGINT");

      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const error = envelope({ code, stdout, stderr: "" }).error;

      expect(code).toBe(130);
      expect(error).toMatchObject({ code: "INTERRUPTED", known: { sandbox: "job" } });
      expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
      expect(await storeNames()).toEqual([]);
    });
  });

  describe("adapter", () => {
    const adapters = () => join(dir, ".config", "sandbar", "adapters");

    const version = async (): Promise<string> =>
      JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")).version;

    /** Put the stand-in npm (and bun, which runs it) on an otherwise empty PATH. */
    async function fakeNpm(extra: Record<string, string> = {}) {
      const bin = join(dir, "bin");
      await mkdir(bin, { recursive: true });
      await symlink(process.execPath, join(bin, "bun"));
      await symlink(join(import.meta.dir, "fake-npm.ts"), join(bin, "npm"));

      return { PATH: bin, FAKE_NPM_LOG: join(dir, "npm.log"), ...extra };
    }

    async function npmCalls(): Promise<{ args: string[]; cwd: string }[]> {
      try {
        const log = await readFile(join(dir, "npm.log"), "utf8");

        return log
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    }

    test("add installs an official adapter at the CLI's version and reruns without npm", async () => {
      const env = await fakeNpm();
      const cliVersion = await version();

      const added = await cli(["adapter", "add", "e2b", "--json"], env);

      expect(added.code).toBe(0);
      expect(envelope(added).data).toMatchObject({
        dir: adapters(),
        adapters: [
          {
            package: "@sandbar-sdk/e2b",
            provider: "e2b",
            version: cliVersion,
            previous: null,
            result: "installed",
          },
        ],
      });
      expect(envelope(added).data.adapters[0].exports).toContain("e2bAdapter");
      expect(added.stderr).toContain("changed 1 packages");
      expect(await npmCalls()).toEqual([
        {
          args: [
            "install",
            "--prefix",
            adapters(),
            "--no-audit",
            "--no-fund",
            "--save-exact",
            `@sandbar-sdk/e2b@${cliVersion}`,
          ],
          cwd: adapters(),
        },
      ]);
      expect(JSON.parse(await readFile(join(adapters(), "package.json"), "utf8"))).toMatchObject({
        private: true,
        dependencies: { "@sandbar-sdk/e2b": cliVersion },
      });

      const again = await cli(["adapter", "add", "e2b"], env);

      expect(again).toMatchObject({
        code: 0,
        stdout: `unchanged @sandbar-sdk/e2b@${cliVersion} (e2b)\n`,
      });
      expect(await npmCalls()).toHaveLength(1);
    });

    test("an added third-party adapter loads from a profile", async () => {
      const env = await fakeNpm();
      await writeConfig({
        default: "acme",
        profiles: { acme: { module: "@acme/sandbar-fake", export: "fake" } },
      });

      expect((await cli(["doctor", "--json"], env)).code).toBe(4);

      const added = await cli(["adapter", "add", "@acme/sandbar-fake@1.2.0"], env);

      expect(added.code).toBe(0);
      expect(added.stdout).toMatch(/^installed @acme\/sandbar-fake@1\.2\.0 exports .*\bfake\b/);
      expect((await npmCalls())[0]!.args.at(-1)).toBe("@acme/sandbar-fake@1.2.0");
      expect((await cli(["doctor", "--json"], env)).code).toBe(0);
    });

    test("an unknown bare name is refused before npm runs; npm: names it explicitly", async () => {
      const env = await fakeNpm();
      const refused = await cli(["adapter", "add", "e2bb", "--json"], env);

      expect(refused.code).toBe(2);
      expect(envelope(refused).error).toMatchObject({
        code: "USAGE",
        message: "Unknown provider e2bb",
      });
      expect(envelope(refused).error.hint).toContain("npm:e2bb");
      expect(await npmCalls()).toEqual([]);

      expect((await cli(["adapter", "add", "npm:acme-sandbar"], env)).code).toBe(0);
      expect((await npmCalls())[0]!.args.at(-1)).toBe("acme-sandbar");
    });

    test("a package without an adapter export fails verification", async () => {
      const result = await cli(
        ["adapter", "add", "@acme/not-an-adapter", "--json"],
        await fakeNpm(),
      );

      expect(result.code).toBe(4);
      expect(envelope(result).error).toMatchObject({
        code: "ADAPTER_LOAD_FAILED",
        message: "@acme/not-an-adapter exports no Sandbar adapter",
      });
    });

    test("npm failures and a missing npm are reported with their own codes", async () => {
      const failed = await cli(
        ["adapter", "add", "e2b", "--json"],
        await fakeNpm({ FAKE_NPM_FAIL: "1" }),
      );

      expect(failed.code).toBe(1);
      expect(envelope(failed).error.code).toBe("ADAPTER_INSTALL_FAILED");
      expect(envelope(failed).error.message).toContain("404 Not Found");
      expect(failed.stderr).toContain("npm error code E404");

      const bin = join(dir, "bun-only");
      await mkdir(bin);
      await symlink(process.execPath, join(bin, "bun"));

      const missing = await cli(["adapter", "add", "e2b", "--json"], { PATH: bin });

      expect(missing.code).toBe(4);
      expect(envelope(missing).error.code).toBe("ADAPTER_INSTALLER_MISSING");
    });

    test("ls reports versions that differ from the CLI, and rm is idempotent", async () => {
      const env = await fakeNpm();

      expect((await cli(["adapter", "ls"], env)).stdout).toContain("no adapters in");

      const old = await cli(["adapter", "add", "daytona@0.0.1"], env);

      expect(old.code).toBe(0);
      expect(old.stderr).toContain("differs from this CLI");
      await cli(["adapter", "add", "@acme/sandbar-fake"], env);

      const listed = await cli(["adapter", "ls", "--json"], env);

      expect(envelope(listed).data.adapters).toEqual([
        {
          package: "@acme/sandbar-fake",
          provider: null,
          requested: "9.9.9",
          version: "9.9.9",
          status: "ok",
        },
        {
          package: "@sandbar-sdk/daytona",
          provider: "daytona",
          requested: "0.0.1",
          version: "0.0.1",
          status: "version-mismatch",
        },
      ]);

      expect((await cli(["adapter", "rm", "daytona@0.0.1"], env)).code).toBe(2);

      const removed = await cli(["adapter", "rm", "daytona", "e2b", "--json"], env);

      expect(envelope(removed).data.adapters).toEqual([
        { package: "@sandbar-sdk/daytona", provider: "daytona", result: "removed" },
        { package: "@sandbar-sdk/e2b", provider: "e2b", result: "absent" },
      ]);
      expect((await npmCalls()).at(-1)!.args).toEqual([
        "uninstall",
        "--prefix",
        adapters(),
        "--no-audit",
        "--no-fund",
        "@sandbar-sdk/daytona",
      ]);

      const calls = (await npmCalls()).length;

      expect((await cli(["adapter", "rm", "daytona"], env)).stdout).toBe(
        "absent  @sandbar-sdk/daytona\n",
      );
      expect(await npmCalls()).toHaveLength(calls);
    });
  });

  describe("images", () => {
    let builds: string;

    beforeEach(async () => {
      builds = join(dir, "builds.log");
      await writeConfig({
        default: "builder",
        profiles: {
          builder: { module: fixture, export: "builder" },
          fake: { module: fixture, export: "fake" },
        },
      });
    });

    const image = (args: string[]) => cli(args, { SANDBAR_FAKE_BUILDS: builds });

    async function buildLog() {
      try {
        return (await readFile(builds, "utf8")).trim().split("\n");
      } catch {
        return [];
      }
    }

    test("--image on a build-first provider fails before any effect until it is built", async () => {
      const result = await image(["create", "--image", "python:3.12", "--json"]);

      expect(result.code).toBe(4);
      expect(envelope(result).error).toMatchObject({
        code: "UNSUPPORTED",
        outcome: "rejected",
        message:
          "image python:3.12 is not built for profile builder; run: sandbar image build python:3.12",
      });
      expect(envelope(result).error.hint).toContain("--build");
      expect(await buildLog()).toEqual([]);
      expect(await storeNames()).toEqual([]);
      expect(await fakeResources()).toEqual([]);
    });

    test("image build records the prepared image and create reuses it without rebuilding", async () => {
      const built = await image(["image", "build", "python:3.12", "--json"]);

      expect(built.code).toBe(0);
      expect(envelope(built).data).toMatchObject({
        name: "python-3-12",
        source: "python:3.12",
        profile: "builder",
        status: "built",
        prepared: "fake-image-1",
        built: true,
        retainedResources: [
          { kind: "fake-image", id: "fake-image-1", cleanup: "manual", ownership: "verified" },
        ],
      });

      const again = await image(["image", "build", "python:3.12", "--json"]);

      expect(envelope(again).data).toMatchObject({ name: "python-3-12", built: false });

      for (let round = 0; round < 2; round++) {
        await seedExec(["true"], 0, "");
        const run = await image(["run", "--image", "python:3.12", "--", "true"]);

        expect(run.code).toBe(0);
      }

      expect(await buildLog()).toEqual(["python:3.12"]);

      const created = await image(["create", "--name", "py", "--image", "python:3.12", "--json"]);

      expect(created.code).toBe(0);

      const inspected = await image(["inspect", "py", "--json"]);

      expect(envelope(inspected).data.image).toBe("python:3.12");

      const listed = await image(["image", "ls", "--json"]);

      expect(envelope(listed).data.images.map((row: { name: string }) => row.name)).toEqual([
        "python-3-12",
      ]);
    });

    test("a build is per profile and --refresh builds again", async () => {
      await writeConfig({
        default: "builder",
        profiles: {
          builder: { module: fixture, export: "builder" },
          other: { module: fixture, export: "builder" },
        },
      });

      await image(["image", "build", "python:3.12"]);

      const other = await image([
        "create",
        "--profile",
        "other",
        "--image",
        "python:3.12",
        "--json",
      ]);

      expect(envelope(other).error.code).toBe("UNSUPPORTED");

      const refreshed = await image(["image", "build", "python:3.12", "--refresh", "--json"]);

      expect(envelope(refreshed).data).toMatchObject({ name: "python-3-12", built: true });
      expect(await buildLog()).toEqual(["python:3.12", "python:3.12"]);
    });

    test("--build builds a missing image during create, once", async () => {
      const created = await image(["create", "--image", "node:24", "--build", "--json"]);

      expect(created.code).toBe(0);
      expect(created.stderr).toContain("building node:24");

      await image(["create", "--image", "node:24", "--build"]);

      expect(await buildLog()).toEqual(["node:24"]);
      expect(await readdir(join(dir, "state", "images"))).toEqual(["node-24.json"]);
    });

    test("images.autoBuild opts every create into building", async () => {
      await writeConfig({
        default: "builder",
        profiles: { builder: { module: fixture, export: "builder" } },
        images: { autoBuild: true },
      });

      expect((await image(["create", "--image", "node:24"])).code).toBe(0);
      expect(await buildLog()).toEqual(["node:24"]);
    });

    test("a provider without image builds gets the OCI reference unchanged", async () => {
      const result = await image([
        "create",
        "--profile",
        "fake",
        "--image",
        "python:3.12",
        "--json",
      ]);

      expect(result.code).toBe(4);
      expect(envelope(result).error.message).toContain("fake cannot create this sandbox");

      const build = await image(["image", "build", "python:3.12", "--profile", "fake", "--json"]);

      expect(build.code).toBe(4);
      expect(envelope(build).error.message).toBe("fake does not build images");
      expect(await buildLog()).toEqual([]);
    });

    test("an uncertain build keeps its record and inspect recovers it", async () => {
      const lost = await image(["image", "build", "lost/tool:1", "--json"]);

      expect(lost.code).toBe(6);
      expect(envelope(lost).error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        known: { image: "tool-1" },
      });
      expect(envelope(lost).error.known.recovery.kind).toBe("image_build");

      const inspected = await image(["image", "inspect", "tool-1", "--json"]);

      expect(inspected.code).toBe(0);
      expect(envelope(inspected).data).toMatchObject({
        status: "built",
        prepared: "fake-image-1",
        // Found again after a lost response, so the build does not claim verified ownership.
        reference: { kind: "image", nativeId: "fake-image-1", ownership: "unknown" },
      });
      expect(await buildLog()).toEqual(["lost/tool:1"]);
    });

    test("forget drops the record and lists what the provider still holds", async () => {
      await image(["image", "build", "python:3.12", "--name", "py"]);

      const forgot = await image(["image", "forget", "py"]);

      expect(forgot.code).toBe(0);
      expect(forgot.stdout).toContain("fake-image fake-image-1 (cleanup manual");
      expect(forgot.stdout).toContain("forget never deletes them");
      expect((await image(["image", "inspect", "py", "--json"])).code).toBe(3);

      const named = await image(["image", "build", "python:3.12", "--name", "Bad Name", "--json"]);

      expect(named.code).toBe(2);
    });

    test("image rm deletes the built image on the provider and then the record", async () => {
      const built = await image(["image", "build", "python:3.12", "--json"]);

      expect(envelope(built).data.prepared).toBe("fake-image-1");

      const remote = await image(["image", "ls", "--remote", "--json"]);

      expect(remote.code).toBe(0);
      expect(envelope(remote).data).toMatchObject({
        profile: "builder",
        coverage: "provider-scope",
      });
      expect(
        envelope(remote).data.images.map((row: { id: string; record: string | null }) => [
          row.id,
          row.record,
        ]),
      ).toEqual([
        ["fake-starter", null],
        ["fake-image-1", "python-3-12"],
      ]);
      expect((await image(["image", "ls", "--remote"])).stdout).toContain("python-3-12");

      const removed = await image(["image", "rm", "python-3-12", "--json"]);

      expect(removed.code).toBe(0);
      expect(envelope(removed).data).toMatchObject({
        name: "python-3-12",
        result: "deleted",
        prepared: "fake-image-1",
        retainedResources: [],
      });
      expect((await image(["image", "inspect", "python-3-12", "--json"])).code).toBe(3);

      const after = await image(["image", "ls", "--remote", "--json"]);

      expect(envelope(after).data.images.map((row: { id: string }) => row.id)).toEqual([
        "fake-starter",
      ]);
    });

    test("image rm refuses an image a sandbox still uses and keeps the record", async () => {
      await image(["image", "build", "python:3.12"]);
      expect((await image(["create", "--name", "py", "--image", "python:3.12"])).code).toBe(0);

      const refused = await image(["image", "rm", "python-3-12", "--json"]);

      expect(refused.code).not.toBe(0);
      expect(refused.code).not.toBe(6);
      expect(envelope(refused).error).toMatchObject({ code: "CONFLICT", outcome: "rejected" });
      expect((await image(["image", "inspect", "python-3-12", "--json"])).code).toBe(0);

      expect((await image(["rm", "py"])).code).toBe(0);
      expect((await image(["image", "rm", "python-3-12"])).code).toBe(0);
    });

    test("an uncertain image rm keeps the record and a second rm confirms without resubmitting", async () => {
      await image(["image", "build", "lost/tool:2"]);
      expect((await image(["image", "inspect", "tool-2", "--json"])).code).toBe(0);

      // The build was recovered from an uncertain response, so this CLI cannot prove it made it.
      const refused = await image(["image", "rm", "tool-2", "--json"]);

      expect(envelope(refused).error.code).toBe("FORBIDDEN");

      const lost = await image(["image", "rm", "tool-2", "--force", "--json"]);

      expect(lost.code).toBe(6);
      expect(envelope(lost).error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: "unknown",
        known: { image: "tool-2", recovery: { kind: "image_delete" } },
      });

      const kept = await image(["image", "inspect", "tool-2", "--json"]);

      expect(envelope(kept).data.status).toBe("deleting");

      // A deleting record is never reused for a create.
      const create = await image(["create", "--image", "lost/tool:2", "--json"]);

      expect(envelope(create).error.code).toBe("UNSUPPORTED");

      const confirmed = await image(["image", "rm", "tool-2", "--json"]);

      expect(confirmed.code).toBe(0);
      expect(envelope(confirmed).data).toMatchObject({ name: "tool-2", result: "deleted" });
      expect((await image(["image", "inspect", "tool-2", "--json"])).code).toBe(3);
    });

    test("image rm deletes a build this CLI did not verifiably create only with --force", async () => {
      await image(["image", "build", "python:3.12"]);
      const path = join(dir, "state", "images", "python-3-12.json");
      // A record from an older CLI has no image reference, so its ownership is unknown.
      const { reference: _reference, ...legacy } = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify(legacy));

      const refused = await image(["image", "rm", "python-3-12", "--json"]);

      expect(refused.code).not.toBe(0);
      expect(envelope(refused).error).toMatchObject({
        code: "FORBIDDEN",
        outcome: "rejected",
        message: "python-3-12 was not created by this CLI (ownership unknown)",
        hint: "pass --force to delete it anyway",
      });
      expect((await image(["image", "inspect", "python-3-12", "--json"])).code).toBe(0);
      expect((await image(["image", "ls", "--force"])).code).toBe(2);

      const forced = await image(["image", "rm", "python-3-12", "--force", "--json"]);

      expect(forced.code).toBe(0);
      expect(envelope(forced).data).toMatchObject({ name: "python-3-12", result: "deleted" });
    });

    test("an uncertain image rm with nothing to observe keeps the record built", async () => {
      await writeConfig({
        default: "unobservable",
        profiles: { unobservable: { module: fixture, export: "unobservableDelete" } },
      });
      await image(["image", "build", "python:3.12"]);

      const lost = await image(["image", "rm", "python-3-12", "--json"]);

      expect(lost.code).toBe(6);
      expect(envelope(lost).error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: "unknown",
        known: { image: "python-3-12" },
      });
      expect(envelope(lost).error.known.recovery).toBeUndefined();
      expect(envelope(lost).error.hint).toContain("no saved delete to check");

      const kept = await image(["image", "inspect", "python-3-12", "--json"]);

      expect(envelope(kept).data).toMatchObject({ status: "built", recovery: null });
    });

    test("a deleting record with no saved delete returns to built instead of sticking", async () => {
      await image(["image", "build", "python:3.12"]);
      const path = join(dir, "state", "images", "python-3-12.json");
      const record = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...record, status: "deleting" }));

      const stuck = await image(["image", "rm", "python-3-12", "--json"]);

      expect(stuck.code).toBe(6);
      expect(envelope(stuck).error.message).toBe("python-3-12 has no saved delete to check");
      expect(envelope(await image(["image", "inspect", "python-3-12", "--json"])).data.status).toBe(
        "built",
      );
      expect((await image(["image", "rm", "python-3-12"])).code).toBe(0);
    });

    test("a failed check of an uncertain delete keeps the record deleting", async () => {
      await image(["image", "build", "lost/tool:2"]);
      expect((await image(["image", "rm", "tool-2", "--force"])).code).toBe(6);

      const saved = envelope(await image(["image", "inspect", "tool-2", "--json"])).data;

      expect(saved.status).toBe("deleting");

      // The profile now reaches another account, which cannot check the saved delete.
      await writeConfig({
        default: "builder",
        profiles: { builder: { module: fixture, export: "otherAccount" } },
      });

      const checked = await image(["image", "rm", "tool-2", "--json"]);

      expect(checked.code).toBe(5);
      expect(envelope(checked).error).toMatchObject({
        code: "FORBIDDEN",
        known: { image: "tool-2", recovery: { kind: "image_delete" } },
      });
      expect(envelope(checked).error.hint).toContain("account the delete was sent from");

      const kept = envelope(await image(["image", "inspect", "tool-2", "--json"])).data;

      expect(kept).toMatchObject({ status: "deleting", recovery: saved.recovery });

      // Back on the original account, rm checks the saved delete and completes.
      await writeConfig({
        default: "builder",
        profiles: { builder: { module: fixture, export: "builder" } },
      });

      const confirmed = await image(["image", "rm", "tool-2", "--json"]);

      expect(confirmed.code).toBe(0);
      expect(envelope(confirmed).data).toMatchObject({ name: "tool-2", result: "deleted" });
    });

    test("image ls --remote reports an unsupported provider and --remote is ls-only", async () => {
      await writeConfig({
        default: "builder",
        profiles: {
          builder: { module: fixture, export: "builder" },
          plain: { module: fixture, export: "plain" },
        },
      });
      await image(["image", "build", "python:3.12", "--name", "py"]);

      const listed = await image(["image", "ls", "--remote", "--profile", "plain", "--json"]);

      expect(listed.code).toBe(4);
      expect(envelope(listed).error.message).toBe("plain cannot list images through Sandbar");

      expect((await image(["image", "ls", "py", "--remote"])).code).toBe(2);
      expect((await image(["image", "inspect", "py", "--remote"])).code).toBe(2);
    });

    test("image completion offers actions and recorded names", async () => {
      await image(["image", "build", "python:3.12"]);

      expect((await cli(["__complete", "--", "image", ""])).stdout).toContain("build");
      expect((await cli(["__complete", "--", "image", ""])).stdout).toContain("rm");
      expect((await cli(["__complete", "--", "image", "rm", ""])).stdout).toContain(
        "python-3-12\tpython:3.12 on builder",
      );
      expect((await cli(["__complete", "--", "image", "forget", ""])).stdout).toContain(
        "python-3-12\tpython:3.12 on builder",
      );
    });
  });
});

describe("create-time environment", () => {
  const secret = "CANARY-cli-env-secret";

  async function storeText() {
    const directory = join(dir, "state");
    const files = await readdir(directory, { recursive: true }).catch(() => []);

    const texts = await Promise.all(
      files.map((file) => readFile(join(directory, String(file)), "utf8").catch(() => "")),
    );

    return texts.join("\n");
  }

  test("--env-file, --env and --env NAME reach the native create and no value is kept", async () => {
    await writeFile(
      join(dir, "ci.env"),
      [
        "# comment",
        "export MODE=file",
        'QUOTED="a b"',
        "",
        "API_TOKEN=from-file",
        "PLAIN=  spaced value   # a comment",
        "HASHED=a#b",
        "EMPTY= # nothing",
        'ESCAPED="line\\none \\"q\\" back\\\\slash" # comment',
        "LITERAL='raw \\n \\\\' # comment",
      ].join("\n") + "\n",
    );

    const created = await cli(
      [
        "create",
        "--name",
        "box",
        "--prepared",
        "fake-starter",
        "--env-file",
        "ci.env",
        "--env",
        "MODE=flag",
        "--env",
        "API_TOKEN",
        "--json",
      ],
      { API_TOKEN: secret },
    );

    expect(created.code).toBe(0);
    expect(envelope(created).data.name).toBe("box");
    expect(`${created.stdout}${created.stderr}`).not.toContain(secret);
    expect(`${created.stdout}${created.stderr}`).not.toContain("from-file");
    expect(await storeText()).not.toContain(secret);

    const [resource] = await fakeResources();
    // SAFETY: The fake engine's test state includes the native create-time environment.
    expect((resource as FakeResource & { env?: Record<string, string> }).env).toEqual({
      MODE: "flag",
      QUOTED: "a b",
      API_TOKEN: secret,
      PLAIN: "spaced value",
      HASHED: "a#b",
      EMPTY: "",
      ESCAPED: 'line\none "q" back\\slash',
      LITERAL: "raw \\n \\\\",
    });

    // The fake matches an exec fixture against the sandbox env merged under the call's env.
    await control("/_test/seed", {
      submissionId: "*",
      action: "exec",
      command: {
        command: { kind: "argv", argv: ["printenv"] },
        env: {
          MODE: "call",
          QUOTED: "a b",
          API_TOKEN: secret,
          PLAIN: "spaced value",
          HASHED: "a#b",
          EMPTY: "",
          ESCAPED: 'line\none "q" back\\slash',
          LITERAL: "raw \\n \\\\",
        },
        exitCode: 0,
        stdoutBase64: Buffer.from("ok\n").toString("base64"),
      },
    });

    expect(await cli(["exec", "box", "--env", "MODE=call", "--", "printenv"])).toMatchObject({
      code: 0,
      stdout: "ok\n",
    });
    expect(await storeText()).not.toContain(secret);
  });

  test("an adapter without create env fails before creating and echoes no value", async () => {
    await writeConfig({
      default: "fake",
      profiles: { fake: { module: fixture, export: "withoutCreateEnv" } },
    });

    const result = await cli([
      "create",
      "--name",
      "box",
      "--prepared",
      "fake-starter",
      "--env",
      `API_TOKEN=${secret}`,
      "--json",
    ]);

    expect(result.code).not.toBe(0);
    expect(envelope(result).error.code).toBe("UNSUPPORTED");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(await fakeResources()).toEqual([]);
    expect(await storeNames()).toEqual([]);
  });

  test("malformed env input is a usage error that names no value", async () => {
    await writeFile(join(dir, "bad.env"), `GOOD=1\n${secret}\n`);

    for (const args of [
      ["--env-file", "bad.env"],
      ["--env", `9BAD=${secret}`],
      ["--env", "UNSET_FOR_TEST"],
      ["--env-file", "missing.env"],
    ]) {
      const result = await cli(["create", "--prepared", "fake-starter", ...args, "--json"]);

      expect(result.code).toBe(2);
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    }

    expect(envelope(await cli(["create", "--env-file", "bad.env", "--json"])).error.message).toBe(
      "--env-file bad.env:2 must be NAME=VALUE with a valid NAME",
    );

    await writeFile(join(dir, "multi.env"), `GOOD=1\nKEY="${secret}\nrest"\n`);
    await writeFile(join(dir, "trailing.env"), `KEY="${secret}" ${secret}\n`);

    for (const [file, message] of [
      [
        "multi.env",
        "--env-file multi.env:2 has an unterminated quoted value; multi-line values are not supported",
      ],
      ["trailing.env", "--env-file trailing.env:1 has text after the closing quote"],
    ]) {
      const result = await cli([
        "create",
        "--prepared",
        "fake-starter",
        "--env-file",
        file!,
        "--json",
      ]);

      expect(result.code).toBe(2);
      expect(envelope(result).error.message).toBe(message);
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    }

    expect(await fakeResources()).toEqual([]);
  });
});

describe("streaming exec output", () => {
  let terminations: string;

  beforeEach(async () => {
    terminations = join(dir, "terminations.log");
    await writeConfig({
      default: "streaming",
      profiles: {
        streaming: { module: fixture, export: "streaming" },
        hanging: { module: fixture, export: "hanging" },
        "hanging-text": { module: fixture, export: "hangingText" },
      },
    });
  });

  async function terminated() {
    return (await readFile(terminations, "utf8").catch(() => "")).split("\n").filter(Boolean);
  }

  /** Start the CLI and send `signal` once the command's first output reaches stdout. */
  async function interrupt(args: string[], signal: NodeJS.Signals): Promise<Result> {
    const child = Bun.spawn(["bun", main, ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        SANDBAR_CONFIG: join(dir, "sandbar.json"),
        SANDBAR_STATE_DIR: join(dir, "state"),
        SANDBAR_FAKE_URL: server.url.origin,
        SANDBAR_FAKE_TOKEN: token,
        SANDBAR_FAKE_TERMINATIONS: terminations,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let stdout = "";

    const reader = child.stdout.getReader();

    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      if (!stdout) child.kill(signal);
      stdout += decoder.decode(read.value, { stream: true });
    }

    return { code: await child.exited, stdout, stderr: await stderr };
  }

  test("exec, sh and run stream stdout, stderr and the exit code where the provider can", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await seedExec(["make", "test"], 7, "building\n", "1 failed\n");

    expect(await cli(["exec", "box", "--", "make", "test"])).toEqual({
      code: 7,
      stdout: "building\n",
      stderr: "1 failed\n",
    });

    await seedExec("echo hi", 0, "hi\n");

    expect(await cli(["sh", "box", "echo hi"])).toEqual({ code: 0, stdout: "hi\n", stderr: "" });

    await seedExec(["make"], 3, "made\n");

    expect(await cli(["run", "--prepared", "fake-starter", "--", "make"])).toEqual({
      code: 3,
      stdout: "made\n",
      stderr: "",
    });
  });

  test("output arrives before the command ends, and --timeout terminates it", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter", "--profile", "hanging"]);
    await seedExec(["serve"], 0, "listening\n");

    const result = await cli(["exec", "box", "--timeout", "1s", "--", "serve"], {
      SANDBAR_FAKE_TERMINATIONS: terminations,
    });

    expect(result.code).toBe(125);
    expect(result.stdout).toBe("listening\n");
    expect(result.stderr).toContain("ran past --timeout 1s; termination was requested");
    expect(await terminated()).toEqual(["terminate"]);
  });

  test("a provider that streams only text still streams", async () => {
    await cli([
      "create",
      "--name",
      "box",
      "--prepared",
      "fake-starter",
      "--profile",
      "hanging-text",
    ]);
    await seedExec(["serve"], 0, "listening ✓\n", "warming up\n");

    const result = await cli(["exec", "box", "--timeout", "1s", "--", "serve"], {
      SANDBAR_FAKE_TERMINATIONS: terminations,
    });

    expect(result.code).toBe(125);
    expect(result.stdout).toBe("listening ✓\n");
    expect(result.stderr).toStartWith("warming up\n");
    expect(await terminated()).toEqual(["terminate"]);
  });

  test("Ctrl-C terminates an exec and exits 130", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter", "--profile", "hanging"]);
    await seedExec(["serve"], 0, "listening\n");

    const result = await interrupt(["exec", "box", "--", "serve"], "SIGINT");

    expect(result.code).toBe(130);
    expect(result.stdout).toBe("listening\n");
    expect(result.stderr).toContain("interrupted; termination was requested");
    expect(await terminated()).toEqual(["terminate"]);
    expect(await storeNames()).toEqual(["box.json"]);
  });

  test("SIGTERM terminates a run's command and still destroys its sandbox", async () => {
    await seedExec(["serve"], 0, "listening\n");

    const result = await interrupt(
      ["run", "--profile", "hanging", "--prepared", "fake-starter", "--", "serve"],
      "SIGTERM",
    );

    expect(result.code).toBe(143);
    expect(result.stderr).toContain("was destroyed");
    expect(await terminated()).toEqual(["terminate"]);
    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
    expect(await storeNames()).toEqual([]);
  });

  test("--json and --no-stream keep the buffered exec, which a held process never reaches", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter", "--profile", "hanging"]);
    await seedExec(["serve"], 0, "listening\n");

    const json = await cli(["exec", "box", "--json", "--", "serve"]);

    expect(envelope(json)).toMatchObject({
      ok: true,
      data: { exitCode: 0, stdout: "listening\n", stderr: "", truncated: false },
    });
    await seedExec(["serve"], 0, "listening\n");

    expect(await cli(["exec", "box", "--no-stream", "--", "serve"])).toEqual({
      code: 0,
      stdout: "listening\n",
      stderr: "",
    });
  });

  test("providers without streaming keep buffered output", async () => {
    await writeConfig({ default: "fake", profiles: { fake: { module: fixture, export: "fake" } } });
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await seedExec(["make", "test"], 7, "building\n", "1 failed\n");

    expect(await cli(["exec", "box", "--", "make", "test"])).toEqual({
      code: 7,
      stdout: "building\n",
      stderr: "1 failed\n",
    });
  });
});

describe("directory transfer", () => {
  const staging = "/tmp/sandbar.fixture";

  async function seedCommand(
    command: Json,
    exitCode: number,
    stdout: string,
    stderr = "",
    cwd?: string,
  ) {
    const output = {
      exitCode,
      stdoutBase64: Buffer.from(stdout).toString("base64"),
      stderrBase64: Buffer.from(stderr).toString("base64"),
    };

    await control("/_test/seed", {
      submissionId: "*",
      action: "exec",
      command: cwd ? { command, cwd, ...output } : { command, ...output },
    });
  }

  const seedScript = (script: string, exitCode: number, stdout: string, stderr = "") =>
    seedCommand({ kind: "shell", script }, exitCode, stdout, stderr);

  /** The archive the CLI staged in the fake sandbox, as path → text (or link target). */
  async function staged(): Promise<Record<string, string>> {
    const response = await fetch(new URL("/_test/state", server.url), {
      headers: { Authorization: `Bearer ${token}` },
    });

    const files: Record<string, string> = (await response.json()).resources[0].files;

    const parts = Object.keys(files)
      .filter((path) => path.startsWith(`${staging}/part.`))
      .sort();

    const contents: Record<string, string> = {};

    async function* bytes() {
      for (const part of parts) yield new Uint8Array(Buffer.from(files[part]!, "base64"));
    }

    await readTar(bytes(), async (entry, body) => {
      const chunks: Uint8Array[] = [];

      for await (const chunk of body) chunks.push(chunk);
      contents[entry.path] =
        entry.kind === "symlink"
          ? `-> ${entry.link}`
          : entry.kind === "directory"
            ? "dir"
            : Buffer.concat(chunks).toString();
    });

    return contents;
  }

  async function gitRepo(): Promise<string> {
    const repo = join(dir, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, ".gitignore"), "*.log\n");
    await writeFile(join(repo, "src", "main.ts"), "main\n");
    await writeFile(join(repo, "debug.log"), "ignored\n");
    await writeFile(join(repo, "notes.md"), "untracked\n");
    await symlink("src/main.ts", join(repo, "entry"));

    for (const args of [
      ["init", "-q"],
      ["add", ".gitignore", "src", "entry"],
    ]) {
      const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });

      expect(await child.exited).toBe(0);
    }

    return repo;
  }

  test("push sends git-tracked and unignored files and unpacks them with one command", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await gitRepo();
    await seedScript(scripts.prepare(defaultPushDir), 0, `${staging}\nnone\n`);
    await seedScript(scripts.unpack(staging, defaultPushDir), 0, "/home/user/work\n");

    const result = await cli(["push", "box", "repo", "--json"]);

    expect(result.code).toBe(0);
    expect(envelope(result)).toEqual({
      ok: true,
      data: {
        sandbox: "box",
        path: "/home/user/work",
        files: 3,
        directories: 1,
        symlinks: 1,
        bytes: 21,
      },
    });
    expect(await staged()).toEqual({
      ".gitignore": "*.log\n",
      entry: "-> src/main.ts",
      "notes.md": "untracked\n",
      "src/": "dir",
      "src/main.ts": "main\n",
    });
  });

  test("push to an explicit folder honors --exclude and prints the folder", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    const repo = await gitRepo();
    await seedScript(scripts.prepare(shellQuote("/srv/app")), 0, `${staging}\nnone\n`);
    await seedScript(scripts.unpack(staging, shellQuote("/srv/app")), 0, "/srv/app\n");

    const result = await cli(["push", "box:/srv/app/", "--exclude", "*.md"], {}, undefined, repo);

    expect(result).toMatchObject({ code: 0, stdout: "/srv/app\n" });
    expect(Object.keys(await staged())).not.toContain("notes.md");
  });

  test("a sandbox without tar fails clearly before anything is sent", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await gitRepo();
    await seedScript(scripts.prepare(defaultPushDir), 127, "", "tar is not installed\n");

    const result = await cli(["push", "box", "repo", "--json"]);

    expect(result.code).toBe(4);
    expect(envelope(result).error).toMatchObject({
      code: "UNSUPPORTED",
      message: "tar is not installed in sandbox box",
    });
    expect(await staged()).toEqual({});
  });

  test("cp -r into an existing sandbox folder nests the copy like cp", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await mkdir(join(dir, "site", "css"), { recursive: true });
    await writeFile(join(dir, "site", "index.html"), "<p>hi</p>\n");
    await writeFile(join(dir, "site", "css", "a.css"), "p{}\n");
    await writeFile(join(dir, "site", "debug.log"), "skip\n");
    const nested = `${shellQuote("/work")}/${shellQuote("site")}`;
    await seedScript(scripts.prepare(shellQuote("/work")), 0, `${staging}\ndirectory\n`);
    await seedScript(scripts.unpack(staging, nested), 0, "/work/site\n");

    const result = await cli(["cp", "-r", "site", "box:/work", "--exclude", "*.log", "--json"]);

    expect(envelope(result).data).toMatchObject({ path: "/work/site", files: 2, directories: 1 });
    expect(await staged()).toEqual({
      "css/": "dir",
      "css/a.css": "p{}\n",
      "index.html": "<p>hi</p>\n",
    });
  });

  test("cp -r out of a sandbox writes the tree locally with modes and links", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    const source = join(dir, "remote");
    await mkdir(join(source, "out", "sub"), { recursive: true });
    await writeFile(join(source, "out", "run.sh"), "echo ok\n", { mode: 0o755 });
    await writeFile(join(source, "out", "sub", "junit.xml"), "<testsuite/>\n");
    await symlink("sub/junit.xml", join(source, "out", "latest"));
    const tar = Bun.spawn(["tar", "-c", "-f", join(dir, "out.tar"), "out"], { cwd: source });

    expect(await tar.exited).toBe(0);
    expect((await cli(["cp", join(dir, "out.tar"), `box:${staging}/part.aaaaaa`])).code).toBe(0);
    await seedScript(scripts.pack("/work/out", true), 0, `${staging}\npart.aaaaaa\n`);
    await seedScript(scripts.cleanup(staging), 0, "");
    await mkdir(join(dir, "results"));

    const result = await cli(["cp", "-r", "box:/work/out/", "results", "--json"]);

    expect(envelope(result).data).toEqual({
      sandbox: "box",
      path: join(dir, "results", "out"),
      files: 2,
      directories: 2,
      symlinks: 1,
      bytes: 21,
    });
    expect(await readFile(join(dir, "results", "out", "sub", "junit.xml"), "utf8")).toBe(
      "<testsuite/>\n",
    );
    expect((await stat(join(dir, "results", "out", "run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(dir, "results", "out", "latest"))).toBe("sub/junit.xml");
  });

  test("cp -r reports a missing sandbox path as not found", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await seedScript(scripts.pack("/work/none", true), 66, "", "No such file or directory\n");

    const result = await cli(["cp", "-r", "box:/work/none", "copy", "--json"]);

    expect(result.code).toBe(3);
    expect(envelope(result).error.code).toBe("NOT_FOUND");
  });

  test("a directory without -r, or / itself, is a usage error", async () => {
    await cli(["create", "--name", "box", "--prepared", "fake-starter"]);
    await mkdir(join(dir, "folder"));

    expect((await cli(["cp", "folder", "box:/work"])).stderr).toContain("pass -r to copy it");
    expect((await cli(["cp", "-r", "box:/", "copy"])).code).toBe(2);
    expect((await cli(["cp", "--exclude", "x", "a", "box:/b"])).code).toBe(2);
  });

  test("run --push sends the folder, runs there and destroys the sandbox", async () => {
    const repo = await gitRepo();
    await seedScript(scripts.prepare(defaultPushDir), 0, `${staging}\nnone\n`);
    await seedScript(scripts.unpack(staging, defaultPushDir), 0, "/home/user/work\n");
    await seedCommand(
      { kind: "argv", argv: ["cat", "src/main.ts"] },
      0,
      "main\n",
      "",
      "/home/user/work",
    );

    const result = await cli(
      ["run", "--prepared", "fake-starter", "--push", ".", "--", "cat", "src/main.ts"],
      {},
      undefined,
      repo,
    );

    expect(result).toMatchObject({ code: 0, stdout: "main\n" });
    expect(result.stderr).toContain("pushed 3 file(s) to /home/user/work");
    expect((await fakeResources()).map((resource) => resource.state)).toEqual(["destroyed"]);
  });

  test("run --push checks the local folder before creating anything", async () => {
    const result = await cli(["run", "--prepared", "fake-starter", "--push", "nope", "--", "true"]);

    expect(result.code).toBe(125);
    expect(await fakeResources()).toEqual([]);
  });
});

describe("snapshots", () => {
  beforeEach(async () => {
    await writeConfig({
      default: "snaps",
      profiles: {
        snaps: { module: fixture, export: "snapshotting" },
        fake: { module: fixture, export: "fake" },
      },
    });
    await writeFile(join(dir, "state.txt"), "warm cache\n");
  });

  async function snapshotNames() {
    try {
      return (await readdir(join(dir, "state", "snapshots"))).sort();
    } catch {
      return [];
    }
  }

  async function warmSandbox() {
    expect((await cli(["create", "--name", "web", "--prepared", "fake-starter"])).code).toBe(0);
    expect((await cli(["cp", "state.txt", "web:/work/state.txt"])).code).toBe(0);
  }

  test("capture, restore with create and run, list, replace and delete", async () => {
    await warmSandbox();

    const captured = await cli(["snapshot", "create", "web", "--name", "deps", "--json"]);

    expect(captured.code).toBe(0);
    expect(envelope(captured).data).toMatchObject({
      name: "deps",
      sandbox: "web",
      profile: "snaps",
      status: "captured",
      preserve: "filesystem",
      replaced: null,
      reference: { kind: "snapshot", ownership: "verified-created" },
    });
    const firstId = envelope(captured).data.id;

    expect(await snapshotNames()).toEqual(["deps.json"]);

    // The source keeps running; a restore is a new sandbox with the captured files.
    const restored = await cli(["create", "--snapshot", "deps", "--name", "web-2", "--json"]);

    expect(restored.code).toBe(0);
    expect(envelope(restored).data).toMatchObject({ name: "web-2", image: "snapshot:deps" });
    expect((await cli(["cat", "web-2:/work/state.txt"])).stdout).toBe("warm cache\n");

    await seedExec(["true"], 0, "");
    expect((await cli(["run", "--snapshot", "deps", "--", "true"])).code).toBe(0);

    const inspected = envelope(await cli(["snapshot", "inspect", "deps", "--json"]));

    expect(inspected.data).toMatchObject({ name: "deps", state: "ready", id: firstId });

    const listed = envelope(await cli(["snapshot", "ls", "--json"]));

    expect(listed.data.snapshots.map((row: { name: string }) => row.name)).toEqual(["deps"]);

    // A snapshot in use by a running restore stays on the provider when it is replaced.
    const busy = await cli(["snapshot", "create", "web", "--name", "deps", "--replace", "--json"]);

    expect(envelope(busy).data.replaced).toEqual({ id: firstId, result: "kept" });
    expect(busy.stderr).toContain(`the previous snapshot ${firstId} is still on snaps`);
    expect((await cli(["rm", "web-2"])).code).toBe(0);
    const busyId = envelope(busy).data.id;

    const taken = await cli(["snapshot", "create", "web", "--name", "deps", "--json"]);

    expect(taken.code).toBe(1);
    expect(envelope(taken).error).toMatchObject({ code: "CONFLICT", outcome: "rejected" });

    const replaced = await cli([
      "snapshot",
      "create",
      "web",
      "--name",
      "deps",
      "--replace",
      "--json",
    ]);

    expect(replaced.code).toBe(0);
    expect(envelope(replaced).data.replaced).toEqual({ id: busyId, result: "deleted" });

    const remote = envelope(await cli(["snapshot", "ls", "--remote", "--json"]));

    expect(remote.data.snapshots).toEqual([
      expect.objectContaining({ id: firstId, record: null }),
      expect.objectContaining({ id: envelope(replaced).data.id, record: "deps" }),
    ]);

    const removed = await cli(["snapshot", "rm", "deps", "--json"]);

    expect(removed.code).toBe(0);
    expect(envelope(removed).data).toMatchObject({ name: "deps", result: "deleted" });
    expect(await snapshotNames()).toEqual([]);
    expect(
      envelope(await cli(["snapshot", "ls", "--remote", "--json"])).data.snapshots.map(
        (row: { id: string }) => row.id,
      ),
    ).toEqual([firstId]);

    const gone = await cli(["create", "--snapshot", "deps", "--json"]);

    expect(envelope(gone).error.code).toBe("NOT_FOUND");
  });

  test("the default name comes from the sandbox, and forget keeps the provider's snapshot", async () => {
    await warmSandbox();

    expect((await cli(["snapshot", "create", "web"])).stdout).toBe("web-snap\n");
    expect((await cli(["snapshot", "create", "web"])).stdout).toMatch(/^web-snap-[0-9a-f]{4}\n$/);

    const forgotten = await cli(["snapshot", "forget", "web-snap"]);

    expect(forgotten.code).toBe(0);
    expect(forgotten.stdout).toContain("forget never deletes it");

    const remote = envelope(await cli(["snapshot", "ls", "--remote", "--json"]));

    expect(
      remote.data.snapshots.map((row: { record: string | null }) => row.record).sort(),
    ).toEqual([null, expect.stringMatching(/^web-snap-/)]);
  });

  test("a provider without snapshots rejects before any effect", async () => {
    await writeConfig({ default: "fake", profiles: { fake: { module: fixture, export: "fake" } } });
    await warmSandbox();

    const result = await cli(["snapshot", "create", "web", "--json"]);

    expect(result.code).toBe(4);
    expect(envelope(result).error).toMatchObject({ code: "UNSUPPORTED", outcome: "rejected" });
    expect(await snapshotNames()).toEqual([]);

    const remote = await cli(["snapshot", "ls", "--remote", "--json"]);

    expect(envelope(remote).error.code).toBe("UNSUPPORTED");
  });

  test("restore flags that cannot apply, and another profile, fail before any effect", async () => {
    await warmSandbox();
    await cli(["snapshot", "create", "web", "--name", "deps"]);

    for (const extra of [
      ["--image", "python:3.12"],
      ["--prepared", "fake-starter"],
    ]) {
      const result = await cli(["create", "--snapshot", "deps", ...extra, "--json"]);

      expect(result.code).toBe(2);
      expect(envelope(result).error.message).toContain(
        `--snapshot cannot be combined with ${extra[0]}`,
      );
    }

    const other = await cli(["create", "--snapshot", "deps", "--profile", "fake", "--json"]);

    expect(other.code).toBe(2);
    expect(envelope(other).error.message).toBe("Snapshot deps belongs to profile snaps, not fake");

    // For run, --env belongs to the command, so it stays allowed.
    await control("/_test/seed", {
      submissionId: "*",
      action: "exec",
      command: {
        command: { kind: "argv", argv: ["true"] },
        env: { A: "1" },
        exitCode: 0,
        stdoutBase64: "",
      },
    });
    expect((await cli(["run", "--snapshot", "deps", "--env", "A=1", "--", "true"])).code).toBe(0);
    expect((await fakeResources()).filter((box) => box.state === "running")).toHaveLength(1);
  });

  test("a restore takes --ttl, --label and --env like a create", async () => {
    await warmSandbox();
    await cli(["snapshot", "create", "web", "--name", "deps"]);

    const restored = await cli([
      "create",
      "--snapshot",
      "deps",
      "--name",
      "ci",
      "--ttl",
      "1h",
      "--label",
      "team=ci",
      "--env",
      "TOKEN=restore-secret",
    ]);

    expect(restored).toMatchObject({ code: 0, stdout: "ci\n" });
    expect((await fakeResources()).at(-1)).toMatchObject({
      lifetimeSeconds: 3600,
      labels: { team: "ci" },
      env: { TOKEN: "restore-secret" },
    });
    expect(await readFile(join(dir, "state", "sandboxes", "ci.json"), "utf8")).not.toContain(
      "restore-secret",
    );
  });
});
