import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

const root = resolve(import.meta.dir, "../../..");
const fakeToken = "fake-test-token-only-123456789";
const setupToken = "setup-test-token-only-123456789";
type Process = ReturnType<typeof Bun.spawn>;
let temp: string;
let fake: Process;
let server: Process;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let fakeUrl: string;
let serviceUrl: string;
let fakePort: number;
let servicePort: number;

async function freePort(): Promise<number> {
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = listener.port;
  listener.stop(true);
  if (!port) throw new Error("Failed to reserve a local port");
  return port;
}

async function waitFor<T>(
  label: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const result = await attempt();
      if (result !== undefined) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`,
  );
}

async function stop(child?: Process): Promise<void> {
  if (!child) return;
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    child.exited,
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
}

function launchFake(): Process {
  return Bun.spawn(["bun", "packages/providers/fake/src/server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      SANDBAR_ENABLE_FAKE_PROVIDER: "1",
      SANDBAR_FAKE_TEST_MODE: "1",
      SANDBAR_FAKE_STATE_PATH: join(temp, "fake.json"),
      SANDBAR_FAKE_TOKEN: fakeToken,
      SANDBAR_FAKE_PORT: String(fakePort),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

function launchService(): Process {
  return Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(servicePort),
      SANDBAR_DB_URL: join(temp, "control.sqlite"),
      SANDBAR_KEY_FILE: join(temp, "key"),
      SANDBAR_SETUP_TOKEN_FILE: join(temp, "setup-token"),
      SANDBAR_FAKE_PROVIDER_URL: fakeUrl,
      SANDBAR_FAKE_PROVIDER_TOKEN: fakeToken,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function ready(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  await waitFor(url, async () => {
    const response = await fetch(url, { headers });
    return response.ok ? true : undefined;
  });
}

async function control(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<any> {
  const response = await fetch(`${fakeUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${fakeToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      `Fake control ${path}: ${response.status} ${await response.text()}`,
    );
  return response.json();
}

async function seed(
  action: "create" | "exec" | "destroy",
  behavior: "normal" | "lost_after_effect",
  command?: { exitCode: number; stdoutBase64: string; stderrBase64: string },
) {
  await control("POST", "/_test/seed", {
    submissionId: "*",
    action,
    behavior,
    ...(command
      ? {
          command: {
            command: { kind: "shell", script: "echo hello" },
            ...command,
          },
        }
      : {}),
  });
}

async function operation(projectId: string, operationId: string): Promise<any> {
  const response = await context.request.get(
    `${serviceUrl}/v1/projects/${projectId}/operations/${operationId}`,
  );
  if (!response.ok())
    throw new Error(`Operation fetch failed ${response.status()}`);
  return response.json();
}

async function waitForOperation(
  projectId: string,
  operationId: string,
  status: string,
) {
  return waitFor(
    `operation ${operationId} ${status}`,
    async () => {
      const result = await operation(projectId, operationId);
      if (result.status === "failed")
        throw new Error(`Operation failed: ${JSON.stringify(result.error)}`);
      return result.status === status ? result : undefined;
    },
    20_000,
  );
}

async function waitForEffect(action: string, count: number): Promise<void> {
  await waitFor(`${count} ${action} effects`, async () => {
    const state = await control("GET", "/_test/state");
    return state.ledger.filter(
      (entry: { action: string }) => entry.action === action,
    ).length >= count
      ? true
      : undefined;
  });
}

beforeAll(async () => {
  const build = Bun.spawnSync(
    ["bun", "run", "--filter", "@sandbar/web", "build"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) throw new Error("Web build failed before E2E");
  temp = await mkdtemp(join(tmpdir(), "sandbar-e2e-"));
  await writeFile(
    join(temp, "key"),
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    { mode: 0o600 },
  );
  await writeFile(join(temp, "setup-token"), setupToken, { mode: 0o600 });
  await chmod(join(temp, "key"), 0o600);
  await chmod(join(temp, "setup-token"), 0o600);
  fakePort = await freePort();
  servicePort = await freePort();
  fakeUrl = `http://127.0.0.1:${fakePort}`;
  serviceUrl = `http://127.0.0.1:${servicePort}`;
  fake = launchFake();
  await ready(`${fakeUrl}/_test/state`, {
    Authorization: `Bearer ${fakeToken}`,
  });
  server = launchService();
  await ready(`${serviceUrl}/healthz`);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
});

afterAll(async () => {
  try {
    await context?.close();
  } catch {
    /* Continue process cleanup. */
  }
  try {
    await browser?.close();
  } catch {
    /* Continue process cleanup. */
  }
  await Promise.allSettled([stop(server), stop(fake)]);
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("browser and public HTTP recover fake effects across service restarts without duplicate dispatch", async () => {
  await page.goto(serviceUrl);
  await page
    .getByRole("button", { name: "First time? Set up an operator" })
    .click();
  await page.getByLabel("Setup secret").fill(setupToken);
  await page.getByLabel("Setup secret").press("Enter");
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.locator(".skip-link").focus();
  await page.locator(".skip-link").press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "main-content",
  );
  const operatorToken = (await page
    .locator(".one-time-token code")
    .textContent())!;
  await page.getByRole("heading", { name: "No projects yet" }).waitFor();
  expect(await page.getByText("Save your API token now.").isVisible()).toBe(
    true,
  );
  const deniedWithoutCsrf = await context.request.post(
    `${serviceUrl}/v1/projects`,
    { data: { name: "denied" } },
  );
  expect(deniedWithoutCsrf.status()).toBe(403);
  await page.getByRole("button", { name: "I saved it" }).click();
  await page.getByLabel("Project name").fill("E2E project");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("heading", { name: "Provider connections" }).waitFor();
  await page.locator(".skip-link").focus();
  await page.locator(".skip-link").press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "main-content",
  );
  const projectId = new URL(page.url()).pathname.split("/")[2]!;
  const connectionsUrl = page.url();
  await page.goto(`${serviceUrl}/projects/missing-project/connections`);
  await page
    .getByText("This project is unavailable or you do not have access.")
    .waitFor();
  await page.locator(".skip-link").focus();
  await page.locator(".skip-link").press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "main-content",
  );
  await page.goto(`${serviceUrl}/unmatched-route`);
  await page.getByRole("heading", { name: "Page not found" }).waitFor();
  await page.locator(".skip-link").focus();
  await page.locator(".skip-link").press("Enter");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(
    "main-content",
  );
  await page.goto(connectionsUrl);
  await page.getByRole("heading", { name: "Provider connections" }).waitFor();
  await page.getByLabel("Connection name").fill("Fake local");
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByRole("button", { name: "Verify scope" }).click();
  await page.getByText("Connection scope verified.").waitFor();
  await page.getByRole("link", { name: "Fleet" }).click();
  await page.getByRole("heading", { name: "Fleet" }).waitFor();
  await page.getByLabel("Label key (optional)").fill("team");
  await page.getByLabel("Label value").fill("e2e");

  let firstCreateOperationId: string | undefined;
  let dropFirstCreateResponse = true;
  await page.route("**/v1/projects/*/sandboxes", async (route) => {
    if (route.request().method() !== "POST" || !dropFirstCreateResponse) {
      await route.continue();
      return;
    }
    dropFirstCreateResponse = false;
    const accepted = await route.fetch();
    firstCreateOperationId = (await accepted.json()).operation.id;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await page
    .getByText("Retry the same inputs to recover this request.")
    .waitFor();
  await waitForEffect("create", 1);
  await page.getByLabel("Label value").fill("changed");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await page
    .getByText("An earlier request may have been accepted.", { exact: false })
    .waitFor();
  expect(
    (await control("GET", "/_test/state")).ledger.filter(
      (entry: { action: string }) => entry.action === "create",
    ),
  ).toHaveLength(1);
  await page.reload();
  await page
    .getByText("Retry the same inputs to recover this request.")
    .waitFor();
  await page.getByRole("link", { name: "Connections" }).click();
  await page.getByRole("link", { name: "Fleet" }).click();
  await page.getByLabel("Label key (optional)").fill("team");
  await page.getByLabel("Label value").fill("e2e");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await page.waitForURL(/\/operations\//);
  const createId = new URL(page.url()).pathname.split("/").at(-1)!;
  expect(createId).toBe(firstCreateOperationId!);
  const created = await waitForOperation(projectId, createId, "succeeded");
  const sandboxId = created.sandboxId as string;
  expect(sandboxId).toMatch(/^sb_/);
  await page.getByRole("link", { name: "Fleet" }).click();
  await page.getByLabel("Label key (optional)").fill("team");
  await page.getByLabel("Label value").fill("concurrent");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await page
    .getByText(
      "The previous request was accepted. Start a new attempt before submitting changed inputs.",
    )
    .waitFor();
  expect(
    (await control("GET", "/_test/state")).ledger.filter(
      (entry: { action: string }) => entry.action === "create",
    ),
  ).toHaveLength(1);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Start new create attempt" }).click();

  const secondTab = await context.newPage();
  await secondTab.goto(page.url());
  for (const tab of [page, secondTab]) {
    await tab.getByLabel("Label key (optional)").fill("team");
    await tab.getByLabel("Label value").fill("concurrent");
  }
  let releaseHeldResponse!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    releaseHeldResponse = resolve;
  });
  let concurrentOperationId: string | undefined;
  let holdConcurrentResponse = true;
  await page.route("**/v1/projects/*/sandboxes", async (route) => {
    if (route.request().method() !== "POST" || !holdConcurrentResponse) {
      await route.continue();
      return;
    }
    holdConcurrentResponse = false;
    const accepted = await route.fetch();
    const body = await accepted.json();
    if (!body.operation)
      throw new Error(
        `Concurrent admission ${accepted.status()}: ${JSON.stringify(body)}`,
      );
    concurrentOperationId = body.operation.id;
    await heldResponse;
    await route.abort("failed");
  });
  const firstConcurrentClick = page
    .getByRole("button", { name: "Create sandbox" })
    .click();
  await waitFor("held create response", async () => concurrentOperationId);
  const secondConcurrentClick = secondTab
    .getByRole("button", { name: "Create sandbox" })
    .click();
  await secondTab.waitForTimeout(150);
  expect(new URL(secondTab.url()).pathname).toContain("/sandboxes");
  await waitForEffect("create", 2);
  releaseHeldResponse();
  await Promise.all([firstConcurrentClick, secondConcurrentClick]);
  await secondTab.waitForURL(/\/operations\//);
  expect(new URL(secondTab.url()).pathname.split("/").at(-1)!).toBe(
    concurrentOperationId!,
  );
  await secondTab.close();

  await page.getByLabel("State").selectOption("running");
  await page.getByLabel("Search").fill("no-such-label");
  await page.getByRole("heading", { name: "No sandboxes match" }).waitFor();
  await page.getByLabel("Search").fill("e2e");
  await page.goBack();
  await page.getByRole("heading", { name: `Operation ${createId}` }).waitFor();
  await page.goForward();
  await page.getByRole("heading", { name: "Fleet" }).waitFor();
  await page.getByRole("link", { name: sandboxId }).click();
  await page.getByRole("heading", { name: `Sandbox ${sandboxId}` }).waitFor();

  const fixture = {
    exitCode: 7,
    stdoutBase64: Buffer.from("fixture stdout\n").toString("base64"),
    stderrBase64: Buffer.from("fixture stderr\n").toString("base64"),
  };
  await seed("exec", "normal", fixture);
  let firstExecOperationId: string | undefined;
  let dropFirstExecResponse = true;
  await page.route("**/sandboxes/*/executions", async (route) => {
    if (route.request().method() !== "POST" || !dropFirstExecResponse) {
      await route.continue();
      return;
    }
    dropFirstExecResponse = false;
    const accepted = await route.fetch();
    firstExecOperationId = (await accepted.json()).operation.id;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Run command" }).click();
  await page.getByRole("button", { name: "Find accepted operation" }).waitFor();
  await waitForEffect("exec", 1);
  await page.reload();
  const recoveryTab = await context.newPage();
  await recoveryTab.goto(page.url());
  let releaseLookup!: () => void;
  const heldLookup = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  let lookupAccepted = false;
  await page.route("**/invocations/*?*", async (route) => {
    if (lookupAccepted) {
      await route.continue();
      return;
    }
    lookupAccepted = true;
    const response = await route.fetch();
    await heldLookup;
    await route.fulfill({ response });
  });
  const lookupClick = page
    .getByRole("button", { name: "Find accepted operation" })
    .click();
  await waitFor(
    "held invocation lookup",
    async () => lookupAccepted || undefined,
  );
  const retryClick = recoveryTab
    .getByRole("button", { name: "Run command" })
    .click();
  await recoveryTab.waitForTimeout(150);
  expect(new URL(recoveryTab.url()).pathname).toContain("/sandboxes/");
  releaseLookup();
  await Promise.all([lookupClick, retryClick]);
  await page.waitForURL(/\/operations\//);
  const execId = new URL(page.url()).pathname.split("/").at(-1)!;
  await recoveryTab.waitForURL(/\/operations\//);
  expect(new URL(recoveryTab.url()).pathname.split("/").at(-1)!).toBe(execId);
  await recoveryTab.close();
  expect(execId).toBe(firstExecOperationId!);
  const executed = await waitForOperation(projectId, execId, "succeeded");
  expect(executed.executionId).toBeTruthy();
  await page.getByText("fixture stdout").waitFor();
  await page.getByText("fixture stderr").waitFor();
  expect(await page.getByText("7", { exact: true }).isVisible()).toBe(true);
  const outputDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download stdout bytes" }).click();
  const stdoutDownload = await outputDownload;
  const stdoutPath = join(temp, "downloaded-stdout.bin");
  await stdoutDownload.saveAs(stdoutPath);
  expect(await readFile(stdoutPath)).toEqual(Buffer.from("fixture stdout\n"));

  await page.getByRole("link", { name: sandboxId }).click();
  await page.getByLabel("Local file").setInputFiles({
    name: "too-large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(1_048_577),
  });
  await page.getByRole("button", { name: "Upload file" }).click();
  await page.getByText("Choose a file of 1 MiB or less.").waitFor();
  expect(
    (await control("GET", "/_test/state")).ledger.filter(
      (entry: { action: string }) => entry.action === "file_write",
    ),
  ).toHaveLength(0);
  await page.getByLabel("Local file").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("persisted virtual file"),
  });
  await page.getByRole("button", { name: "Upload file" }).click();
  await page.getByRole("button", { name: "Upload file" }).waitFor();
  await page.getByText("Wrote 22 bytes to /work/example.txt.").waitFor();
  expect(await page.getByLabel("Local file").inputValue()).toBe("");
  const fileResponse = await context.request.get(
    `${serviceUrl}/v1/projects/${projectId}/sandboxes/${sandboxId}/files?path=%2Fwork%2Fexample.txt`,
  );
  expect(fileResponse.ok()).toBe(true);
  expect(await fileResponse.text()).toBe("persisted virtual file");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download path" }).click();
  const download = await downloaded;
  const downloadedPath = join(temp, "downloaded-example.txt");
  await download.saveAs(downloadedPath);
  expect(await readFile(downloadedPath, "utf8")).toBe("persisted virtual file");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Start new file_write attempt" }).click();
  await page.getByLabel("Remote path").fill("/work/second.txt");
  await page.getByLabel("Local file").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("persisted virtual file"),
  });
  expect(await page.getByRole("button", { name: "Upload file" }).isEnabled()).toBe(true);
  await page.getByRole("button", { name: "Upload file" }).click();
  await page.getByText("Wrote 22 bytes to /work/second.txt.").waitFor();
  await waitForEffect("file_write", 2);
  expect(await page.getByLabel("Local file").inputValue()).toBe("");

  await page.route("**/sandboxes/*/files?*", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.getByRole("button", { name: "Download path" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.unroute("**/sandboxes/*/files?*");
  await page.getByLabel("Operator token").fill(operatorToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: `Sandbox ${sandboxId}` }).waitFor();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Start new exec attempt" }).click();
  await seed("exec", "lost_after_effect", fixture);
  await page.getByRole("button", { name: "Run command" }).click();
  await page.waitForURL(/\/operations\//);
  const lostExecId = new URL(page.url()).pathname.split("/").at(-1)!;
  await waitForEffect("exec", 2);
  await page
    .getByText("The provider may already have applied this action.")
    .waitFor();
  await stop(server);
  expect(fake.exitCode).toBeNull();
  server = launchService();
  await ready(`${serviceUrl}/healthz`);
  await page.reload();
  await page
    .getByRole("heading", { name: `Operation ${lostExecId}` })
    .waitFor();
  await page.getByRole("button", { name: "Check again" }).click();
  await waitForOperation(projectId, lostExecId, "succeeded");

  await page.getByRole("link", { name: "Fleet" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Start new create attempt" }).click();
  await seed("create", "lost_after_effect");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await page.waitForURL(/\/operations\//);
  const lostCreateId = new URL(page.url()).pathname.split("/").at(-1)!;
  await waitForEffect("create", 3);
  await page
    .getByText("The provider may already have applied this action.")
    .waitFor();
  await stop(server);
  expect(fake.exitCode).toBeNull();
  server = launchService();
  await ready(`${serviceUrl}/healthz`);
  await page.reload();
  await page
    .getByRole("heading", { name: `Operation ${lostCreateId}` })
    .waitFor();
  await page.getByRole("button", { name: "Check again" }).click();
  await waitForOperation(projectId, lostCreateId, "succeeded");

  const state = await control("GET", "/_test/state");
  const createEntries = state.ledger.filter(
    (entry: { action: string }) => entry.action === "create",
  );
  const execEntries = state.ledger.filter(
    (entry: { action: string }) => entry.action === "exec",
  );
  expect(createEntries).toHaveLength(3);
  expect(execEntries).toHaveLength(2);
  for (const entry of [...createEntries, ...execEntries]) {
    expect(
      state.invocations.filter(
        (invocation: { submissionId: string }) =>
          invocation.submissionId === entry.submissionId,
      ),
    ).toHaveLength(1);
  }
  expect(
    state.resources.filter(
      (resource: { state: string }) => resource.state === "running",
    ),
  ).toHaveLength(3);

  await page.getByRole("link", { name: "Fleet" }).click();
  await page.getByRole("link", { name: sandboxId }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Destroy sandbox" }).click();
  await page.waitForURL(/\/operations\//);
  const destroyId = new URL(page.url()).pathname.split("/").at(-1)!;
  await waitForOperation(projectId, destroyId, "succeeded");
  const finalState = await control("GET", "/_test/state");
  expect(
    finalState.ledger.filter(
      (entry: { action: string }) => entry.action === "destroy",
    ),
  ).toHaveLength(1);
  await page.route("**/v1/sessions/logout", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/v1/session", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
}, 120_000);
