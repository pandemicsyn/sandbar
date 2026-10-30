import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Sandbar, type SandboxHandle, type SandboxReference } from "sandbar-sdk";
import { modelKey } from "../shared/opencode";
import { providerAdapter, reportFailure } from "../shared/provider";

export const OPENCODE2_VERSION = "2.2.3";

export const PORT = 4096;

// Installed outside the project so `pull` never copies it back.
export const OPENCODE2 = "$HOME/.sandbar-opencode-box/opencode2";

const LOG = "$HOME/.sandbar-opencode-box/serve.log";

const ARCHIVE = "/tmp/sandbar-opencode-box.tar.gz";

type Provider = "daytona" | "e2b";

export interface BoxRecord {
  name: string;
  provider: Provider;
  reference: SandboxReference;
  root: string;
  password: string;
  lifetimeSeconds: number;
}

type BoxCommands = Pick<SandboxHandle, "exec">;

function sh(script: string, ...args: string[]) {
  return { kind: "argv" as const, argv: ["/bin/sh", "-c", script, "opencode-box", ...args] };
}

// OpenCode 2 ships as per-platform npm tarballs; download one directly so the image needs
// no Node or npm. The digests are the SHA-256 of each registry tarball.
export async function installOpenCode2(box: BoxCommands, signal: AbortSignal) {
  await box.exec(
    {
      command: sh(
        `set -eu
[ "$(uname -s)" = Linux ] || { echo "OpenCode 2 needs a Linux sandbox" >&2; exit 1; }
case "$(uname -m)" in
  x86_64)
    target=linux-x64-baseline
    digest=6c4600333f617d59c10a41eb57ebe6f03b58fa0031c021af2bf2df14ff72ce1c
    ;;
  aarch64|arm64)
    target=linux-arm64
    digest=c83e14de3994ee4c4bf6826b48b6e774e51727e8629e2b60047a1c9d0e3278d6
    ;;
  *) echo "OpenCode 2 needs Linux x64 or arm64" >&2; exit 1 ;;
esac
dir="$HOME/.sandbar-opencode-box"
mkdir -p "$dir"
archive="$dir/cli.tgz"
trap 'rm -f "$archive"' 0
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 300 \\
  --output "$archive" "https://registry.npmjs.org/@opencode/cli-$target/-/cli-$target-$1.tgz"
printf '%s  %s\\n' "$digest" "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$dir" --strip-components=2 package/bin/opencode
mv "$dir/opencode" "$dir/opencode2"
"$dir/opencode2" --version`,
        OPENCODE2_VERSION,
      ),
      deadlineSeconds: 360,
      maxOutputBytes: 16_384,
    },
    { signal },
  );
}

/** Files `up` sends and `pull` returns: tracked and untracked-but-not-ignored files, plus `.git`. */
export async function projectFiles(root: string) {
  const listed = await output(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
  );

  const files = listed.split("\0").filter((file) => file && existsSync(join(root, file)));

  return [...new Set(files), ".git"];
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();

  while (true) {
    const next = await reader.read();

    if (next.done) return;

    yield next.value;
  }
}

async function output(argv: string[], cwd: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}`);

  return text;
}

// The project lands at the same absolute path, so the local OpenCode client's directory
// matches the server's.
export async function uploadProject(
  box: Pick<SandboxHandle, "exec" | "writeFileStream">,
  root: string,
  files: string[],
  signal: AbortSignal,
) {
  const tar = Bun.spawn(["tar", "-czf", "-", "--null", "-T", "-"], {
    cwd: root,
    stdin: new TextEncoder().encode(files.map((file) => `${file}\0`).join("")),
    stdout: "pipe",
    stderr: "inherit",
  });

  await box.writeFileStream(ARCHIVE, chunks(tar.stdout), { signal, overwrite: true });

  if ((await tar.exited) !== 0) throw new Error("Packing the project failed");

  await box.exec(
    {
      command: sh(
        `set -eu
mkdir -p "$1" 2>/dev/null || { sudo mkdir -p "$1" && sudo chown "$(id -u):$(id -g)" "$1"; }
tar -xzf "$2" -C "$1"
rm -f "$2"`,
        root,
        ARCHIVE,
      ),
      deadlineSeconds: 120,
      maxOutputBytes: 16_384,
    },
    { signal },
  );
}

/**
 * Commit as the local git identity. With GH_TOKEN in the sandbox environment, git pushes to
 * GitHub over HTTPS with that token, and `gh` (when the image has it) uses it too.
 */
export async function configureGit(
  box: BoxCommands,
  name: string,
  email: string,
  signal: AbortSignal,
) {
  await box.exec(
    {
      command: sh(
        `set -eu
[ -z "$1" ] || git config --global user.name "$1"
[ -z "$2" ] || git config --global user.email "$2"
if [ -n "\${GH_TOKEN:-}" ]; then
  git config --global credential.https://github.com.helper \\
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
  command -v gh >/dev/null || echo "gh is not in this image; git push works, gh pr create does not" >&2
fi`,
        name,
        email,
      ),
      deadlineSeconds: 30,
      maxOutputBytes: 16_384,
    },
    { signal },
  );
}

// Detached from the exec so the server outlives this command and the local process.
export async function startServer(
  box: BoxCommands,
  root: string,
  env: Record<string, string>,
  signal: AbortSignal,
) {
  await box.exec(
    {
      command: sh(
        `cd "$1" && (setsid nohup ${OPENCODE2} serve --hostname 0.0.0.0 --port ${PORT} \\
  >${LOG} 2>&1 </dev/null &)`,
        root,
      ),
      env,
      deadlineSeconds: 30,
      maxOutputBytes: 16_384,
    },
    { signal },
  );
}

export function basicAuth(password: string) {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

export async function waitHealthy(
  url: string,
  headers: Record<string, string>,
  password: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const ready = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);

  while (true) {
    ready.throwIfAborted();

    try {
      const response = await request(new URL("/global/health", url), {
        headers: { ...headers, authorization: basicAuth(password) },
        redirect: "error",
        signal: ready,
      });

      await response.body?.cancel();

      if (response.ok) return;
    } catch (error) {
      if (ready.aborted) throw error;
    }

    await new Promise<void>((done) => setTimeout(done, 1000));
  }
}

/**
 * A localhost proxy in front of the preview URL. It adds the provider's preview headers
 * (Daytona's preview token), which the OpenCode client cannot send itself, and never follows
 * redirects, so those headers cannot leak to another host.
 */
// SAFETY: Bun's WebSocket client constructor accepts { headers }; the DOM type omits it. Headers
// carry the preview token and the OpenCode password upstream.
const HeaderWebSocket = WebSocket as typeof WebSocket &
  (new (url: string, options: Bun.WebSocketOptions) => WebSocket);

export function previewProxy(target: string, headers: Record<string, string>) {
  const upstream = new URL(target);
  const sockets = new WeakMap<object, { remote: WebSocket; pending: (string | Buffer)[] }>();

  return Bun.serve<{ url: string; authorization: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const incoming = new URL(request.url);
      const url = new URL(incoming.pathname + incoming.search, upstream);

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const authorization = request.headers.get("authorization");

        return server.upgrade(request, { data: { url: url.href, authorization } })
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }

      const forwarded = new Headers(request.headers);
      forwarded.delete("host");

      for (const [key, value] of Object.entries(headers)) forwarded.set(key, value);

      return fetch(url, {
        method: request.method,
        headers: forwarded,
        body: request.body,
        redirect: "error",
      }).catch(() => new Response("Box unreachable or redirected", { status: 502 }));
    },
    websocket: {
      open(socket) {
        const upgrade = Object.entries(headers);

        if (socket.data.authorization) upgrade.push(["authorization", socket.data.authorization]);

        const remote = new HeaderWebSocket(socket.data.url, {
          headers: Object.fromEntries(upgrade),
        });

        const pending: (string | Buffer)[] = [];
        const link = { remote, pending };
        remote.binaryType = "arraybuffer";

        remote.addEventListener("open", () => {
          for (const message of link.pending.splice(0)) remote.send(message);
        });

        remote.addEventListener("message", (event) => socket.send(event.data));
        remote.addEventListener("close", () => socket.close());
        remote.addEventListener("error", () => socket.close());
        sockets.set(socket, link);
      },
      message(socket, message) {
        const link = sockets.get(socket);

        if (link?.remote.readyState === WebSocket.OPEN) link.remote.send(message);
        else link?.pending.push(message);
      },
      close(socket) {
        sockets.get(socket)?.remote.close();
      },
    },
  });
}

/** Copy the box's project back over the local checkout, `.git` included. */
export async function pullProject(
  box: Pick<SandboxHandle, "exec" | "readFileStream">,
  root: string,
  signal: AbortSignal,
) {
  await box.exec(
    {
      command: sh(
        `set -eu
cd "$1"
{ git ls-files -z --cached --others --exclude-standard; printf '.git\\0'; } |
  tar -czf "$2" --null --ignore-failed-read -T -`,
        root,
        ARCHIVE,
      ),
      deadlineSeconds: 120,
      maxOutputBytes: 16_384,
    },
    { signal },
  );

  const tar = Bun.spawn(["tar", "-xzf", "-"], { cwd: root, stdin: "pipe", stderr: "inherit" });

  for await (const chunk of box.readFileStream(ARCHIVE, { signal })) await tar.stdin.write(chunk);

  await tar.stdin.end();

  if ((await tar.exited) !== 0) throw new Error("Unpacking the project failed");

  await box.exec(["rm", "-f", ARCHIVE], { signal });
}

function stateDir() {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "sandbar-opencode-box",
  );
}

async function saveRecord(record: BoxRecord) {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  const path = join(stateDir(), `${record.name}.json`);
  await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function loadRecord(name: string): Promise<BoxRecord> {
  const path = join(stateDir(), `${name}.json`);

  if (!existsSync(path)) throw new Error(`No box named ${name}; run up first`);

  // SAFETY: this file is written only by saveRecord, in a directory only the user can read.
  return JSON.parse(await readFile(path, "utf8")) as BoxRecord;
}

// Create-time environment: every command in the box, the agent's included, can read it.
function boxEnv() {
  const entries: [string, string][] = [];
  const key = modelKey();
  const token = process.env.GH_TOKEN?.trim();

  if (key) entries.push([key.name, key.value]);

  if (token) entries.push(["GH_TOKEN", token]);

  return Object.fromEntries(entries);
}

export function serverEnv(password: string, model = process.env.OPENCODE_MODEL?.trim()) {
  const entries: [string, string][] = [["OPENCODE_SERVER_PASSWORD", password]];

  if (model) entries.push(["OPENCODE_CONFIG_CONTENT", JSON.stringify({ model })]);

  return Object.fromEntries(entries);
}

function flag(args: string[], name: string) {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
}

const USAGE = `Usage:
  box up --provider daytona|e2b --project <dir> [--name <name>] [--hours <n>]
  box attach [--name <name>]
  box pull [--name <name>] [--force]
  box down [--name <name>]`;

async function connect(record: BoxRecord) {
  // Reopen with the setup the box was created with.
  const client = await Sandbar.connect(providerAdapter(record.provider, record.lifetimeSeconds));

  return { client, box: await client.sandboxes.get(record.reference) };
}

async function up(args: string[], name: string, signal: AbortSignal) {
  const provider = flag(args, "--provider");
  const project = flag(args, "--project");

  if (provider !== "daytona" && provider !== "e2b") throw new Error(USAGE);

  if (!project) throw new Error(USAGE);

  const root = (await output(["git", "rev-parse", "--show-toplevel"], resolve(project))).trim();
  const hours = Number(flag(args, "--hours") ?? "1");

  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error("--hours must be 0-24");

  if (existsSync(join(stateDir(), `${name}.json`))) throw new Error(`Box ${name} already exists`);

  const env = boxEnv();
  const files = await projectFiles(root);
  const password = randomBytes(24).toString("base64url");
  const lifetimeSeconds = Math.ceil(hours * 3600);
  const client = await Sandbar.connect(providerAdapter(provider, lifetimeSeconds));

  try {
    const box = await client.sandboxes.create(
      { env, labels: { "sandbar-example": "opencode-box", "opencode-box": name } },
      { signal },
    );

    try {
      const reference = box.reference ?? (await box.inspect({ signal })).reference;

      if (!reference) throw new Error("The provider did not confirm the sandbox identity");

      console.error(`Created sandbox ${box.id}; installing OpenCode ${OPENCODE2_VERSION}`);
      await installOpenCode2(box, signal);
      console.error(`Uploading ${files.length} paths from ${root}`);
      await uploadProject(box, root, files, signal);

      await configureGit(
        box,
        (await output(["git", "config", "user.name"], root).catch(() => "")).trim(),
        (await output(["git", "config", "user.email"], root).catch(() => "")).trim(),
        signal,
      );

      await startServer(box, root, serverEnv(password), signal);
      const preview = await box.preview(PORT, { signal });
      const headers = preview.access === "protected" ? preview.headers : {};
      await waitHealthy(preview.url, headers, password, signal);
      await saveRecord({ name, provider, reference, root, password, lifetimeSeconds });
      console.error(`Box ${name} is up. Next: bun run --cwd examples box attach --name ${name}`);
    } catch (error) {
      // A box that never came up should not keep billing.
      await box.destroy({ signal: AbortSignal.timeout(30_000) }).catch((cleanup) => {
        console.error(`Cleanup uncertain for sandbox ${box.id}:`, cleanup);
      });
      throw error;
    }
  } finally {
    await client.close();
  }
}

async function attach(record: BoxRecord, signal: AbortSignal) {
  const { client, box } = await connect(record);

  try {
    const preview = await box.preview(PORT, { signal });
    const proxy = previewProxy(preview.url, preview.access === "protected" ? preview.headers : {});

    try {
      if (!Bun.which("opencode2"))
        throw new Error("Install the OpenCode 2 client: npm install -g @opencode/cli");

      const opencode = Bun.spawn(["opencode2", "--server", `http://127.0.0.1:${proxy.port}`], {
        cwd: record.root,
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: record.password },
        stdio: ["inherit", "inherit", "inherit"],
      });

      process.exitCode = await opencode.exited;
    } finally {
      await proxy.stop(true);
    }
  } finally {
    await client.close();
  }
}

async function pull(record: BoxRecord, force: boolean, signal: AbortSignal) {
  const changes = await output(["git", "status", "--porcelain"], record.root);

  if (changes && !force)
    throw new Error(`${record.root} has local changes that pull would overwrite; pass --force`);

  const { client, box } = await connect(record);

  try {
    await pullProject(box, record.root, signal);
    console.error(`Copied box ${record.name} back to ${record.root}`);
  } finally {
    await client.close();
  }
}

async function down(record: BoxRecord, signal: AbortSignal) {
  const { client, box } = await connect(record);

  try {
    await box.destroy({ signal });
    await rm(join(stateDir(), `${record.name}.json`));
    console.error(`Destroyed box ${record.name}`);
  } finally {
    await client.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const name = flag(args, "--name") ?? "default";

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("--name may use letters, digits, - and _");

  const signal = AbortSignal.timeout(900_000);

  switch (args[0]) {
    case "up":
      return up(args, name, signal);
    case "attach":
      // The session is interactive; it has no overall deadline.
      return attach(await loadRecord(name), new AbortController().signal);
    case "pull":
      return pull(await loadRecord(name), args.includes("--force"), signal);
    case "down":
      return down(await loadRecord(name), signal);
    default:
      throw new Error(USAGE);
  }
}

if (import.meta.main) await main().catch(reportFailure);
