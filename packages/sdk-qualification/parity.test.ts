import { afterEach, describe, expect, test } from "bun:test";
import { Sandbar as DirectSandbar, Image as DirectImage } from "sandbar-sdk";
import { Sandbar as RemoteSandbar, Image as RemoteImage } from "sandbar-service/client";
import type { RecoveryReference, SandboxHandle } from "sandbar-sdk";
import { createFakeAdapter } from "@sandbar/provider-fake";
import { ProcessFixture } from "./processes";

type Backend = "direct" | "remote";

type ServiceRequest = { setupToken?: string; name?: string; provider?: string };

const fixtures: ProcessFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function post(url: string, token: string | undefined, body: ServiceRequest) {
  const headers = new Headers({ "Content-Type": "application/json" });

  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${await response.text()}`);

  return response.json();
}

type DirectClient = Awaited<ReturnType<typeof DirectSandbar.connect>>;

type RemoteClient = ReturnType<typeof RemoteSandbar.connect>;

type FixtureBackend<T> = {
  fixture: ProcessFixture;
  client: T;
  image: ReturnType<typeof DirectImage.prepared>;
};

async function backend(kind: "direct"): Promise<FixtureBackend<DirectClient>>;
async function backend(kind: "remote"): Promise<FixtureBackend<RemoteClient>>;
async function backend(kind: Backend): Promise<FixtureBackend<DirectClient | RemoteClient>>;
async function backend(kind: Backend) {
  const fixture = new ProcessFixture();
  fixtures.push(fixture);
  await fixture.startFake();

  if (kind === "direct") {
    const client = await DirectSandbar.connect({
      adapter: createFakeAdapter({ url: fixture.fakeUrl!, token: fixture.fakeToken }),
      config: {},
      credentials: {},
    });

    return { fixture, client, image: DirectImage.prepared("fake-starter") };
  }

  await fixture.startService();

  const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, {
    setupToken: fixture.setupToken,
  });

  const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, {
    name: "SDK parity",
  });

  const connection = await post(
    `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`,
    setup.token,
    { provider: "fake", name: "Local fake" },
  );

  await post(
    `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
    setup.token,
    {},
  );

  const client = RemoteSandbar.connect({
    url: fixture.serviceUrl!,
    token: setup.token,
    projectId: project.id,
  });

  return { fixture, client, image: RemoteImage.prepared("fake-starter") };
}

for (const kind of ["direct", "remote"] as const) {
  describe(`${kind} public SDK resources`, () => {
    test("create, inspect, exec, binary file and destroy", async () => {
      const { fixture, client, image } = await backend(kind);
      const command = { kind: "argv" as const, argv: ["fixture", "binary"] };
      const stdout = Uint8Array.from([0xff, 0x00, 0x80, 0x61]);
      const stderr = Uint8Array.from([0xfe, 0x62]);
      await fixture.fakeControl("/_test/seed", {
        submissionId: "*",
        action: "exec",
        behavior: "normal",
        command: {
          command,
          exitCode: 0,
          stdoutBase64: Buffer.from(stdout).toString("base64"),
          stderrBase64: Buffer.from(stderr).toString("base64"),
        },
      });

      try {
        const box = await client.sandboxes.create({ environment: image });
        expect((await box.inspect()).state).toBe("running");
        const execution = await box.exec({ command });
        expect(execution.exitCode).toBe(0);
        expect(execution.stdout).toEqual(stdout);
        expect(execution.stderr).toEqual(stderr);
        const file = Uint8Array.from([0x00, 0xff, 0x81, 0x61]);
        await box.writeFile("/data/binary", file);
        expect(await box.readFile("/data/binary")).toEqual(file);
        await box.destroy();
        expect((await box.inspect()).state).toBe("destroyed");
      } finally {
        await client.close();
      }
    }, 30_000);

    test("nonzero process exit preserves bounded binary output", async () => {
      const { fixture, client, image } = await backend(kind);
      const command = { kind: "argv" as const, argv: ["fixture", "nonzero"] };
      await fixture.fakeControl("/_test/seed", {
        submissionId: "*",
        action: "exec",
        behavior: "normal",
        command: {
          command,
          exitCode: 7,
          stdoutBase64: Buffer.from([0xff, 0x00]).toString("base64"),
          stderrBase64: Buffer.from([0x80, 0x01]).toString("base64"),
        },
      });

      try {
        const box = await client.sandboxes.create({ environment: image });

        try {
          await expect(box.exec({ command })).rejects.toMatchObject({
            name: "NonzeroExitError",
            result: {
              exitCode: 7,
              stdout: Uint8Array.from([0xff, 0x00]),
              stderr: Uint8Array.from([0x80, 0x01]),
            },
          });
        } finally {
          await box.destroy();
        }
      } finally {
        await client.close();
      }
    }, 30_000);
  });
}

describe("remote recovery evidence", () => {
  test("a lost admitted HTTP response remains recoverable, while a tampered imported reference sends no request", async () => {
    const fixture = new ProcessFixture();
    fixtures.push(fixture);
    await fixture.startFake();
    await fixture.startService();

    const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, {
      setupToken: fixture.setupToken,
    });

    const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, {
      name: "SDK recovery",
    });

    const connection = await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`,
      setup.token,
      { provider: "fake", name: "Local fake" },
    );

    await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      setup.token,
      {},
    );

    let lostResponses = 0;
    let dispatchedKey: string | null = null;

    // SAFETY: The adapter preserves the fetch call signature; the SDK never calls Bun's preconnect extension.
    const losingFetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);

      if (
        init?.method === "POST" &&
        new URL(url).pathname.endsWith("/sandboxes") &&
        lostResponses++ === 0
      ) {
        expect(response.ok).toBe(true);
        dispatchedKey = new Headers(init.headers).get("Idempotency-Key");
        await response.body?.cancel();
        throw new TypeError("HTTP response lost after admission");
      }

      return response;
    }) as typeof fetch;

    const first = RemoteSandbar.connect({
      url: fixture.serviceUrl!,
      token: setup.token,
      projectId: project.id,
      fetch: losingFetch,
    });

    try {
      const operation = await first.sandboxes.submitCreate({
        environment: RemoteImage.prepared("fake-starter"),
      });

      // SAFETY: The JSON is a round trip of the SDK-issued reference immediately above.
      const imported = JSON.parse(
        JSON.stringify(operation.reference),
      ) as typeof operation.reference;

      expect(lostResponses).toBe(1);
      expect(imported.invocationKey).toBe(String(dispatchedKey));
      expect(JSON.stringify(imported)).not.toContain(setup.token);
      await first.close();

      let recoveryRequests = 0;

      // SAFETY: The adapter preserves the fetch call signature; the SDK never calls Bun's preconnect extension.
      const countingFetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        recoveryRequests++;

        return fetch(input, init);
      }) as typeof fetch;

      const next = RemoteSandbar.connect({
        url: fixture.serviceUrl!,
        token: setup.token,
        projectId: project.id,
        fetch: countingFetch,
      });

      try {
        const badPath = {
          ...imported,
          kind: "file_write" as const,
          resourceId: "box_1",
          file: { path: "/data/../escape", bytes: 1 },
        };

        await expect(next.recover(badPath)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        const badKind = { ...imported, file: { path: "/data/safe", bytes: 1 } };
        await expect(next.recover(badKind)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        expect(recoveryRequests).toBe(0);

        // SAFETY: The reference came from submitCreate, whose completed result is a sandbox handle.
        const box = (await (await next.recover(imported)).wait()) as SandboxHandle;
        expect((await box.inspect()).state).toBe("running");
        const state = await fixture.fakeControl("/_test/state");
        expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
        expect(
          state.invocations.filter((entry: any) => entry.action === "file_write"),
        ).toHaveLength(0);
        await box.destroy();
      } finally {
        await next.close();
      }
    } finally {
      await first.close();
    }
  }, 30_000);

  test("a post-admission sandbox read failure exposes a reference for read-only recovery", async () => {
    const fixture = new ProcessFixture();
    fixtures.push(fixture);
    await fixture.startFake();
    await fixture.startService();

    const setup = await post(`${fixture.serviceUrl}/v1/setup`, undefined, {
      setupToken: fixture.setupToken,
    });

    const project = await post(`${fixture.serviceUrl}/v1/projects`, setup.token, {
      name: "SDK read recovery",
    });

    const connection = await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections`,
      setup.token,
      { provider: "fake", name: "Local fake" },
    );

    await post(
      `${fixture.serviceUrl}/v1/projects/${project.id}/provider-connections/${connection.id}/verify`,
      setup.token,
      {},
    );

    let failedReads = 0;

    // SAFETY: The adapter preserves the fetch call signature; the SDK never calls Bun's preconnect extension.
    const failingFetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const response = await fetch(input, init);
      const url = input instanceof Request ? input.url : String(input);

      if (
        (init?.method ?? "GET") === "GET" &&
        /\/sandboxes\/[^/]+$/.test(new URL(url).pathname) &&
        failedReads++ === 0
      ) {
        expect(response.ok).toBe(true);
        await response.body?.cancel();
        throw new TypeError("Sandbox read failed after admission");
      }

      return response;
    }) as typeof fetch;

    const first = RemoteSandbar.connect({
      url: fixture.serviceUrl!,
      token: setup.token,
      projectId: project.id,
      fetch: failingFetch,
    });

    let reference: RecoveryReference | undefined;

    try {
      try {
        await first.sandboxes.create({ environment: RemoteImage.prepared("fake-starter") });
        throw new Error("Expected a failed follow-up sandbox read");
      } catch (error) {
        expect(error).toMatchObject({
          name: "OutcomeUnknownError",
          reference: { mode: "remote", kind: "create" },
        });
        // SAFETY: The preceding assertion checks the error's recovery reference shape.
        reference = (error as { reference: RecoveryReference }).reference;
      }

      expect(failedReads).toBe(1);
      // SAFETY: The JSON is a round trip of the SDK-issued reference from the caught error.
      const imported = JSON.parse(JSON.stringify(reference)) as RecoveryReference;
      expect(imported.invocationKey).toBeTruthy();
      expect(imported.operationId).toBeTruthy();
      expect(JSON.stringify(imported)).not.toContain(setup.token);
      await first.close();

      const next = RemoteSandbar.connect({
        url: fixture.serviceUrl!,
        token: setup.token,
        projectId: project.id,
      });

      try {
        // SAFETY: The reference is for a completed create operation, so wait resolves to a sandbox handle.
        const box = (await (await next.recover(imported)).wait()) as SandboxHandle;
        expect((await box.inspect()).state).toBe("running");
        const state = await fixture.fakeControl("/_test/state");
        expect(state.invocations.filter((entry: any) => entry.action === "create")).toHaveLength(1);
        await box.destroy();
      } finally {
        await next.close();
      }
    } finally {
      await first.close();
    }
  }, 30_000);
});
