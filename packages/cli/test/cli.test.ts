import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@sandbar-sdk/adapter";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";

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

type FakeResource = { ref: { nativeId: string }; state: "running" | "destroyed" };

async function fakeResources(): Promise<FakeResource[]> {
  const response = await fetch(new URL("/_test/state", server.url), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return (await response.json()).resources;
}

async function seedExec(argv: string[], exitCode: number, stdout: string, stderr = "") {
  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    command: {
      command: { kind: "argv", argv },
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
): Promise<Result> {
  const child = Bun.spawn(["bun", main, ...args], {
    cwd: dir,
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

  test("doctor connects without creating", async () => {
    const result = envelope(await cli(["doctor", "--json"]));

    expect(result.data).toMatchObject({ profile: "fake", provider: "fake", connected: true });
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

    const help = await cli(["exec", "--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: sandbar exec");
    expect((await cli(["--help"])).stdout).toContain("Quick start");
  });

  test("providers finds adapters installed in ~/.config/sandbar/adapters", async () => {
    const before = envelope(await cli(["providers", "--json"]));

    expect(before.data.providers.find((row: { id: string }) => row.id === "e2b")).toMatchObject({
      installed: false,
      missingEnv: ["E2B_API_KEY"],
    });

    const scope = join(dir, ".config", "sandbar", "adapters", "node_modules", "@sandbar-sdk");
    await mkdir(scope, { recursive: true });
    await symlink(join(import.meta.dir, "..", "..", "providers", "e2b"), join(scope, "e2b"));

    const after = envelope(await cli(["providers", "--json"], { E2B_API_KEY: "test-key" }));

    expect(after.data.providers.find((row: { id: string }) => row.id === "e2b")).toMatchObject({
      installed: true,
      missingEnv: [],
    });
  });

  test("SANDBAR_JSON=1 switches every command to JSON", async () => {
    const result = await cli(["ls"], { SANDBAR_JSON: "1" });

    expect(envelope(result)).toEqual({ ok: true, data: { sandboxes: [] } });
  });
});
