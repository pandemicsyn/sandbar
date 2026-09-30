import { expect, test } from "bun:test";
import { z } from "zod";
import { adapterSuite } from "sandbar-adapter/testing";
import { createDaytonaAdapter } from "./adapter";
import {
  Sandbar,
  SandbarError,
  Image,
  AdapterSandbox,
  OutcomeUnknownError,
  WaitAbortedError,
  type AdapterRecoveryReference,
} from "sandbar-sdk";

test.each([
  "normal",
  "pending-id",
  "unknown-id",
  "unnamed-active",
  "unnamed-pending",
  "incomplete-name",
  "incomplete-source",
  "wrong-id",
  "wrong-scope",
  "lost",
  "wrong-source",
] as const)("explicit image build is scoped and never creates a sandbox: %s", async (mode) => {
  const lost = mode === "lost" || mode === "wrong-source";
  const incomplete = mode === "incomplete-name" || mode === "incomplete-source";
  let idReads = 0;
  let builds = 0;
  let creates = 0;
  let name = "";
  let sandboxName = "";
  let observations = 0;

  const snapshot = () => ({
    id: "built-1",
    name,
    imageName: mode === "wrong-source" ? "other:1" : "alpine:3.21",
    organizationId: "org-1",
    state: "active",
    regionIds: ["us"],
    sandboxClass: "container",
  });

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots" && init?.method === "POST") {
        builds++;
        name = z.object({ name: z.string() }).parse(JSON.parse(String(init.body))).name;

        if (lost) throw new Error("lost build response");

        return Response.json({
          ...snapshot(),
          name: mode === "incomplete-name" ? undefined : name,
          imageName: mode === "incomplete-source" ? undefined : "alpine:3.21",
        });
      }

      if (url.pathname === "/api/snapshots/built-1") {
        idReads++;

        return Response.json({
          ...snapshot(),
          id: mode === "wrong-id" && idReads === 1 ? "other-id" : "built-1",
          organizationId: mode === "wrong-scope" && idReads === 1 ? "other-org" : "org-1",
          state:
            mode === "unnamed-pending" && idReads < 3
              ? "pending"
              : mode === "unknown-id" && idReads === 1
                ? "error"
                : mode === "pending-id" && idReads < 4
                  ? "pulling"
                  : lost
                    ? (["building", "pending", "pulling", "active"][observations + idReads - 1] ??
                      "active")
                    : "active",
        });
      }

      if (url.pathname.startsWith("/api/snapshots/")) {
        // A normal build can complete by ID before its name index catches up.
        if (!name || !lost) return new Response(null, { status: 404 });
        observations++;

        const states = ["building", "pending", "pulling", "active"];

        return Response.json({ ...snapshot(), state: states[observations - 1] ?? "active" });
      }

      if (url.pathname === "/api/sandbox" && init?.method === "POST") {
        creates++;

        const request = z
          .object({ name: z.string(), snapshot: z.literal(name || "built-1") })
          .parse(JSON.parse(String(init.body)));

        sandboxName = request.name;

        return Response.json({
          id: "native-built",
          name: sandboxName,
          organizationId: "org-1",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
        });
      }

      throw new Error("Unexpected fixture request");
    },
    { preconnect: fetch.preconnect },
  );

  const adapter = createDaytonaAdapter(fetchImpl);

  const connect = () =>
    Sandbar.connect({ adapter, config: { target: "us" }, credentials: { apiKey: "fixture" } });

  let client = await connect();

  try {
    await expect(client.images.build({ source: Image.oci("alpine:latest") })).rejects.toMatchObject(
      { code: "UNSUPPORTED" },
    );
    expect(builds).toBe(0);
    await expect(
      client.sandboxes.create({
        environment: Image.prepared("built-1"),
        labels: { "sandbar.imageSnapshot": "borrowed" },
        networkPolicy: "blocked",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(builds).toBe(0);
    expect(creates).toBe(0);
    const build = await client.images.submitBuild({ source: Image.oci("alpine:3.21") });

    if (lost) {
      expect(await build.observe()).toBeNull();

      await client.close();
      client = await connect();
    }

    if (mode === "wrong-source") {
      await expect((await client.recover(build.reference)).wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      expect(builds).toBe(1);
      expect(creates).toBe(0);

      return;
    }

    const result = lost ? await (await client.recover(build.reference)).wait() : await build.wait();

    const image = z
      .object({
        prepared: z.object({
          kind: z.literal("prepared"),
          value: z.string(),
          provider: z.string(),
          scope: z.object({
            authority: z.object({ kind: z.string(), id: z.string() }),
            partition: z.record(z.string(), z.string()),
          }),
        }),
        retainedResources: z.array(
          z.object({
            kind: z.string(),
            id: z.string(),
            ownership: z.literal("unknown"),
            cleanup: z.literal("manual"),
          }),
        ),
      })
      .parse(result);

    expect(image.prepared).toMatchObject({
      value: "built-1",
      provider: "daytona",
      scope: client.scope,
    });
    expect(image.retainedResources).toEqual([
      { kind: "daytona-snapshot", id: "built-1", ownership: "unknown", cleanup: "manual" },
    ]);
    expect(creates).toBe(0);
    await expect(
      client.sandboxes.create({
        environment: Image.prepared({ ...image.prepared, provider: "other" }),
        networkPolicy: "blocked",
      }),
    ).rejects.toThrow("scope differs");
    expect(creates).toBe(0);
    await client.sandboxes.create({
      environment: Image.prepared(image.prepared),
      networkPolicy: "blocked",
    });
    expect(builds).toBe(1);
    expect(creates).toBe(1);

    if (lost) {
      expect(observations).toBe(1);
      expect(idReads).toBe(4);
    }

    if (incomplete) {
      expect(idReads).toBeGreaterThan(0);
      expect(observations).toBe(0);
    }

    if (["unknown-id", "wrong-id", "wrong-scope"].includes(mode)) {
      expect(idReads).toBe(3);
      expect(observations).toBe(0);
    }

    if (mode === "pending-id") {
      expect(idReads).toBe(5);
      expect(observations).toBe(0);
    }
  } finally {
    await client.close();
  }
});

test("Daytona public adapter passes managed-compute scenarios with one native POST", async () => {
  const effects = { create: 0, destroy: 0, release: 0 };

  const records = new Map<
    string,
    {
      id: string;
      name: string;
      organizationId: string;
      target: string;
      state: string;
      networkBlockAll: boolean;
      public: boolean;
      labels: Record<string, string>;
    }
  >();

  let lose = false;
  let hold = false;
  let resume: (() => void) | undefined;

  // SAFETY: The test fixture controls the provider response shape.
  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([
          { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
          { id: "eu", name: "EU", regionType: "shared", organizationId: "org-1" },
        ]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (path === "/api/snapshots/snap-1")
        return Response.json({
          id: "snap-1",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us", "eu"],
          sandboxClass: "linux-vm",
        });

      if (path === "/api/sandbox" && init?.method === "POST") {
        effects.create++;
        const body = JSON.parse(String(init.body));

        const record = {
          id: `native-${effects.create}`,
          name: body.name,
          organizationId: "org-1",
          target: body.target,
          state: "started",
          networkBlockAll: true,
          public: false,
          labels: body.labels,
        };

        records.set(record.id, record);

        if (lose) {
          lose = false;
          throw new Error("response lost after native effect");
        }

        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }

        return Response.json(record);
      }

      if (path === "/api/sandbox" && init?.method === "GET") {
        const items = [...records.values()].filter(
          (record) => !url.searchParams.has("name") || record.name === url.searchParams.get("name"),
        );

        return Response.json({
          items: items.map(({ networkBlockAll: _block, public: _public, ...item }) => item),
        });
      }

      const match = /^\/api\/sandbox\/(native-[0-9]+)$/.exec(path);

      if (match) {
        const record = records.get(match[1]!);

        if (!record) return new Response(null, { status: 404 });

        if (init?.method === "DELETE") {
          effects.destroy++;
          record.state = "destroyed";
        }

        return Response.json(record);
      }

      throw new Error(`Unexpected Daytona fixture route ${path}`);
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

  const adapter = createDaytonaAdapter(fetchImpl);

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
      alternate: { config: { target: "eu" }, credentials: { apiKey: "fixture" } },
      createInput: { image: { kind: "prepared", value: "snap-1" }, networkPolicy: "blocked" },
      counters: () => ({ ...effects }),
      expectedReleasesPerConnection: 0,
      loseNextCreateResponse() {
        lose = true;
      },
      holdNextCreateResponse() {
        hold = true;
      },
      releaseHeldCreateResponse() {
        if (!resume) throw new Error("Native create was not held");
        resume();
      },
      assertNativeRetriesDisabled() {
        // The injected fetch is called directly by DaytonaDriver.request with no retry middleware.
        expect(effects.create).toBe(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
});

test("lost exec, write and destroy responses recover by read-only evidence after reconnect", async () => {
  const files = new Map<string, Uint8Array>();
  let state = "started";
  let execReads = 0;
  const mutations = { exec: 0, upload: 0, write: 0, destroy: 0 };

  const fetchImpl = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([
          { id: "us", name: "US", regionType: "shared", organizationId: "org-1" },
        ]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (path === "/api/sandbox/native-1") {
        const box = {
          id: "native-1",
          name: "box",
          organizationId: "org-1",
          target: "us",
          state,
          labels: state === "started" ? { "sandbar.imageSnapshot": "retained-1" } : undefined,
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        };

        if (init?.method === "DELETE") {
          mutations.destroy++;
          state = "destroying";
          throw new Error("delete response lost");
        }

        return Response.json(box);
      }

      if (path.endsWith("/files/upload-v2")) {
        mutations.upload++;
        const destination = url.searchParams.get("path")!;
        const form = init?.body;

        if (!(form instanceof FormData)) throw new Error("Expected multipart upload");
        const file = form.get("file");

        if (!(file instanceof Blob)) throw new Error("Expected uploaded Blob");
        files.set(destination, new Uint8Array(await file.arrayBuffer()));

        return Response.json({ path: destination, name: "blob", type: "file" });
      }

      if (path.endsWith("/files/download")) {
        if (url.searchParams.get("path")?.startsWith("/tmp/.sandbar-exec-")) {
          execReads++;

          if (execReads <= 2) return new Response("SANDBAR-EXEC-V1\n");
        }

        const bytes = files.get(url.searchParams.get("path")!);

        return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
      }

      if (path.endsWith("/process/execute")) {
        const command = z
          .object({ command: z.string() })
          .parse(JSON.parse(String(init?.body))).command;

        if (command.startsWith("mkdir -m 700 -- ") && !command.includes("SANDBAR-EXEC-V1"))
          return Response.json({ exitCode: 0, result: "" });

        if (command.includes("SANDBAR-EXEC-V1")) {
          mutations.exec++;
          const receipt = /\}\s*>\s*'([^']+)'; cat/.exec(command)?.[1];
          expect(receipt).toBeDefined();
          files.set(
            receipt!,
            new TextEncoder().encode(
              "SANDBAR-EXEC-V1\n0\n2\n0\n 00 ff\nSANDBAR-STDERR\nSANDBAR-END\n",
            ),
          );
          throw new Error("execution response lost");
        }

        mutations.write++;
        const link = /^ln -T -- '([^']+)' '([^']+)'/.exec(command);
        expect(link).not.toBeNull();
        files.set(link![2]!, files.get(link![1]!)!);
        files.delete(link![1]!);
        const marker = /printf '%s' '([^']+)' > '([^']+)'/.exec(command);
        expect(marker).not.toBeNull();
        const publish = /mv -f -- '([^']+)' '([^']+)'/.exec(command);
        expect(publish?.[1]).toBe(marker![2]);
        files.set(publish![2]!, new TextEncoder().encode(marker![1]!));
        throw new Error("write response lost");
      }

      throw new Error(`Unexpected fixture route ${path}`);
    },
    { preconnect: fetch.preconnect },
  );

  const adapter = createDaytonaAdapter(fetchImpl);

  const connect = () =>
    Sandbar.connect({ adapter, config: { target: "us" }, credentials: { apiKey: "fixture" } });

  const first = await connect();

  const submit = async (
    client: typeof first,
    kind: "exec" | "file_write" | "destroy",
    input: Parameters<typeof first.operations.prepare>[1],
    submissionId: string,
  ) => {
    const prepared = await client.operations.prepare(kind, input, { maxOutputBytes: 10 });

    let saved: { token: z.infer<ReturnType<typeof z.json>>; version: number } | undefined;

    const result = await prepared.submit(
      { operationId: `op-${submissionId}`, submissionId, invocationKey: `key-${submissionId}` },
      {
        beforeSubmit: async () => true,
        onCheckpoint: async (token, version) => {
          saved = { token: structuredClone(token), version };
        },
      },
    );

    expect(result?.kind).toBe("pending");

    if (result?.kind !== "pending") throw Error("Expected pending submission");

    if (kind === "destroy") {
      expect(saved).toBeDefined();

      return { ...result, token: saved!.token, version: saved!.version };
    }

    return result;
  };

  const exec = await submit(
    first,
    "exec",
    {
      sandbox: { id: "native-1" },
      command: { kind: "shell", script: "printf '\\000\\377'" },
      deadlineSeconds: 5,
      maxOutputBytes: 10,
    },
    "lost-exec",
  );

  const write = await submit(
    first,
    "file_write",
    {
      sandbox: { id: "native-1" },
      path: "/out",
      bytes: new Uint8Array([0, 255]),
      overwrite: false,
    },
    "lost-write",
  );

  await first.close();

  const reopened = await connect();

  if (exec.kind !== "pending") throw new Error("Expected pending exec");

  const expired = await reopened.operations.observe({
    scope: reopened.scope,
    kind: "exec",
    operationId: "op-lost-exec",
    submissionId: "lost-exec",
    sandboxId: "native-1",
    token: {
      ...z.object({ submissionId: z.string(), maxOutputBytes: z.number() }).parse(exec.token),
      receiptDeadline: 0,
    },
    tokenVersion: exec.version,
  });

  expect(expired?.kind).toBe("unknown");

  for (const [kind, result, submissionId] of [
    ["exec", exec, "lost-exec"],
    ["file_write", write, "lost-write"],
  ] as const) {
    if (result.kind !== "pending") throw new Error("Expected pending operation");

    const attempt = {
      scope: reopened.scope,
      kind,
      operationId: `op-${submissionId}`,
      submissionId,
      sandboxId: "native-1",
      token: result.token,
      tokenVersion: result.version,
    };

    let observed = await reopened.operations.observe(attempt);

    if (kind === "exec") {
      expect(observed?.kind).toBe("pending");
      observed = await reopened.operations.observe(attempt);
    }

    expect(observed?.kind).toBe("completed");
  }

  const destroy = await submit(reopened, "destroy", { id: "native-1" }, "lost-destroy");
  await reopened.close();
  const afterDestroy = await connect();

  if (destroy.kind !== "pending") throw new Error("Expected pending destroy");

  const destroyAttempt = {
    scope: afterDestroy.scope,
    kind: "destroy" as const,
    operationId: "op-lost-destroy",
    submissionId: "lost-destroy",
    sandboxId: "native-1",
    token: destroy.token,
    tokenVersion: destroy.version,
  };

  expect((await afterDestroy.operations.observe(destroyAttempt))?.kind).toBe("pending");
  state = "destroyed";

  const tokenless = await afterDestroy.operations.observe({
    ...destroyAttempt,
    token: undefined,
    tokenVersion: undefined,
  });

  expect(tokenless).toMatchObject({
    kind: "unknown",
    reason: "Daytona compute is stopped but retained resource evidence is unavailable",
  });
  const termination = await afterDestroy.operations.observe(destroyAttempt);

  expect(termination?.kind).toBe("completed");

  if (termination?.kind === "completed")
    expect(termination.value).toMatchObject({ retainedResources: ["daytona:snapshot:retained-1"] });
  expect(mutations).toEqual({ exec: 1, upload: 1, write: 1, destroy: 1 });
  await afterDestroy.close();
});

test("destroy preflight failure rejects without attempting DELETE", async () => {
  let deletes = 0;

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (init?.method === "DELETE") deletes++;
      throw new Error("preflight unavailable");
    },
    { preconnect: fetch.preconnect },
  );

  const client = await Sandbar.connect({
    adapter: createDaytonaAdapter(fetchImpl),
    config: { target: "us" },
    credentials: { apiKey: "fixture" },
  });

  try {
    await expect(client.operations.prepare("destroy", { id: "native-1" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      effect: "none",
    });
    expect(deletes).toBe(0);
  } finally {
    await client.close();
  }
});

test("exec receipt deadline starts after a slow preflight and survives reconnect", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  let submittedAt = 0;
  let executes = 0;

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (path === "/api/sandbox/native-1") {
        if (!executes) now += 20_000;

        return Response.json({
          id: "native-1",
          name: "box",
          organizationId: "org-1",
          target: "us",
          state: "started",
          public: false,
          networkBlockAll: true,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });
      }

      if (path.endsWith("/process/execute")) {
        executes++;
        submittedAt = now;
        throw new Error("response lost");
      }

      if (path.endsWith("/files/download")) return new Response("SANDBAR-EXEC-V1\n");
      throw new Error("Unexpected fixture request");
    },
    { preconnect: fetch.preconnect },
  );

  const connect = () =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

  let client = await connect();

  try {
    Date.now = () => now;

    const prepared = await client.operations.prepare(
      "exec",
      {
        sandbox: { id: "native-1" },
        command: { kind: "shell", script: "true" },
        deadlineSeconds: 5,
        maxOutputBytes: 10,
      },
      { maxOutputBytes: 10 },
    );

    const result = await prepared.submit(
      {
        operationId: "op-slow-preflight",
        submissionId: "slow-preflight",
        invocationKey: "key-slow-preflight",
      },
      { beforeSubmit: async () => true },
    );

    expect(result?.kind).toBe("pending");

    if (result?.kind !== "pending") throw new Error("Expected pending execution");
    expect(result.token).toMatchObject({ receiptDeadline: submittedAt + 15_000 });
    await client.close();
    client = await connect();
    now += 1000;

    const attempt = {
      scope: client.scope,
      kind: "exec" as const,
      operationId: "op-slow-preflight",
      submissionId: "slow-preflight",
      sandboxId: "native-1",
      token: result.token,
      tokenVersion: result.version,
    };

    expect((await client.operations.observe(attempt))?.kind).toBe("pending");

    const tokenless = await client.operations.observe({
      ...attempt,
      token: undefined,
      tokenVersion: undefined,
    });

    expect(tokenless).toMatchObject({
      kind: "unknown",
      reason: "Daytona execution receipt is incomplete",
    });
    now = submittedAt + 15_000;
    expect((await client.operations.observe(attempt))?.kind).toBe("unknown");
    expect(executes).toBe(1);
  } finally {
    Date.now = originalNow;
    await client.close();
  }
});

test("tokenless image recovery reports scoped possible retention without certifying source", async () => {
  let mutations = 0;
  let reads = 0;

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "POST") mutations++;

      if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (path === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (path === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (path === "/api/snapshots/sandbar-image-crash-build") {
        reads++;

        return Response.json({
          id: "possibly-retained",
          name: "sandbar-image-crash-build",
          organizationId: "org-1",
          imageName: "unproven:1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });
      }

      throw new Error("Unexpected fixture request");
    },
    { preconnect: fetch.preconnect },
  );

  const client = await Sandbar.connect({
    adapter: createDaytonaAdapter(fetchImpl),
    config: { target: "us" },
    credentials: { apiKey: "fixture" },
  });

  try {
    const result = await client.operations.observe({
      scope: client.scope,
      kind: "image_build",
      operationId: "op-crash-build",
      submissionId: "crash-build",
    });

    expect(result?.kind).toBe("unknown");

    if (result?.kind === "unknown")
      expect(result.reason).toContain(
        "possible retained resource daytona:snapshot:possibly-retained",
      );
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
  } finally {
    await client.close();
  }
});

test.each(["unavailable", "throw", "existing"] as const)(
  "image build preflight is effect-free: %s",
  async (mode) => {
    let posts = 0;

    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;

        if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (path === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (path === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (init?.method === "POST") posts++;

        if (mode === "throw") throw new Error("preflight unavailable");

        return new Response(null, { status: mode === "existing" ? 200 : 503 });
      },
      { preconnect: fetch.preconnect },
    );

    const client = await Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

    try {
      await expect(client.images.build({ source: Image.oci("alpine:3.21") })).rejects.toMatchObject(
        { code: "UNAVAILABLE", effect: "none" },
      );
      await expect(
        client.sandboxes.create({
          environment: Image.oci("alpine:3.21"),
          networkPolicy: "blocked",
        }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(posts).toBe(0);
    } finally {
      await client.close();
    }
  },
);

test.each(["lost-name", "known-id", "known-id-throw"] as const)(
  "image build discovery is pending only through the original deadline: %s",
  async (mode) => {
    const originalNow = Date.now;
    let now = originalNow();
    let submittedAt = 0;
    let builds = 0;
    let name = "";
    let discoverable = false;

    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;

        if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (path === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (path === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        const snapshot = {
          id: "discover-1",
          name,
          imageName: "alpine:3.21",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        };

        if (path === "/api/snapshots" && init?.method === "POST") {
          builds++;
          submittedAt = now;
          name = z.object({ name: z.string() }).parse(JSON.parse(String(init.body))).name;

          if (mode === "lost-name") throw new Error("build response lost");

          return Response.json({ ...snapshot, name });
        }

        if (path.startsWith("/api/snapshots/")) {
          if (!name) {
            now += 20_000;

            return new Response(null, { status: 404 });
          }

          if (!discoverable && mode === "known-id-throw") throw new Error("lookup unavailable");

          return discoverable
            ? Response.json({ ...snapshot, name })
            : new Response(null, { status: mode === "lost-name" ? 404 : 503 });
        }

        throw new Error("Unexpected request");
      },
      { preconnect: fetch.preconnect },
    );

    const connect = () =>
      Sandbar.connect({
        adapter: createDaytonaAdapter(fetchImpl),
        config: { target: "us" },
        credentials: { apiKey: "fixture" },
      });

    let client = await connect();

    try {
      Date.now = () => now;

      const prepared = await client.operations.prepare("image_build", {
        source: { kind: "oci", value: "alpine:3.21" },
      });

      const pending = await prepared.submit(
        { operationId: "op-discover", submissionId: "discover", invocationKey: "key-discover" },
        { beforeSubmit: async () => true },
      );

      if (pending?.kind !== "pending") throw new Error("Expected pending build");

      expect(pending.token).toMatchObject({ discoveryDeadline: submittedAt + 600_000 });
      await client.close();
      client = await connect();

      const attempt = {
        scope: client.scope,
        kind: "image_build" as const,
        operationId: "op-discover",
        submissionId: "discover",
        token: pending.token,
        tokenVersion: pending.version,
      };

      expect((await client.operations.observe(attempt))?.kind).toBe("pending");

      const legacyToken = { submissionId: "discover", image: "alpine:3.21" };

      expect(
        (
          await client.operations.observe({
            ...attempt,
            token: legacyToken,
          })
        )?.kind,
      ).toBe("unknown");
      now = submittedAt + 600_000;
      expect((await client.operations.observe(attempt))?.kind).toBe("unknown");
      discoverable = true;
      expect(await client.operations.observe(attempt)).toMatchObject({
        kind: "completed",
        value: { preparedId: "discover-1" },
      });
      expect(builds).toBe(1);
    } finally {
      Date.now = originalNow;
      await client.close();
    }
  },
);

test.each(["started", "stopped", "destroyed"])(
  "Daytona inspection maps %s from exactly one native read",
  async (state) => {
    let reads = 0;

    const fetchImpl: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;

        if (path === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (path === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (path === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (path === "/api/sandbox/native-1") {
          reads++;

          if (reads > 1) return new Response(null, { status: 404 });

          return Response.json({
            id: "native-1",
            name: "fixture-box",
            organizationId: "org-1",
            target: "us",
            state,
            public: false,
            networkBlockAll: true,
          });
        }

        throw new Error("Unexpected fixture route");
      },
      { preconnect: fetch.preconnect },
    );

    const client = await Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

    try {
      expect(await new AdapterSandbox(client, "native-1").inspect()).toMatchObject({
        state: state === "started" ? "running" : state,
      });
      expect(reads).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test.each([
  ["immediate", "matching"],
  ["immediate", "name"],
  ["immediate", "replacement-name"],
  ["immediate", "missing"],
  ["immediate", "wrong"],
  ["pending", "matching"],
  ["pending", "name"],
  ["pending", "replacement-name"],
  ["pending", "missing"],
  ["pending", "wrong"],
  ["lost", "matching"],
  ["lost", "name"],
  ["lost", "replacement-name"],
  ["lost", "missing"],
  ["lost", "wrong"],
] as const)("restore verifies native snapshot identity: %s / %s", async (path, evidence) => {
  let state = "started";
  let snapshotName = "";
  let restoreCreates = 0;
  let sourceName = "";
  let restoreName = "";
  let restoreLabels: Record<string, string> = {};
  let confirmed = evidence === "matching" || evidence === "name";

  const snapshot = () => ({
    id: "captured-1",
    general: false,
    name: snapshotName,
    organizationId: "org-1",
    state: "active",
    sandboxClass: "container",
    sourceSandboxId: "source",
    regionIds: ["us"],
  });

  const restored = (creating = false) => ({
    id: "restored",
    name: restoreName,
    organizationId: "org-1",
    target: "us",
    state: creating ? "creating" : "started",
    networkBlockAll: true,
    public: false,
    snapshot:
      creating || confirmed
        ? evidence === "name"
          ? snapshotName
          : "captured-1"
        : evidence === "missing"
          ? undefined
          : evidence === "replacement-name"
            ? snapshotName
            : "other-snapshot",
    labels: restoreLabels,
  });

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const route = url.pathname;

      if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (route === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (route === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (route === "/api/warm-pools") return Response.json([]);

      if (route === "/api/snapshots")
        return Response.json({ items: [snapshot()], page: 1, totalPages: 1 });

      if (route === "/api/snapshots/base")
        return Response.json({ ...snapshot(), id: "base", name: "base" });

      if (route.startsWith("/api/snapshots/"))
        return snapshotName
          ? Response.json({
              ...snapshot(),
              id:
                restoreCreates > 0 &&
                !confirmed &&
                evidence === "replacement-name" &&
                route.endsWith(snapshotName)
                  ? "replacement"
                  : "captured-1",
            })
          : new Response(null, { status: 404 });

      if (route === "/api/sandbox/source/stop" || route === "/api/sandbox/source/start") {
        state = route.endsWith("/stop") ? "stopped" : "started";

        return Response.json({});
      }

      if (route === "/api/sandbox/source/snapshot") {
        snapshotName = z.object({ name: z.string() }).parse(JSON.parse(String(init?.body))).name;

        return Response.json({ id: "source", state });
      }

      if (route === "/api/sandbox/source")
        return Response.json({
          id: "source",
          name: sourceName,
          organizationId: "org-1",
          target: "us",
          state,
          networkBlockAll: true,
          public: false,
          sandboxClass: "container",
          volumes: [],
        });

      if (route === "/api/sandbox" && method === "POST") {
        const body = z
          .object({
            name: z.string(),
            snapshot: z.string(),
            labels: z.record(z.string(), z.string()),
          })
          .parse(JSON.parse(String(init?.body)));

        if (body.snapshot === "base") {
          sourceName = body.name;

          return Response.json({
            id: "source",
            name: sourceName,
            organizationId: "org-1",
            target: "us",
            state,
            networkBlockAll: true,
            public: false,
            snapshot: "base",
            labels: body.labels,
          });
        }

        expect(body.snapshot).toBe("captured-1");
        restoreCreates++;
        restoreName = body.name;
        restoreLabels = body.labels;

        if (path === "lost") throw new Error("Lost restore acknowledgement");

        return Response.json(restored(path === "pending"));
      }

      if (route === "/api/sandbox") return Response.json({ items: [restored()] });

      if (route === "/api/sandbox/restored") return Response.json(restored());
      throw new Error(`Unexpected restore fixture route: ${method} ${route}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = () =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

  let client = await connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const capture = await source.snapshot();
    const listed = await client.snapshots.list({ limit: 10 });
    const capabilities = await client.capabilities();
    expect(listed.items[0]!.restore.networkPolicies).toEqual(
      (await capture.snapshot.inspect()).restore.networkPolicies,
    );
    expect(listed.items[0]!.restore.networkPolicies).toEqual(
      capabilities.snapshots.restore.status === "supported"
        ? capabilities.snapshots.restore.value.networkPolicies
        : [],
    );

    const operation = await capture.snapshot.submitRestore({
      networkPolicy: "blocked",
      resources: {},
      mounts: {},
    });

    const reference = structuredClone(operation.reference);

    if (!["matching", "name"].includes(evidence) || path === "lost")
      await expect(operation.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    else expect((await operation.wait()).id).toBe("restored");

    await client.close();
    client = await connect();
    const recovered = await client.recover(reference);

    if (!["matching", "name"].includes(evidence)) {
      await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      confirmed = true;
    }

    expect(await (await client.recover(reference)).wait()).toMatchObject({ id: "restored" });
    expect(restoreCreates).toBe(1);
  } finally {
    await client.close();
  }
});

test.each(["immediate", "pending", "lost"] as const)(
  "mounted create reuses one native detail per observation: %s",
  async (mode) => {
    let name = "";
    let labels: Record<string, string> = {};
    let detailReads = 0;
    let creates = 0;

    const native = (state = "started") => ({
      id: "mounted-box",
      name,
      labels,
      state,
      organizationId: "org-1",
      target: "us",
      networkBlockAll: true,
      public: false,
      volumes: [{ volumeId: "volume-1", mountPath: "/mnt/data", subpath: "fixture" }],
    });

    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const route = url.pathname;
        const method = init?.method ?? "GET";

        if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (route === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (route === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (route === "/api/snapshots/base")
          return Response.json({
            id: "base",
            organizationId: "org-1",
            state: "active",
            general: true,
            regionIds: ["us"],
            sandboxClass: "container",
          });

        if (route.startsWith("/api/volumes/by-name/")) return new Response(null, { status: 404 });

        if (route === "/api/volumes" || route === "/api/volumes/volume-1")
          return Response.json({
            id: "volume-1",
            name: "fixture-volume",
            organizationId: "org-1",
            state: "ready",
          });

        if (route === "/api/sandbox" && method === "POST") {
          const body = z
            .object({ name: z.string(), labels: z.record(z.string(), z.string()) })
            .parse(JSON.parse(String(init?.body)));

          name = body.name;
          labels = body.labels;
          creates++;

          if (mode === "lost") throw new Error("Lost create acknowledgement");

          return Response.json(native(mode === "pending" ? "starting" : "started"));
        }

        if (route === "/api/sandbox") return Response.json({ items: [native()] });

        if (route === "/api/sandbox/mounted-box") {
          detailReads++;

          if (detailReads > (mode === "pending" ? 2 : 1))
            throw new Error("Redundant detail read failed");

          return Response.json(
            native(mode === "pending" && detailReads === 1 ? "starting" : "started"),
          );
        }

        throw new Error(`Unexpected route ${route}`);
      },
      { preconnect: fetch.preconnect },
    );

    const client = await Sandbar.connect({
      adapter: createDaytonaAdapter(fetcher),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

    try {
      const volume = await client.volumes.create({ name: "fixture-volume" });
      const mounts = [volume.at("/mnt/data", { subpath: "fixture" })];

      const operation = await client.sandboxes.submitCreate({
        environment: Image.prepared("base"),
        mounts,
      });

      if (mode === "lost")
        await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);

      const box =
        mode === "lost"
          ? await (await client.recover(operation.reference)).wait()
          : await operation.wait();

      expect(box).toMatchObject({ id: "mounted-box" });
      expect(creates).toBe(1);
      expect(detailReads).toBe(mode === "pending" ? 2 : 1);
    } finally {
      await client.close();
    }
  },
);

test.each([
  [497, "tombstone"],
  [498, "tombstone"],
  [512, "tombstone"],
  [512, "absence"],
] as const)(
  "Daytona confirmed mounted destroy preserves bounded retained identity: %s / %s",
  async (size, confirmation) => {
    const volumeId = "v".repeat(size);
    let deleted = false;
    let deletes = 0;

    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = new URL(String(input)).pathname;

        if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (route === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (route === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (route === "/api/sandbox/mounted-box") {
          if (init?.method === "DELETE") {
            deletes++;
            deleted = true;

            return Response.json({});
          }

          if (deleted && confirmation === "absence") return new Response(null, { status: 404 });

          return Response.json({
            id: "mounted-box",
            name: "fixture",
            labels: {},
            state: deleted ? "destroyed" : "started",
            organizationId: "org-1",
            target: "us",
            networkBlockAll: true,
            public: false,
            volumes: [{ volumeId, mountPath: "/mnt/data" }],
          });
        }

        throw new Error(`Unexpected fixture route: ${route}`);
      },
      { preconnect: fetch.preconnect },
    );

    const client = await Sandbar.connect({
      adapter: createDaytonaAdapter(fetcher),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
    });

    try {
      const result = await new AdapterSandbox(client, "mounted-box").destroy({
        storage: "allow-unconfirmed",
      });

      expect(result.computeStopped).toBe(true);
      expect(result.retainedResources[0]).toBe(
        size <= 497 ? `daytona-volume:${volumeId}` : volumeId,
      );
      expect(result.retainedResources[0]!.length).toBeLessThanOrEqual(512);
      expect(result.mountDurability?.[0]!.volume.nativeId).toBe(volumeId);
      expect(deletes).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test.each(["prepare", "submit"] as const)(
  "Daytona oversized destroy custody rejects before DELETE: %s",
  async (stage) => {
    let expanded = stage === "prepare";
    let deletes = 0;
    let saved: AdapterRecoveryReference | undefined;

    const longMounts = Array.from({ length: 8 }, (_, index) => ({
      volumeId: `v${index}${"x".repeat(510)}`,
      mountPath: `/mnt/${index}`,
    }));

    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = new URL(String(input)).pathname;

        if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (route === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (route === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (route === "/api/sandbox/mounted-box") {
          if (init?.method === "DELETE") {
            deletes++;

            return Response.json({});
          }

          return Response.json({
            id: "mounted-box",
            name: "fixture",
            labels: {},
            state: "started",
            organizationId: "org-1",
            target: "us",
            networkBlockAll: true,
            public: false,
            volumes: expanded ? longMounts : [{ volumeId: "short", mountPath: "/mnt/short" }],
          });
        }

        throw new Error(`Unexpected fixture route: ${route}`);
      },
      { preconnect: fetch.preconnect },
    );

    const client = await Sandbar.connect({
      adapter: createDaytonaAdapter(fetcher),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
      onReference(reference) {
        if (reference.kind !== "destroy") return;
        saved = structuredClone(reference);

        if (!reference.token) expanded = true;
      },
    });

    try {
      await expect(
        new AdapterSandbox(client, "mounted-box").destroy({ storage: "allow-unconfirmed" }),
      ).rejects.toMatchObject(
        stage === "prepare" ? { code: "CAPACITY" } : { code: "CAPACITY", effect: "none" },
      );
      expect(deletes).toBe(0);

      if (stage === "prepare") expect(saved).toBeUndefined();
      else {
        expect(saved?.token).toMatchObject({ stage: "rejected", rejectionCode: "CAPACITY" });
        const recovered = await client.recover(saved!);
        await expect((await recovered.continue()).wait()).rejects.toMatchObject({
          code: "CAPACITY",
          effect: "none",
        });
        expect(deletes).toBe(0);
      }
    } finally {
      await client.close();
    }
  },
);

async function interruptedMountedDestroy(mode: "tombstone" | "absent") {
  let deleted = false;
  let deletes = 0;
  let saved: AdapterRecoveryReference | undefined;
  const abort = new AbortController();

  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;

      if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (route === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (route === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (route === "/api/sandbox/mounted-box") {
        if (init?.method === "DELETE") {
          expect(saved?.token).toMatchObject({
            sandboxId: "mounted-box",
            stage: "uncertain",
            mountDurability: [{ volume: { nativeId: "retained-volume" } }],
          });
          deletes++;
          deleted = true;
          abort.abort();

          return new Promise<Response>(() => undefined);
        }

        if (deleted && mode === "absent") return new Response(null, { status: 404 });

        return Response.json({
          id: "mounted-box",
          name: "fixture",
          labels: {},
          state: deleted ? "destroyed" : "started",
          organizationId: "org-1",
          target: "us",
          networkBlockAll: true,
          public: false,
          volumes: [{ volumeId: "retained-volume", mountPath: "/mnt/data" }],
        });
      }

      throw new Error(`Unexpected fixture route: ${route}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = () =>
    Sandbar.connect({
      adapter: createDaytonaAdapter(fetcher),
      config: { target: "us" },
      credentials: { apiKey: "fixture" },
      onReference(reference) {
        saved = structuredClone(reference);
      },
    });

  const client = await connect();

  try {
    await expect(
      new AdapterSandbox(client, "mounted-box").destroy({
        storage: "allow-unconfirmed",
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED" });
    expect(deletes).toBe(1);
    expect(saved).toBeDefined();
    const reopened = await connect();

    try {
      const persisted = structuredClone(saved!);
      expect(persisted.token).toMatchObject({ stage: "uncertain" });

      if (mode === "absent") {
        const legacy = structuredClone(persisted);

        const token = z.object({ stage: z.string().optional() }).passthrough().parse(legacy.token);

        delete token.stage;
        legacy.token = z.json().parse(token);
        const old = await reopened.recover(legacy);
        await expect(old.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      }

      const recovered = await (await reopened.recover(persisted)).wait();
      expect(recovered).toMatchObject({
        computeStopped: true,
        retainedResources: ["daytona-volume:retained-volume"],
        mountDurability: [{ volume: { nativeId: "retained-volume" }, status: "unconfirmed" }],
      });
      expect(deletes).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await client.close();
  }
}

test.each(["tombstone", "absent"] as const)(
  "Daytona interrupted mounted destroy retains custody before DELETE: %s",
  interruptedMountedDestroy,
);

for (const mode of ["gateway", "abort", "policy"] as const) {
  test(`Daytona pre-dispatch destroy rejection survives recovery: ${mode}`, async () => {
    let armed = false;
    let reads = 0;
    let deletes = 0;
    let saved: AdapterRecoveryReference | undefined;
    const controller = new AbortController();

    const fetcher = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = new URL(String(input)).pathname;

        if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

        if (route === "/api/regions")
          return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

        if (route === "/api/organizations/org-1")
          return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

        if (route === "/api/sandbox/pre-delete") {
          if (init?.method === "DELETE") {
            deletes++;

            return new Response(null, { status: 204 });
          }

          reads++;

          if (armed && mode !== "policy") {
            if (mode === "abort") {
              controller.abort();
              throw controller.signal.reason;
            }

            return new Response(null, { status: 503 });
          }

          return Response.json({
            id: "pre-delete",
            name: "fixture",
            labels: {},
            state: "started",
            organizationId: "org-1",
            target: "us",
            networkBlockAll: true,
            public: false,
            volumes:
              armed && mode === "policy" ? [{ volumeId: "retained", mountPath: "/mnt/data" }] : [],
          });
        }

        throw Error(`Unexpected fixture route ${route}`);
      },
      { preconnect: fetch.preconnect },
    );

    const connect = () =>
      Sandbar.connect({
        adapter: createDaytonaAdapter(fetcher),
        config: { target: "us" },
        credentials: { apiKey: "fixture" },
        onReference(reference) {
          if (reference.kind !== "destroy") return;
          saved = structuredClone(reference);

          if (!reference.token) armed = true;
        },
      });

    const client = await connect();

    try {
      try {
        await new AdapterSandbox(client, "pre-delete").destroy({ signal: controller.signal });
        throw Error("Expected pre-dispatch failure");
      } catch (error) {
        expect(
          error instanceof WaitAbortedError ||
            (error instanceof SandbarError && error.effect === "none"),
        ).toBe(true);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(saved?.token).toMatchObject({ sandboxId: "pre-delete", stage: "rejected" });
      expect(deletes).toBe(0);
      const before = reads;
      const reopened = await connect();

      try {
        const recovered = await reopened.recover(saved!);
        await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
        await recovered.continue();
        await expect(recovered.wait()).rejects.toMatchObject({
          code: mode === "policy" ? "UNSUPPORTED" : "UNAVAILABLE",
          effect: "none",
        });
        expect(reads).toBe(before);
        expect(deletes).toBe(0);
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  });
}
