import { expect, test } from "bun:test";
import { z } from "zod";
import { adapterSuite } from "sandbar-adapter/testing";
import { createDaytonaAdapter } from "./adapter";
import { Sandbar, Image, AdapterSandbox } from "sandbar-sdk";

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

    const result = await prepared.submit(
      { operationId: `op-${submissionId}`, submissionId, invocationKey: `key-${submissionId}` },
      { beforeSubmit: async () => true },
    );

    expect(result?.kind).toBe("pending");

    return result!;
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
