import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { ExecCommand } from "@sandbar/contracts";
import { daytonaProvider, daytonaRegistration } from "./index";
import { NonzeroExitError, Sandbar } from "@sandbar/sdk/direct";
import { ProviderReadError } from "@sandbar/provider-spi";

function fixtureFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  organization?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/api/organizations/"))
        return organization
          ? organization(input, init)
          : Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      return handler(input, init);
    },
    { preconnect: fetch.preconnect },
  );
}

const apiUrl = "https://app.daytona.io/api";

const toolboxOrigin = "https://proxy.app.daytona.io";

const native = (name: string, state = "started") => ({
  id: "native-1",
  name,
  organizationId: "org-1",
  target: "us",
  state,
  networkBlockAll: true,
  public: false,
  toolboxProxyUrl: `${toolboxOrigin}/toolbox`,
});

const listed = (name: string) => {
  const { networkBlockAll: _network, public: _public, ...summary } = native(name);

  return summary;
};

const region = (organizationId = "org-1") => ({
  id: "us",
  name: "United States",
  regionType: "shared",
  organizationId,
});

const identity = (submissionId: string) => ({
  projectId: "direct",
  operationId: `op_${submissionId}`,
  invocationKey: `key_${submissionId}`,
  submissionId,
});

type NativeLabels = { "sandbar.submission"?: string; "sandbar.operation"?: string };

type FixtureJson =
  | null
  | boolean
  | number
  | string
  | FixtureJson[]
  | { [key: string]: FixtureJson };

test("endpoint pairs must be explicitly trusted before forwarding an API key", async () => {
  let calls = 0;

  const fetchImpl = fixtureFetch(async (_input: RequestInfo | URL) => {
    calls++;

    if (new URL(String(_input)).pathname.endsWith("/regions")) return Response.json([region()]);

    return Response.json({ organizationId: "org-1" });
  });

  const custom = {
    apiUrl: "https://private.daytona.example/api",
    toolboxOrigin: "https://toolbox.private.daytona.example",
  };

  await expect(
    daytonaProvider({ apiKey: "secret", target: "us", ...custom, fetch: fetchImpl }),
  ).rejects.toThrow("not trusted");
  expect(() =>
    daytonaRegistration(fetchImpl).validate({
      credentials: { apiKey: "secret" },
      configuration: { ...custom, target: "us" },
    }),
  ).toThrow("not trusted");
  expect(calls).toBe(0);

  const provider = await daytonaProvider({
    apiKey: "secret",
    target: "us",
    ...custom,
    trustedEndpoints: [custom],
    fetch: fetchImpl,
  });

  expect(provider.scope.endpoint).toBe(custom.apiUrl);
  expect(calls).toBe(2);
  await expect(
    daytonaProvider({
      apiKey: "secret",
      target: "us",
      apiUrl: custom.apiUrl,
      toolboxOrigin,
      trustedEndpoints: [custom],
      fetch: fetchImpl,
    }),
  ).rejects.toThrow("not trusted");
  expect(calls).toBe(2);
});

test.each([401, 403])(
  "credential verification %i is sanitized and cancels its response body",
  async (status) => {
    let cancelled = false;
    let calls = 0;

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
      calls++;
      expect(new URL(String(input)).pathname).toBe("/api/api-keys/current");

      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("sensitive provider body"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
    });

    await expect(
      daytonaProvider({ apiKey: "secret", target: "us", fetch: fetchImpl }),
    ).rejects.toMatchObject({
      name: "ProviderReadError",
      code: "UNAUTHENTICATED",
      message: "Daytona credential verification failed",
    } satisfies Partial<ProviderReadError>);
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
  },
);

test.each([
  ["name only", "United States", [region()], 200],
  ["missing", "us", [], 200],
  ["duplicate", "us", [region(), region()], 200],
  ["malformed", "us", [{ name: "United States" }], 200],
  ["foreign dedicated", "us", [{ ...region("org-other"), regionType: "dedicated" }], 200],
  ["failed listing", "us", null, 503],
] as const)(
  "target verification rejects %s before mutation",
  async (_case, target, regions, status) => {
    const calls: string[] = [];

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json(regions, { status });

      throw new Error(`Unexpected ${url.pathname}`);
    });

    await expect(daytonaProvider({ apiKey: "key", target, fetch: fetchImpl })).rejects.toThrow();
    expect(calls).toEqual(["GET /api/api-keys/current", "GET /api/regions"]);
  },
);

test.each([
  ["restricted", { id: "org-1", sandboxLimitedNetworkEgress: true }, 200],
  ["missing flag", { id: "org-1" }, 200],
  ["malformed flag", { id: "org-1", sandboxLimitedNetworkEgress: "false" }, 200],
  ["wrong organization", { id: "org-other", sandboxLimitedNetworkEgress: false }, 200],
  ["unreadable", { error: "unavailable" }, 503],
] as const)(
  "%s organization cannot create blocked sandbox but can clean up",
  async (_case, value, status) => {
    let creates = 0;
    let deletes = 0;
    let snapshotReads = 0;

    const fetchImpl = fixtureFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));

        if (url.pathname === "/api/api-keys/current")
          return Response.json({ organizationId: "org-1" });

        if (url.pathname === "/api/regions") return Response.json([region()]);

        if (url.pathname === "/api/snapshots/snap-1") {
          snapshotReads++;
          throw new Error("snapshot should not be checked without strict egress support");
        }

        if (url.pathname === "/api/sandbox" && init?.method === "POST") creates++;

        if (url.pathname === "/api/sandbox/native-1" && init?.method === "DELETE") {
          deletes++;

          return Response.json(native("existing", "destroyed"));
        }

        throw new Error(`Unexpected ${url.pathname}`);
      },
      async () => Response.json(value, { status }),
    );

    const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
    const capabilities = await provider.driver.capabilities(provider.scope);
    expect(capabilities.networkPolicies).toEqual([]);
    expect(capabilities.supports.inventory).toBe(true);
    expect(
      (
        await provider.driver.prepare({
          scope: provider.scope,
          image: { kind: "prepared", value: "snap-1" },
          networkPolicy: "blocked",
        })
      ).supported,
    ).toBe(false);

    const cleanup = await provider.driver.destroy({
      sandbox: { scope: provider.scope, nativeId: "native-1", kind: "sandbox" },
      identity: identity("cleanup"),
    });

    expect(cleanup.status).toBe("completed");
    expect(creates).toBe(0);
    expect(snapshotReads).toBe(0);
    expect(deletes).toBe(1);
  },
);

test("blocked egress eligibility is rechecked by prepare before submission", async () => {
  let limited = true;
  let creates = 0;
  let snapshotReads = 0;

  const fetchImpl = fixtureFetch(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json([region()]);

      if (url.pathname === "/api/snapshots/snap-1") snapshotReads++;

      if (url.pathname === "/api/sandbox" && init?.method === "POST") creates++;

      throw new Error(`Unexpected ${url.pathname}`);
    },
    async () => Response.json({ id: "org-1", sandboxLimitedNetworkEgress: limited }),
  );

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  limited = false;
  expect((await provider.driver.capabilities(provider.scope)).networkPolicies).toEqual(["blocked"]);
  limited = true;

  const preparation = await provider.driver.prepare({
    scope: provider.scope,
    image: { kind: "prepared", value: "snap-1" },
    networkPolicy: "blocked",
  });

  expect(preparation.supported).toBe(false);
  expect(snapshotReads).toBe(0);
  expect(creates).toBe(0);
});

test("verified direct scope, read-only preparation, one create, exact binary execution and files", async () => {
  const calls: string[] = [];
  let createdName = "";
  let snapshotReads = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const json = (value: FixtureJson, status = 200) => Response.json(value, { status });

    if (url.pathname === "/api/api-keys/current") return json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return json([region()]);

    if (url.pathname === "/api/snapshots/snap-1") {
      snapshotReads++;

      if (snapshotReads > 1) throw new Error("snapshot was checked after submission");

      return json({
        id: "snap-1",
        organizationId: "org-1",
        state: "active",
        regionIds: ["us"],
        sandboxClass: "linux-vm",
      });
    }

    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      createdName = z.object({ name: z.string() }).parse(JSON.parse(String(init.body))).name;

      return json(native(createdName));
    }

    if (url.pathname === "/api/sandbox")
      return json({ items: createdName ? [native(createdName)] : [], nextCursor: null });

    if (url.pathname === "/api/sandbox/native-1" && init?.method === "DELETE")
      return json(native(createdName, "destroyed"));

    if (url.pathname === "/api/sandbox/native-1") return json(native(createdName));

    if (url.pathname.endsWith("/process/execute"))
      return json({
        exitCode: 0,
        result: "SANDBAR-EXEC-V1\n7\n2\n1\n 00 ff\nSANDBAR-STDERR\n 7f\nSANDBAR-END\n",
      });

    if (url.pathname.endsWith("/files/upload-v2"))
      return json({ name: "file", path: "/file", type: "file" });

    if (url.pathname.endsWith("/files/download")) return new Response(new Uint8Array([0, 255]));
    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "private-key", target: "us", fetch: fetchImpl });
  expect(provider.scope.accountId).toBe("org-1");
  expect(provider.scope.endpoint).toBe(apiUrl);
  const client = Sandbar.direct({ provider });

  const sandbox = await client.sandboxes.create({
    environment: { kind: "prepared", value: "snap-1" },
  });

  expect(sandbox.id).toBe("native-1");

  const output = await sandbox
    .exec({ command: { kind: "shell", script: "exit 7" } })
    .catch((error) => {
      if (error instanceof NonzeroExitError) return error.result;
      throw error;
    });

  expect(output.exitCode).toBe(7);
  expect(Array.from(output.stdout)).toEqual([0, 255]);
  expect(Array.from(output.stderr)).toEqual([127]);
  expect(Array.from(await sandbox.readFile("/file"))).toEqual([0, 255]);
  await sandbox.writeFile("/file", new Uint8Array([0, 255]), { overwrite: true });
  await sandbox.destroy();
  expect(calls.filter((value) => value === "POST /api/sandbox")).toHaveLength(1);
  expect(snapshotReads).toBe(1);
  expect(calls.filter((value) => value.endsWith("/process/execute"))).toHaveLength(1);
  expect(calls.filter((value) => value.endsWith("/files/upload-v2"))).toHaveLength(1);
  await client.close();
});

test("unexpected public create response remains unknown without replay", async () => {
  let creates = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      creates++;

      return Response.json({ ...native("sandbar-public-create"), public: true });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });

  const result = await provider.driver.create({
    scope: provider.scope,
    identity: identity("public-create"),
    image: "snap-1",
    networkPolicy: "blocked",
  });

  expect(result.status).toBe("unknown");
  expect(result.effect).toBe("possible");
  expect(creates).toBe(1);
});

test.each(["stopped", "paused", "archived"])(
  "existing %s sandbox completes create and recovery with unknown readiness",
  async (state) => {
    let creates = 0;
    const name = "sandbar-settled-create";

    const labels = {
      "sandbar.submission": "settled-create",
      "sandbar.operation": "op_settled-create",
    };

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json([region()]);

      if (url.pathname === "/api/sandbox" && init?.method === "POST") {
        creates++;

        return Response.json({ ...native(name, state), labels });
      }

      if (url.pathname === "/api/sandbox")
        return Response.json({ items: [{ ...listed(name), state, labels }], nextCursor: null });

      if (url.pathname === "/api/sandbox/native-1")
        return Response.json({ ...native(name, state), labels });

      throw new Error(`Unexpected ${url.pathname}`);
    });

    const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });

    const created = await provider.driver.create({
      scope: provider.scope,
      identity: identity("settled-create"),
      image: "snap-1",
      networkPolicy: "blocked",
    });

    const recovered = await provider.driver.observe({
      scope: provider.scope,
      submissionId: "settled-create",
      operationId: "op_settled-create",
    });

    for (const result of [created, recovered]) {
      expect(result?.status).toBe("completed");

      if (result?.status === "completed" && result.value.kind === "sandbox") {
        expect(result.value.observation.state).toBe("unknown");
        expect(result.value.observation.ref.nativeId).toBe("native-1");
      }
    }

    expect(creates).toBe(1);
  },
);

test.each(["stopped", "paused", "archived", "starting"])(
  "%s sandbox rejects direct exec and write before toolbox mutation but allows cleanup",
  async (state) => {
    let toolboxPosts = 0;
    let deletes = 0;
    let detailReads = 0;

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json([region()]);

      if (url.pathname === "/api/sandbox/native-1" && init?.method === "DELETE") {
        deletes++;

        return Response.json(native("existing", "destroyed"));
      }

      if (url.pathname === "/api/sandbox/native-1") {
        detailReads++;

        return Response.json(native("existing", state));
      }

      if (init?.method === "POST") toolboxPosts++;

      throw new Error(`Unexpected ${url.pathname}`);
    });

    const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
    const sandbox = { scope: provider.scope, nativeId: "native-1", kind: "sandbox" as const };

    const execution = await provider.driver.exec({
      sandbox,
      identity: identity(`blocked-exec-${state}`),
      command: { kind: "shell", script: "true" },
      deadlineSeconds: 10,
      maxOutputBytes: 16,
    });

    const write = await provider.driver.writeFile({
      sandbox,
      identity: identity(`blocked-write-${state}`),
      path: "/file",
      bytes: new Uint8Array([1]),
      overwrite: true,
    });

    for (const result of [execution, write]) {
      expect(result.status).toBe("rejected");
      expect(result.effect).toBe("none");

      if (result.status === "rejected") {
        expect(result.error.code).toBe("unavailable");
        expect(result.error.retry).toBe("never");
      }
    }

    expect(detailReads).toBe(2);
    expect(toolboxPosts).toBe(0);

    const cleanup = await provider.driver.destroy({
      sandbox,
      identity: identity(`cleanup-${state}`),
    });

    expect(cleanup.status).toBe("completed");
    expect(deletes).toBe(1);
  },
);

test("lost create response is observed by stable name without replay; scope rotation fails", async () => {
  let posts = 0;
  let name = "";
  let account = "org-1";
  let detailPolicy = true;
  let detailPublic: boolean | undefined = false;
  let detailAccount = "org-1";
  let detailLabels: NativeLabels | null = null;

  let labels: NativeLabels = {
    "sandbar.submission": "submit-1",
    "sandbar.operation": "op_submit-1",
  };

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: account });

    if (url.pathname === "/api/regions") return Response.json([region(account)]);

    if (url.pathname === "/api/snapshots/snap-1")
      return Response.json({
        id: "snap-1",
        organizationId: account,
        state: "active",
        regionIds: ["us"],
        sandboxClass: "linux-vm",
      });

    if (url.pathname === "/api/sandbox" && init?.method === "POST") {
      posts++;
      name = z.object({ name: z.string() }).parse(JSON.parse(String(init.body))).name;
      throw new Error("response lost");
    }

    if (url.pathname === "/api/sandbox")
      return Response.json({ items: [{ ...listed(name), labels }], nextCursor: null });

    if (url.pathname === "/api/sandbox/native-1")
      return Response.json({
        ...native(name),
        organizationId: detailAccount,
        networkBlockAll: detailPolicy,
        public: detailPublic,
        labels: detailLabels ?? labels,
      });
    throw new Error("Unexpected request");
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });

  const result = await provider.driver.create({
    scope: provider.scope,
    identity: identity("submit-1"),
    image: "snap-1",
    networkPolicy: "blocked",
  });

  expect(result.status).toBe("unknown");
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "wrong-operation",
    }),
  ).toBeNull();
  labels = { "sandbar.submission": "submit-1" };
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  labels = { "sandbar.submission": "forged-submission", "sandbar.operation": "op_submit-1" };
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  labels = { "sandbar.operation": "op_submit-1" };
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  labels = { "sandbar.submission": "submit-1", "sandbar.operation": "op_submit-1" };

  detailPolicy = false;
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  detailPolicy = true;
  detailPublic = true;
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  detailPublic = undefined;
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  detailPublic = false;
  detailAccount = "org-other";
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  detailAccount = "org-1";
  detailLabels = { "sandbar.submission": "forged", "sandbar.operation": "op_submit-1" };
  expect(
    await provider.driver.observe({
      scope: provider.scope,
      submissionId: "submit-1",
      operationId: "op_submit-1",
    }),
  ).toBeNull();
  detailLabels = null;

  const observed = await provider.driver.observe({
    scope: provider.scope,
    submissionId: "submit-1",
    operationId: "op_submit-1",
  });

  expect(observed?.status).toBe("completed");
  expect((await provider.driver.inventory({ scope: provider.scope, limit: 2 })).items).toHaveLength(
    1,
  );
  expect(posts).toBe(1);
  account = "org-2";
  const rotated = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  expect(rotated.scope.accountId).not.toBe(provider.scope.accountId);
});

test("unsupported OCI and no-overwrite reject before mutation", async () => {
  const calls: string[] = [];

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

    if (new URL(String(input)).pathname === "/api/regions") return Response.json([region()]);

    return Response.json({ organizationId: "org-1" });
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  expect(
    (
      await provider.driver.prepare({
        scope: provider.scope,
        image: { kind: "oci", value: "alpine:latest" },
        networkPolicy: "blocked",
      })
    ).supported,
  ).toBe(false);
  const client = Sandbar.direct({ provider });
  await expect(
    client.sandboxes.create({ environment: { kind: "oci", value: "alpine:latest" } }),
  ).rejects.toThrow();
  await client.close();

  const write = await provider.driver.writeFile({
    sandbox: { scope: provider.scope, nativeId: "native-1", kind: "sandbox" },
    identity: identity("write-1"),
    path: "/file",
    bytes: new Uint8Array([1]),
    overwrite: false,
  });

  expect(write.status).toBe("rejected");
  expect(calls).toEqual(["GET /api/api-keys/current", "GET /api/regions"]);
});

test("lost exec and upload responses remain unknown after one submission each", async () => {
  let executes = 0,
    uploads = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox/native-1") return Response.json(native("sandbar-existing"));

    if (url.pathname.endsWith("/process/execute")) {
      executes++;
      throw new Error("response lost");
    }

    if (url.pathname.endsWith("/files/upload-v2")) {
      uploads++;
      throw new Error("response lost");
    }

    if (url.pathname === "/api/sandbox") return Response.json({ items: [], nextCursor: null });
    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  const sandbox = { scope: provider.scope, nativeId: "native-1", kind: "sandbox" as const };

  const exec = await provider.driver.exec({
    sandbox,
    identity: identity("exec-lost"),
    command: { kind: "argv", argv: ["printf", "a'b", "$(touch /tmp/unsafe)"] },
    deadlineSeconds: 30,
    maxOutputBytes: 10,
  });

  const write = await provider.driver.writeFile({
    sandbox,
    identity: identity("write-lost"),
    path: "/file",
    bytes: new Uint8Array([0, 255]),
    overwrite: true,
  });

  expect(exec.status).toBe("unknown");
  expect(write.status).toBe("unknown");
  expect(
    await provider.driver.observe({ scope: provider.scope, submissionId: "exec-lost" }),
  ).toBeNull();
  expect(executes).toBe(1);
  expect(uploads).toBe(1);
});

test.each(["missing", "read failure"])(
  "toolbox %s rejects exec and upload before any mutation",
  async (failure) => {
    let executes = 0,
      uploads = 0;

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json([region()]);

      if (url.pathname === "/api/sandbox/native-1") {
        if (failure === "missing") return new Response(null, { status: 404 });
        throw new Error("read failed");
      }

      if (url.pathname.endsWith("/process/execute")) executes++;

      if (url.pathname.endsWith("/files/upload-v2")) uploads++;
      throw new Error(`Unexpected ${url.pathname}`);
    });

    const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
    const sandbox = { scope: provider.scope, nativeId: "native-1", kind: "sandbox" as const };

    const exec = await provider.driver.exec({
      sandbox,
      identity: identity(`exec-${failure}`),
      command: { kind: "shell", script: "true" },
      deadlineSeconds: 30,
      maxOutputBytes: 10,
    });

    const write = await provider.driver.writeFile({
      sandbox,
      identity: identity(`write-${failure}`),
      path: "/file",
      bytes: new Uint8Array([1]),
      overwrite: true,
    });

    for (const result of [exec, write]) {
      expect(result.status).toBe("rejected");
      expect(result.effect).toBe("none");

      if (result.status === "rejected") {
        expect(result.error.code).toBe(failure === "missing" ? "not_found" : "unavailable");
        expect(result.error.retry).toBe("never");
      }
    }

    expect(executes).toBe(0);
    expect(uploads).toBe(0);
  },
);

test("cross-wired sandbox identity and malformed execution output never complete", async () => {
  let executions = 0;
  let wrongId = true;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox/native-1")
      return Response.json({
        ...native("sandbar-existing"),
        id: wrongId ? "native-other" : "native-1",
      });

    if (url.pathname.endsWith("/process/execute")) {
      executions++;

      return Response.json({ exitCode: 0, result: "not a capture envelope" });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  const sandbox = { scope: provider.scope, nativeId: "native-1", kind: "sandbox" as const };
  expect(
    (
      await provider.driver.exec({
        sandbox,
        identity: identity("cross-wire"),
        command: { kind: "shell", script: "true" },
        deadlineSeconds: 30,
        maxOutputBytes: 10,
      })
    ).status,
  ).toBe("rejected");
  expect(executions).toBe(0);
  wrongId = false;
  expect(
    (
      await provider.driver.exec({
        sandbox,
        identity: identity("malformed"),
        command: { kind: "shell", script: "true" },
        deadlineSeconds: 30,
        maxOutputBytes: 10,
      })
    ).status,
  ).toBe("unknown");
  expect(executions).toBe(1);
});

test("POSIX capture wrapper drains a noisy command while retaining only bounded bytes", async () => {
  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox/native-1") return Response.json(native("sandbar-existing"));

    if (url.pathname.endsWith("/process/execute")) {
      const script = z
        .object({ command: z.string() })
        .parse(JSON.parse(String(init?.body))).command;

      const command = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 4096,
      });

      expect(command.error).toBeUndefined();

      return Response.json({ exitCode: command.status, result: command.stdout });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });

  const result = await provider.driver.exec({
    sandbox: { scope: provider.scope, nativeId: "native-1", kind: "sandbox" },
    identity: identity("noisy"),
    command: { kind: "shell", script: "head -c 200000 /dev/zero" },
    deadlineSeconds: 30,
    maxOutputBytes: 16,
  });

  expect(result.status).toBe("completed");

  if (result.status === "completed" && result.value.kind === "execution") {
    expect(Buffer.from(result.value.observation.stdoutBase64!, "base64").length).toBe(16);
    expect(result.value.observation.truncated).toBe(true);
  }
});

test("generated capture wrapper isolates utilities from requested PATH and preserves command environment", async () => {
  let posts = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox/native-1") return Response.json(native("sandbar-existing"));

    if (url.pathname.endsWith("/process/execute")) {
      posts++;

      const body = z
        .object({ command: z.string(), envs: z.never().optional() })
        .parse(JSON.parse(String(init?.body)));

      const execution = spawnSync("sh", ["-c", body.command], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 8192,
      });

      expect(execution.error).toBeUndefined();

      return Response.json({ exitCode: execution.status, result: execution.stdout });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  const sandbox = { scope: provider.scope, nativeId: "native-1", kind: "sandbox" as const };

  const cases: {
    command: ExecCommand;
    env: Record<string, string>;
    expected: Buffer;
    exitCode: number;
  }[] = [
    {
      command: { kind: "shell" as const, script: "/usr/bin/printf '%s\\000\\377' \"$VALUE\"" },
      env: { PATH: "", VALUE: "a'b;$(printf injected)" },
      expected: Buffer.concat([Buffer.from("a'b;$(printf injected)"), Buffer.from([0, 255])]),
      exitCode: 0,
    },
    {
      command: { kind: "argv" as const, argv: ["/usr/bin/printf", "%s", "a'b;$(printf injected)"] },
      env: { PATH: "" },
      expected: Buffer.from("a'b;$(printf injected)"),
      exitCode: 0,
    },
    {
      command: { kind: "argv" as const, argv: ["printf", "%s", "custom-path"] },
      env: { PATH: "/usr/bin:/bin" },
      expected: Buffer.from("custom-path"),
      exitCode: 0,
    },
    {
      command: { kind: "argv" as const, argv: ["printf", "%s", "must-not-run"] },
      env: { PATH: "/no/such/directory" },
      expected: Buffer.alloc(0),
      exitCode: 127,
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const result = await provider.driver.exec({
      sandbox,
      identity: identity(`path-${index}`),
      command: scenario.command,
      env: scenario.env,
      deadlineSeconds: 10,
      maxOutputBytes: 1024,
    });

    expect(result.status).toBe("completed");

    if (result.status === "completed" && result.value.kind === "execution") {
      if (result.value.observation.exitCode !== scenario.exitCode)
        throw new Error(
          `Case ${index}: ${Buffer.from(result.value.observation.stderrBase64 ?? "", "base64").toString()}`,
        );

      expect(result.value.observation.exitCode).toBe(scenario.exitCode);
      expect(
        Array.from(Buffer.from(result.value.observation.stdoutBase64 ?? "", "base64")),
      ).toEqual(Array.from(scenario.expected));
    }
  }

  expect(posts).toBe(cases.length);
});

test.each([
  [
    "odd hex token",
    "SANDBAR-EXEC-V1\n0\n1\n0\na\nSANDBAR-STDERR\nSANDBAR-END\n",
    2,
    "unknown",
    false,
  ],
  [
    "missing captured byte",
    "SANDBAR-EXEC-V1\n0\n1\n0\nSANDBAR-STDERR\nSANDBAR-END\n",
    2,
    "unknown",
    false,
  ],
  [
    "short captured payload",
    "SANDBAR-EXEC-V1\n0\n2\n0\n00\nSANDBAR-STDERR\nSANDBAR-END\n",
    2,
    "unknown",
    false,
  ],
  [
    "wrong stderr allocation",
    "SANDBAR-EXEC-V1\n0\n2\n1\n00\nSANDBAR-STDERR\nff\nSANDBAR-END\n",
    1,
    "unknown",
    false,
  ],
  ["zero bytes", "SANDBAR-EXEC-V1\n0\n0\n0\nSANDBAR-STDERR\nSANDBAR-END\n", 2, "completed", false],
  [
    "full binary bytes",
    "SANDBAR-EXEC-V1\n0\n2\n0\n00 ff\nSANDBAR-STDERR\nSANDBAR-END\n",
    2,
    "completed",
    false,
  ],
  [
    "legitimate truncation",
    "SANDBAR-EXEC-V1\n0\n2\n1\n00\nSANDBAR-STDERR\nSANDBAR-END\n",
    1,
    "completed",
    true,
  ],
] as const)(
  "capture frame %s has exact byte accounting",
  async (_name, frame, maxOutputBytes, expectedStatus, truncated) => {
    let posts = 0;

    const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions") return Response.json([region()]);

      if (url.pathname === "/api/sandbox/native-1")
        return Response.json(native("sandbar-existing"));

      if (url.pathname.endsWith("/process/execute")) {
        posts++;

        return Response.json({ exitCode: 0, result: frame });
      }

      throw new Error(`Unexpected ${url.pathname}`);
    });

    const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
    const submissionId = `frame-${_name.replaceAll(" ", "-")}`;

    const result = await provider.driver.exec({
      sandbox: { scope: provider.scope, nativeId: "native-1", kind: "sandbox" },
      identity: identity(submissionId),
      command: { kind: "shell", script: "true" },
      deadlineSeconds: 10,
      maxOutputBytes,
    });

    expect(result.status).toBe(expectedStatus);
    expect(posts).toBe(1);

    if (result.status === "unknown") {
      expect(result.effect).toBe("possible");
      expect(result.submissionId).toBe(submissionId);
    } else if (result.status === "completed" && result.value.kind === "execution") {
      expect(result.value.observation.truncated).toBe(truncated);
    }
  },
);

test("local capture utility failure leaves an incomplete frame that stays unknown", async () => {
  let posts = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

    if (url.pathname === "/api/regions") return Response.json([region()]);

    if (url.pathname === "/api/sandbox/native-1") return Response.json(native("sandbar-existing"));

    if (url.pathname.endsWith("/process/execute")) {
      posts++;

      const script = z
        .object({ command: z.string() })
        .parse(JSON.parse(String(init?.body))).command;

      const failedCapture = script.replaceAll("| od -An -tx1 -v", "| false");

      const execution = spawnSync("sh", ["-c", failedCapture], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 8192,
      });

      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe(0);

      return Response.json({ exitCode: execution.status, result: execution.stdout });
    }

    throw new Error(`Unexpected ${url.pathname}`);
  });

  const provider = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });

  const result = await provider.driver.exec({
    sandbox: { scope: provider.scope, nativeId: "native-1", kind: "sandbox" },
    identity: identity("capture-tool-failed"),
    command: { kind: "shell", script: "/usr/bin/printf a" },
    deadlineSeconds: 10,
    maxOutputBytes: 4,
  });

  expect(result.status).toBe("unknown");

  if (result.status === "unknown") {
    expect(result.effect).toBe("possible");
    expect(result.submissionId).toBe("capture-tool-failed");
  }

  expect(posts).toBe(1);
});
