import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type FakeControlRequest = {
  submissionId?: string;
  action?: string;
  behavior?: string;
  command?: {
    command: { kind: "argv"; argv: string[] };
    exitCode: number;
    stdoutBase64?: string;
    stderrBase64?: string;
  };
  nativeIdempotency?: { create: boolean; exec: boolean; destroy: boolean; writeFile: boolean };
  discoveryBySubmission?: boolean;
  delayObservations?: number;
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
  const address = server.address();

  if (!(address instanceof Object)) throw new Error("Unable to allocate a test port");
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));

  return address.port;
}

async function waitReady(url: string, token?: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: Error | undefined;

  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`Process exited before ${url} became ready`);

    try {
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (response.ok) return;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise((done) => setTimeout(done, 50));
  }

  throw new Error(`Timed out waiting for ${url}: ${String(last)}`);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((done) => child.once("exit", () => done(true)));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), 3_000);
  });
  const graceful = await Promise.race([exited, timedOut]);
  clearTimeout(timer!);

  if (graceful) return;
  child.kill("SIGKILL");
  await exited;
}

export class ProcessFixture {
  readonly fakeToken = `fake-${crypto.randomUUID()}`;
  readonly setupToken = `setup-${crypto.randomUUID()}`;
  private directory?: string;
  private fake?: ChildProcess;
  private service?: ChildProcess;
  fakeUrl?: string;
  serviceUrl?: string;

  async startFake(): Promise<void> {
    if (this.fake) throw new Error("Fake provider is already running");
    this.directory ??= await mkdtemp(join(tmpdir(), "sandbar-sdk-qualification-"));
    const port = await freePort();
    this.fakeUrl = `http://127.0.0.1:${port}`;
    this.fake = spawn("bun", ["packages/providers/fake/src/cli.ts"], {
      cwd: root,
      env: {
        ...process.env,
        SANDBAR_ENABLE_FAKE_PROVIDER: "1",
        SANDBAR_FAKE_TEST_MODE: "1",
        SANDBAR_FAKE_STATE_PATH: join(this.directory, "fake.json"),
        SANDBAR_FAKE_TOKEN: this.fakeToken,
        SANDBAR_FAKE_PORT: String(port),
      },
      stdio: "inherit",
    });

    try {
      await waitReady(`${this.fakeUrl}/_test/state`, this.fakeToken, this.fake);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async startService(): Promise<void> {
    if (!this.directory || !this.fakeUrl || this.service)
      throw new Error("Start fake provider before Sandbar service");
    const keyFile = join(this.directory, "key");
    const setupTokenFile = join(this.directory, "setup-token");
    await writeFile(keyFile, crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600 });
    await writeFile(setupTokenFile, this.setupToken, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await chmod(setupTokenFile, 0o600);
    const port = await freePort();
    this.serviceUrl = `http://127.0.0.1:${port}`;
    this.service = spawn("bun", ["apps/server/src/index.ts"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        SANDBAR_DB_URL: join(this.directory, "control.sqlite"),
        SANDBAR_KEY_FILE: keyFile,
        SANDBAR_SETUP_TOKEN_FILE: setupTokenFile,
        SANDBAR_FAKE_PROVIDER_URL: this.fakeUrl,
        SANDBAR_FAKE_PROVIDER_TOKEN: this.fakeToken,
      },
      stdio: "inherit",
    });

    try {
      await waitReady(`${this.serviceUrl}/healthz`, undefined, this.service);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async fakeControl(path: string, body?: FakeControlRequest): Promise<any> {
    if (!this.fakeUrl) throw new Error("Fake provider is not running");

    const headers = new Headers({ Authorization: `Bearer ${this.fakeToken}` });

    if (body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(`${this.fakeUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Fake control ${path}: HTTP ${response.status}`);

    return response.json();
  }

  async close(): Promise<void> {
    try {
      await stop(this.service);
      await stop(this.fake);
    } finally {
      this.service = undefined;
      this.fake = undefined;

      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
      this.fakeUrl = undefined;
      this.serviceUrl = undefined;
    }
  }
}
