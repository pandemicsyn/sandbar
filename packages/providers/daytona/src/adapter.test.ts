import { expect, test } from "bun:test";
import { z } from "zod";
import { adapterSuite } from "sandbar-adapter/testing";
import { createDaytonaAdapter } from "./adapter";
import { Sandbar, Image } from "sandbar-sdk";

test.each([false, true])(
  "explicit image build is scoped and never creates a sandbox: lost=%s",
  async (lost) => {
    let builds = 0;
    let creates = 0;
    let name = "";
    let sandboxName = "";

    const snapshot = () => ({
      id: "built-1",
      name,
      imageName: "alpine:3.21",
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

          return Response.json(snapshot());
        }

        if (url.pathname.startsWith("/api/snapshots/"))
          return name &&
            [name, "built-1"].includes(decodeURIComponent(url.pathname.split("/").at(-1)!))
            ? Response.json(snapshot())
            : new Response(null, { status: 404 });

        if (url.pathname === "/api/sandbox" && init?.method === "POST") {
          creates++;

          const request = z
            .object({ name: z.string(), snapshot: z.literal("built-1") })
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
      await expect(
        client.images.build({ source: Image.oci("alpine:latest") }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(builds).toBe(0);
      const build = await client.images.submitBuild({ source: Image.oci("alpine:3.21") });

      if (lost) {
        await expect(build.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
        await client.close();
        client = await connect();
      }

      const result = lost
        ? await (await client.recover(build.reference)).wait()
        : await build.wait();

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
    } finally {
      await client.close();
    }
  },
);

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
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        };

        if (init?.method === "DELETE") {
          mutations.destroy++;
          state = "destroyed";
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
        const bytes = files.get(url.searchParams.get("path")!);

        return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
      }

      if (path.endsWith("/process/execute")) {
        const command = z
          .object({ command: z.string() })
          .parse(JSON.parse(String(init?.body))).command;

        if (command.startsWith("{ ")) {
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
        files.set(marker![2]!, new TextEncoder().encode(marker![1]!));
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

  for (const [kind, result, submissionId] of [
    ["exec", exec, "lost-exec"],
    ["file_write", write, "lost-write"],
  ] as const) {
    if (result.kind !== "pending") throw new Error("Expected pending operation");

    const observed = await reopened.operations.observe({
      scope: reopened.scope,
      kind,
      operationId: `op-${submissionId}`,
      submissionId,
      sandboxId: "native-1",
      token: result.token,
      tokenVersion: result.version,
    });

    expect(observed?.kind).toBe("completed");
  }

  const destroy = await submit(reopened, "destroy", { id: "native-1" }, "lost-destroy");
  await reopened.close();
  const afterDestroy = await connect();

  if (destroy.kind !== "pending") throw new Error("Expected pending destroy");

  const termination = await afterDestroy.operations.observe({
    scope: afterDestroy.scope,
    kind: "destroy",
    operationId: "op-lost-destroy",
    submissionId: "lost-destroy",
    sandboxId: "native-1",
    token: destroy.token,
    tokenVersion: destroy.version,
  });

  expect(termination?.kind).toBe("completed");
  expect(mutations).toEqual({ exec: 1, upload: 1, write: 1, destroy: 1 });
  await afterDestroy.close();
});
