import { expect, test } from "bun:test";
import { z } from "zod";
import { Sandbar, Image, SandbarError } from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

test.each([
  "matching",
  "missing",
  "extra",
  "read",
  "lost",
  "metadata",
  "policy",
  "snapshot",
  "error",
  "pending-read",
  "not-ready",
  "replacement",
  "checkpoint",
] as const)(
  "mounted restore selects exact IDs after source deletion and retains uncertainty: %s",
  async (mode) => {
    let state = "started";
    let sourceGone = false;
    let selected: { volumeId: string; mountPath: string; subpath?: string }[] = [];
    let fault: string = mode;
    let posts = 0;
    let volumeReady = true;
    let detailReads = 0;
    let snapshotName = "";
    let sourceName = "";
    let restoreName = "";
    let restoreLabels: Record<string, string> = {};

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

    function nativeMounts() {
      if (["missing", "replacement"].includes(fault)) return [];

      if (fault === "extra") return [...selected, { volumeId: "extra", mountPath: "/extra" }];

      return selected;
    }

    const restored = (creating = false) => ({
      id: fault === "replacement-observed" ? "replacement-box" : "restored",
      name: restoreName,
      organizationId: "org-1",
      target: "us",
      state: fault === "error" ? "error" : creating ? "creating" : "started",
      networkBlockAll: fault === "policy",
      public: false,
      snapshot: fault === "snapshot" ? "wrong" : "captured-1",
      labels: restoreLabels,
      volumes: nativeMounts(),
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
          return snapshotName ? Response.json(snapshot()) : new Response(null, { status: 404 });

        if (route === "/api/sandbox/source/stop" || route === "/api/sandbox/source/start") {
          state = route.endsWith("/stop") ? "stopped" : "started";

          return Response.json({});
        }

        if (route === "/api/sandbox/source/snapshot") {
          snapshotName = z.object({ name: z.string() }).parse(JSON.parse(String(init?.body))).name;

          return Response.json({ id: "source", state });
        }

        if (route.startsWith("/api/volumes/"))
          return Response.json({
            id: "volume-1",
            name: "data",
            organizationId: "org-1",
            state: volumeReady ? "ready" : "creating",
          });

        if (route === "/api/sandbox/source")
          return sourceGone
            ? new Response(null, { status: 404 })
            : Response.json({
                id: "source",
                name: sourceName,
                organizationId: "org-1",
                target: "us",
                state,
                networkBlockAll: false,
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
              volumes: z
                .array(
                  z.object({
                    volumeId: z.string(),
                    mountPath: z.string(),
                    subpath: z.string().optional(),
                  }),
                )
                .optional(),
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
              networkBlockAll: false,
              public: false,
              snapshot: "base",
              labels: body.labels,
            });
          }

          expect(body.snapshot).toBe("captured-1");
          selected = body.volumes ?? [];
          posts++;
          restoreName = body.name;
          restoreLabels = body.labels;

          if (fault === "lost") throw new Error("Lost restore acknowledgement");

          const receipt = restored(fault === "pending-read");

          if (fault === "metadata")
            return Response.json({ ...receipt, networkBlockAll: undefined });

          return Response.json(receipt);
        }

        if (route === "/api/sandbox") return Response.json({ items: [restored()] });

        if (route === "/api/sandbox/restored" || route === "/api/sandbox/replacement-box") {
          if (fault === "read" || (fault === "pending-read" && detailReads++ > 0))
            throw new Error("Detail unavailable");

          return Response.json(restored(fault === "pending-read"));
        }

        throw new Error(`Unexpected restore fixture route: ${method} ${route}`);
      },
      { preconnect: fetch.preconnect },
    );

    const connect = () =>
      Sandbar.connect({
        adapter: createDaytonaAdapter(fetchImpl),
        config: { target: "us", networkPolicy: "daytona-default" },
        credentials: { apiKey: "fixture" },
        onReference: async (ref) => {
          if (fault === "not-ready" && ref.kind === "snapshot_restore") volumeReady = false;

          if (fault === "checkpoint" && ref.kind === "snapshot_restore" && posts > 0)
            throw Error("Custody save failed");
        },
      });

    let client = await connect();

    try {
      const mismatch = { environment: Image.prepared("base"), networkPolicy: "blocked" };
      expect(await client.sandboxes.checkCreate(mismatch)).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("daytona-default"),
      });

      for (const call of [client.sandboxes.create, client.sandboxes.submitCreate]) {
        await expect(call(mismatch)).rejects.toMatchObject({
          code: "UNSUPPORTED",
          message: expect.stringContaining("separate connection"),
        });
      }

      expect(posts).toBe(0);

      const source = await client.sandboxes.create({
        environment: Image.prepared("base"),
      });

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

      const saved = JSON.parse(JSON.stringify(capture.snapshot.reference));
      sourceGone = true;
      await client.close();
      client = await connect();
      const snapshotHandle = await client.snapshots.get(saved);

      const volume = await client.volumes.get({
        version: 1,
        kind: "volume",
        provider: "daytona",
        scope: snapshotHandle.reference.scope,
        nativeId: "volume-1",
        ownership: "unknown",
      });

      const mounts = [volume.at("/data", { subpath: "tenant" })];

      await expect(snapshotHandle.restore({ networkPolicy: "blocked" })).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: expect.stringContaining("daytona-default"),
      });
      await expect(
        snapshotHandle.submitRestore({ networkPolicy: "blocked" }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: expect.stringContaining("separate connection"),
      });

      for (const bad of [
        { networkPolicy: "blocked", mounts },
        { networkPolicy: "daytona-default", mounts: [volume.at("/data", { access: "read-only" })] },
        { networkPolicy: "daytona-default", mounts: [...mounts, volume.at("/data/nested")] },
      ]) {
        await expect(snapshotHandle.restore(bad)).rejects.toMatchObject({
          code: "UNSUPPORTED",
          effect: "none",
        });
      }

      expect(posts).toBe(0);

      if (mode === "checkpoint") {
        let savedReference;

        try {
          await snapshotHandle.submitRestore({ networkPolicy: "daytona-default", mounts });
          throw Error("Expected custody save failure");
        } catch (error) {
          expect(error).toMatchObject({
            code: "REFERENCE_SAVE_FAILED",
            outcome: { kind: "snapshot_restore", mounts, sandbox: { nativeId: "restored" } },
          });

          if (!(error instanceof SandbarError)) throw error;

          savedReference = error.reference;
        }

        if (!savedReference) throw Error("Missing recovery reference");

        fault = "matching";
        await client.close();
        client = await connect();
        expect(await (await client.recover(savedReference)).wait()).toMatchObject({
          id: "restored",
        });
        expect(posts).toBe(1);

        return;
      }

      const operation = await snapshotHandle.submitRestore({ mounts });
      expect(operation.reference.networkPolicy).toBe("daytona-default");

      expect(operation.reference.mounts).toEqual(mounts);

      if (mode === "not-ready") {
        await expect(operation.wait()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        expect(posts).toBe(0);

        return;
      }

      if (mode === "matching") {
        const box = await operation.wait();
        expect(box.id).toBe("restored");
        expect(box.reference).not.toHaveProperty("mounts");
        expect(selected).toEqual([{ volumeId: "volume-1", mountPath: "/data", subpath: "tenant" }]);
      } else {
        await expect(operation.wait()).rejects.toMatchObject({
          code: "OUTCOME_UNKNOWN",
          outcome: {
            kind: "snapshot_restore",
            mounts,
          },
        });

        if (mode !== "lost")
          expect(operation.reference.token).toMatchObject({ sandboxId: "restored" });

        if (mode === "replacement") {
          fault = "replacement-observed";
          await client.close();
          client = await connect();
          await expect(
            (await client.recover(JSON.parse(JSON.stringify(operation.reference)))).wait(),
          ).rejects.toMatchObject({
            code: "OUTCOME_UNKNOWN",
            outcome: { sandbox: { nativeId: "restored" } },
          });
        }

        fault = "matching";
        await client.close();
        client = await connect();

        const box = await (
          await client.recover(JSON.parse(JSON.stringify(operation.reference)))
        ).wait();

        expect(box).toMatchObject({ id: "restored" });
      }

      expect(posts).toBe(1);
    } finally {
      await client.close();
    }
  },
);

test("Linux VM cold capture restores unmounted and rejects mounted restore before effects", async () => {
  let state = "started";
  let snapshotName = "";
  let restoreLabels: Record<string, string> = {};
  let sourceLabels: Record<string, string> = {};
  const names: Record<string, string> = {};
  let restores = 0;

  const vm = (id: string, labels: Record<string, string>, snapshot: string) => ({
    id,
    name: names[id] ?? "",
    organizationId: "org-1",
    target: "us",
    state: id === "source" ? state : "started",
    networkBlockAll: false,
    public: false,
    sandboxClass: "linux-vm",
    snapshot,
    labels,
    volumes: [],
  });

  const snapshot = () => ({
    id: "captured-vm",
    general: false,
    name: snapshotName,
    organizationId: "org-1",
    state: "active",
    sandboxClass: "linux-vm",
    sourceSandboxId: "source",
    regionIds: ["us"],
  });

  const fetchImpl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";

      if (route === "/api/api-keys/current") return Response.json({ organizationId: "org-1" });

      if (route === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (route === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (route === "/api/warm-pools") return Response.json([]);

      if (route === "/api/snapshots/vm-base")
        return Response.json({ ...snapshot(), id: "vm-base", name: "vm-base" });

      if (route.startsWith("/api/snapshots/"))
        return snapshotName ? Response.json(snapshot()) : new Response(null, { status: 404 });

      if (route.startsWith("/api/volumes/"))
        return Response.json({
          id: "volume-1",
          name: "data",
          organizationId: "org-1",
          state: "ready",
        });

      if (route === "/api/sandbox/source/stop" || route === "/api/sandbox/source/start") {
        state = route.endsWith("/stop") ? "stopped" : "started";

        return Response.json({});
      }

      if (route === "/api/sandbox/source/snapshot") {
        const body = z
          .object({ name: z.string(), includeMemory: z.literal(false) })
          .parse(JSON.parse(String(init?.body)));

        expect(state).toBe("stopped");
        snapshotName = body.name;

        return Response.json({ id: "source", state });
      }

      if (route === "/api/sandbox/source")
        return Response.json(vm("source", sourceLabels, "vm-base"));

      if (route === "/api/sandbox/restored")
        return Response.json(vm("restored", restoreLabels, "captured-vm"));

      if (route === "/api/sandbox" && method === "POST") {
        const body = z
          .object({
            name: z.string(),
            snapshot: z.string(),
            labels: z.record(z.string(), z.string()),
          })
          .parse(JSON.parse(String(init?.body)));

        names[body.snapshot === "vm-base" ? "source" : "restored"] = body.name;

        if (body.snapshot === "vm-base") {
          sourceLabels = body.labels;

          return Response.json(vm("source", sourceLabels, "vm-base"));
        }

        expect(body.snapshot).toBe("captured-vm");
        restores++;
        restoreLabels = body.labels;

        return Response.json(vm("restored", restoreLabels, "captured-vm"));
      }

      throw new Error(`Unexpected VM fixture route: ${method} ${route}`);
    },
    { preconnect: fetch.preconnect },
  );

  const client = await Sandbar.connect({
    adapter: createDaytonaAdapter(fetchImpl),
    config: { target: "us", networkPolicy: "daytona-default" },
    credentials: { apiKey: "fixture" },
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("vm-base") });
    const capture = await source.snapshot();
    expect(capture.capture).toEqual({
      preserve: "filesystem",
      interruption: "stop",
      restoreExecution: "fresh",
    });
    const info = await capture.snapshot.inspect();
    expect(info).toMatchObject({ preserve: "filesystem", restore: { mounts: false } });

    const volume = await client.volumes.get({
      version: 1,
      kind: "volume",
      provider: "daytona",
      scope: capture.snapshot.reference.scope,
      nativeId: "volume-1",
      ownership: "unknown",
    });

    await expect(
      capture.snapshot.restore({ networkPolicy: "daytona-default", mounts: [volume.at("/data")] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect(restores).toBe(0);

    const restored = await capture.snapshot.restore({ networkPolicy: "daytona-default" });
    expect(restored.id).toBe("restored");
    expect(restores).toBe(1);
  } finally {
    await client.close();
  }
});
