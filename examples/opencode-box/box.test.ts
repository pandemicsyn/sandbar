import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExecInput, type ExecOutput } from "sandbar-sdk";
import {
  basicAuth,
  configureGit,
  installOpenCode2,
  OPENCODE2_VERSION,
  previewProxy,
  projectFiles,
  pullProject,
  serverEnv,
  startServer,
  uploadProject,
  waitHealthy,
} from "./main";

const signal = new AbortController().signal;

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-box-"));
  temps.push(dir);

  return dir;
}

function done(): ExecOutput {
  return {
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
    stdoutText: () => "",
    stderrText: () => "",
    stdoutPreview: () => ({ text: "", shortened: false }),
    stderrPreview: () => ({ text: "", shortened: false }),
  };
}

function argv(input: ExecInput | readonly string[]) {
  return Array.isArray(input)
    ? input
    : "command" in input && input.command.kind === "argv"
      ? input.command.argv
      : [];
}

async function run(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();

  expect(await child.exited).toBe(0);

  return text;
}

async function repo() {
  const root = await temp();
  await run(["git", "init", "-q"], root);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  await writeFile(join(root, "gone.txt"), "gone\n");
  await run(["git", "add", "."], root);
  await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], root);
  await rm(join(root, "gone.txt"));
  await writeFile(join(root, "untracked.txt"), "new\n");
  await Bun.write(join(root, "node_modules/dep/index.js"), "ignored\n");

  return root;
}

test("install pins the OpenCode 2 registry tarball and checks its digest", async () => {
  const calls: (ExecInput | readonly string[])[] = [];

  await installOpenCode2(
    {
      async exec(input) {
        calls.push(input);

        return done();
      },
    },
    signal,
  );

  const [script, , version] = argv(calls[0]!).slice(2);
  expect(version).toBe(OPENCODE2_VERSION);
  expect(script).toContain("registry.npmjs.org/@opencode/cli-$target/-/cli-$target-$1.tgz");
  expect(script).toContain("sha256sum --check");
  expect(calls[0]).toMatchObject({ deadlineSeconds: 360, maxOutputBytes: 16_384 });
});

test("project files are tracked and unignored files plus .git, skipping deleted files", async () => {
  const root = await repo();
  const files = await projectFiles(root);

  expect(files.sort()).toEqual([".git", ".gitignore", "tracked.txt", "untracked.txt"]);
});

test("upload streams a tarball of the project and unpacks it at the same path", async () => {
  const root = await repo();
  const out = await temp();
  const chunks: Uint8Array[] = [];
  const calls: (ExecInput | readonly string[])[] = [];

  await uploadProject(
    {
      async writeFileStream(_path, bytes) {
        for await (const chunk of bytes) chunks.push(chunk);

        return chunks.reduce((total, chunk) => total + chunk.length, 0);
      },
      async exec(input) {
        calls.push(input);

        return done();
      },
    },
    root,
    await projectFiles(root),
    signal,
  );

  await Bun.write(join(out, "a.tgz"), Buffer.concat(chunks));
  await run(["tar", "-xzf", "a.tgz"], out);

  expect(await readFile(join(out, "untracked.txt"), "utf8")).toBe("new\n");
  expect(existsSync(join(out, ".git", "HEAD"))).toBe(true);
  expect(existsSync(join(out, "node_modules"))).toBe(false);
  expect(argv(calls[0]!).slice(-2)[0]).toBe(root);
});

test("pull unpacks the box's archive over the local checkout", async () => {
  const remote = await repo();
  await writeFile(join(remote, "tracked.txt"), "changed by the agent\n");
  await run(["tar", "-czf", "../box.tgz", "tracked.txt", ".git"], remote);

  const archive = new Uint8Array(await Bun.file(join(remote, "../box.tgz")).arrayBuffer());
  temps.push(join(remote, "../box.tgz"));

  const local = await repo();
  const calls: (ExecInput | readonly string[])[] = [];

  await pullProject(
    {
      async exec(input) {
        calls.push(input);

        return done();
      },
      async *readFileStream() {
        yield archive.subarray(0, 10);
        yield archive.subarray(10);
      },
    },
    local,
    signal,
  );

  expect(await readFile(join(local, "tracked.txt"), "utf8")).toBe("changed by the agent\n");
  expect(argv(calls[0]!)).toContain(local);
  expect(argv(calls[1]!)).toEqual(["rm", "-f", "/tmp/sandbar-opencode-box.tar.gz"]);
});

test("git setup passes the local identity as arguments, never in the script", async () => {
  const calls: (ExecInput | readonly string[])[] = [];

  await configureGit(
    {
      async exec(input) {
        calls.push(input);

        return done();
      },
    },
    "Ada; rm -rf /",
    "ada@example.com",
    signal,
  );

  const args = argv(calls[0]!);
  expect(args.slice(-2)).toEqual(["Ada; rm -rf /", "ada@example.com"]);
  expect(args[2]).not.toContain("Ada");
  expect(args[2]).toContain("credential.https://github.com.helper");
});

test("the server starts detached in the project with the password in its environment", async () => {
  const calls: (ExecInput | readonly string[])[] = [];

  await startServer(
    {
      async exec(input) {
        calls.push(input);

        return done();
      },
    },
    "/work/app",
    serverEnv("secret", "anthropic/model"),
    signal,
  );

  expect(argv(calls[0]!)[2]).toContain("setsid nohup");
  expect(argv(calls[0]!).at(-1)).toBe("/work/app");
  expect(calls[0]).toMatchObject({
    env: {
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/model" }),
    },
  });
  expect(serverEnv("secret", "")).toEqual({ OPENCODE_SERVER_PASSWORD: "secret" });
});

test("health checks send preview headers and basic auth and refuse redirects", async () => {
  const seen: RequestInit[] = [];
  let attempts = 0;

  await waitHealthy(
    "https://box.example/",
    { "x-preview-token": "t" },
    "pw",
    signal,
    // SAFETY: the test double implements the fetch call signature waitHealthy uses.
    (async (url: URL, init: RequestInit) => {
      seen.push(init);
      expect(String(url)).toBe("https://box.example/global/health");
      attempts += 1;

      if (attempts === 1) throw new Error("not listening yet");

      return new Response("{}");
    }) as typeof fetch,
  );

  expect(attempts).toBe(2);
  expect(seen[1]).toMatchObject({
    redirect: "error",
    headers: { "x-preview-token": "t", authorization: basicAuth("pw") },
  });
});

test("the preview proxy adds preview headers to HTTP and WebSocket traffic", async () => {
  const upstream = Bun.serve<{ token: string | null; auth: string | null }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      const token = request.headers.get("x-preview-token");
      const auth = request.headers.get("authorization");

      if (url.pathname === "/socket")
        return server.upgrade(request, { data: { token, auth } })
          ? undefined
          : new Response("no", { status: 400 });

      if (url.pathname === "/redirect") return Response.redirect("https://elsewhere.example/", 302);

      return Response.json({ path: url.pathname + url.search, token, auth });
    },
    websocket: {
      open(socket) {
        socket.send(`${socket.data.token}|${socket.data.auth}`);
      },
      message(socket, message) {
        socket.send(`echo:${message}`);
      },
    },
  });

  const proxy = previewProxy(`http://127.0.0.1:${upstream.port}`, { "x-preview-token": "t" });

  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/session?x=1`, {
      headers: { authorization: "Basic abc" },
    });

    expect(await response.json()).toEqual({ path: "/session?x=1", token: "t", auth: "Basic abc" });

    const redirected = await fetch(`http://127.0.0.1:${proxy.port}/redirect`, {
      redirect: "manual",
    });

    expect(redirected.status).toBe(502);

    // SAFETY: Bun's WebSocket client accepts { headers }; the DOM type omits it.
    const Socket = WebSocket as typeof WebSocket &
      (new (url: string, options: Bun.WebSocketOptions) => WebSocket);

    const socket = new Socket(`ws://127.0.0.1:${proxy.port}/socket`, {
      headers: { authorization: "Basic abc" },
    });

    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", () => reject(new Error("socket failed")));
      socket.addEventListener("message", (event) => {
        messages.push(String(event.data));

        if (messages.length === 1) socket.send("hi");
        else resolve();
      });
    });

    socket.close();
    expect(messages).toEqual(["t|Basic abc", "echo:hi"]);
  } finally {
    await proxy.stop(true);
    await upstream.stop(true);
  }
});
