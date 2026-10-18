import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    const scope = join(dir, "node_modules", "@sandbar-sdk");
    await mkdir(scope, { recursive: true });
    await symlink(join(import.meta.dir, "..", "..", "providers", "e2b"), join(scope, "e2b"));

    const installed = async (env: Record<string, string>) =>
      envelope(await cli(["providers", "--json"], env)).data.providers.find(
        (row: { id: string }) => row.id === "e2b",
      ).installed;

    expect(await installed({})).toBe(false);
    expect(await installed({ SANDBAR_PROJECT_ADAPTERS: "1" })).toBe(true);
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
});
