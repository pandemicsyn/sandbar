import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { daytonaProvider, daytonaRegistration } from "./index";
import { NonzeroExitError, Sandbar } from "@sandbar/sdk/direct";

function fixtureFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
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
  toolboxProxyUrl: `${toolboxOrigin}/toolbox`,
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
  expect(calls).toBe(1);
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
  expect(calls).toBe(1);
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

test("lost create response is observed by stable name without replay; scope rotation fails", async () => {
  let posts = 0;
  let name = "";
  let account = "org-1";

  let labels: NativeLabels = {
    "sandbar.submission": "submit-1",
    "sandbar.operation": "op_submit-1",
  };

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: account });

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
      return Response.json({ items: [{ ...native(name), labels }], nextCursor: null });
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

  const observed = await provider.driver.observe({
    scope: provider.scope,
    submissionId: "submit-1",
    operationId: "op_submit-1",
  });

  expect(observed?.status).toBe("completed");
  expect(posts).toBe(1);
  account = "org-2";
  const rotated = await daytonaProvider({ apiKey: "key", target: "us", fetch: fetchImpl });
  expect(rotated.scope.accountId).not.toBe(provider.scope.accountId);
});

test("unsupported OCI and no-overwrite reject before mutation", async () => {
  const calls: string[] = [];

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

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
  expect(calls).toEqual(["GET /api/api-keys/current"]);
});

test("lost exec and upload responses remain unknown after one submission each", async () => {
  let executes = 0,
    uploads = 0;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

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

test("cross-wired sandbox identity and malformed execution output never complete", async () => {
  let executions = 0;
  let wrongId = true;

  const fetchImpl = fixtureFetch(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));

    if (url.pathname === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

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
  ).toBe("unknown");
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
