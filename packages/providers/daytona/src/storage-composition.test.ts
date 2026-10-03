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
      const source = await client.sandboxes.create({
        environment: Image.prepared("base"),
        networkPolicy: "daytona-default",
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

      const operation = await snapshotHandle.submitRestore({
        networkPolicy: "daytona-default",
        mounts,
      });

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
