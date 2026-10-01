import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, ResourceReference, type SnapshotInfo } from "sandbar-adapter";
import {
  AdapterSandbox,
  AdapterSnapshot,
  AdapterVolume,
  Sandbar,
  SandbarError,
  UnsupportedFeatureError,
} from "./index";

async function fixture() {
  let reads = 0;
  let mutations = 0;
  let malformed = false;
  const scope = { authority: { kind: "account", id: "one" }, partition: {} };

  const reference = ResourceReference.parse({
    version: 1,
    kind: "snapshot",
    provider: "fixture.api",
    scope,
    nativeId: "snapshot",
    ownership: "unknown",
  });

  const info: SnapshotInfo = {
    reference,
    preserve: "filesystem",
    restoreExecution: "fresh",
    consistency: "unknown",
    source: null,
    state: "ready",
    createdAt: null,
    expiration: "unknown",
    excludedPaths: null,
    mounts: [],
    mountHandling: "none",
    restore: {
      networkPolicies: ["blocked"],
      resources: false,
      mounts: true,
      independentLifecycle: false,
    },
    dependencies: [],
    nativeDependencies: null,
  };

  const adapter = defineAdapter({
    name: "fixture.api",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async snapshotInspect() {
          reads++;

          return malformed ? JSON.parse("{}") : structuredClone(info);
        },
        async snapshotProfiles() {
          reads++;

          return { status: "unsupported" as const, reason: "fixture" };
        },
        async snapshotList() {
          reads++;

          return { items: [], coverage: "provider-scope" as const };
        },
        async volumeList() {
          reads++;

          return { items: [], coverage: "provider-scope" as const };
        },
        async snapshotCapture() {
          mutations++;
          throw new Error("Unexpected capture");
        },
        async snapshotRestore() {
          mutations++;
          throw new Error("Unexpected restore");
        },
        async volumeCreate() {
          mutations++;
          throw new Error("Unexpected volume create");
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  return {
    client,
    info,
    snapshot: new AdapterSnapshot(client, reference),
    volume: new AdapterVolume(client, { ...reference, kind: "volume", nativeId: "volume" }),
    sandbox: new AdapterSandbox(client, "box"),
    reads: () => reads,
    mutations: () => mutations,
    malform: () => {
      malformed = true;
    },
  };
}

test("resource caller errors normalize before provider reads or mutation", async () => {
  const f = await fixture();
  const bad = JSON.parse("null");

  const actions = [
    () => f.snapshot.restore(bad),
    () => f.snapshot.submitRestore({ networkPolicy: "blocked", resources: { vcpu: 0 } }),
    () => f.client.volumes.create(bad),
    () => f.client.volumes.submitCreate({ name: "bad name" }),
    () => f.client.snapshots.list(bad),
    () => f.client.volumes.list({ limit: 0 }),
    () => f.sandbox.snapshot(bad),
    () => f.sandbox.submitSnapshot(JSON.parse('{"consistency":"invalid"}')),
    () => f.sandbox.checkSnapshot(bad),
    async () => f.volume.at("relative"),
    async () => f.volume.at("/mnt/data", { subpath: "../escape" }),
  ];

  try {
    for (const action of actions) {
      await expect(Promise.resolve().then(action)).rejects.toBeInstanceOf(SandbarError);
      await expect(Promise.resolve().then(action)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        effect: "none",
      });
    }

    expect(f.reads()).toBe(0);
    expect(f.mutations()).toBe(0);
  } finally {
    await f.client.close();
  }
});

test("restore reports every unmet guarantee and rejects compatibility mount choices", async () => {
  const f = await fixture();

  try {
    await expect(
      f.snapshot.restore({ networkPolicy: "all", resources: { vcpu: 2 } }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      effect: "none",
      feature: "snapshot restore",
      unmetRequirements: [
        "Network policy 'all' is unsupported",
        "Resource sizing overrides are unsupported",
        "Independent lifecycle is required but unsupported",
      ],
    });

    for (const action of ["share", "omit", "replace"] as const) {
      const choice =
        action === "replace" ? { action, mount: f.volume.at("/mnt/data") } : { action };

      await expect(
        f.snapshot.restore({
          networkPolicy: "blocked",
          requireIndependentLifecycle: false,
          mounts: { "/mnt/data": choice },
        }),
      ).rejects.toBeInstanceOf(UnsupportedFeatureError);
      await expect(
        f.snapshot.restore({
          networkPolicy: "blocked",
          requireIndependentLifecycle: false,
          mounts: { "/mnt/data": choice },
        }),
      ).rejects.toMatchObject({
        effect: "none",
        unmetRequirements: [expect.stringContaining("Snapshot mount restore is not implemented")],
      });
    }

    for (const provenance of ["unknown", "excluded"] as const) {
      f.info.mountHandling = provenance;
      await expect(
        f.snapshot.restore({
          networkPolicy: "blocked",
          requireIndependentLifecycle: false,
          mounts: {},
        }),
      ).rejects.toMatchObject({
        unmetRequirements: [expect.stringContaining("capture mount provenance is")],
      });
    }

    f.info.mountHandling = "none";
    f.info.mounts = [f.volume.at("/mnt/data")];
    await expect(
      f.snapshot.restore({ networkPolicy: "blocked", requireIndependentLifecycle: false }),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(f.mutations()).toBe(0);
  } finally {
    await f.client.close();
  }
});

test("malformed native snapshot metadata stays distinct from caller input errors", async () => {
  const f = await fixture();

  try {
    f.malform();
    await expect(f.snapshot.restore({ networkPolicy: "blocked" })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(f.reads()).toBe(1);
    expect(f.mutations()).toBe(0);
  } finally {
    await f.client.close();
  }
});
