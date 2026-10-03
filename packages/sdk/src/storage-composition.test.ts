import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type SnapshotInfo } from "sandbar-adapter";
import { AdapterSnapshot, AdapterVolume, Sandbar } from "./index";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const reference = {
  version: 1 as const,
  kind: "snapshot" as const,
  provider: "fixture.storage",
  scope,
  nativeId: "snapshot",
  ownership: "unknown" as const,
};

test.each(["missing", "specs"] as const)("restore hook array compatibility: %s", async (marker) => {
  let prepares = 0;
  let submits = 0;
  let preparedMounts: unknown;

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
    dependencies: [],
    nativeDependencies: null,
    restore: {
      networkPolicies: ["blocked"],
      resources: false,
      mounts: true,
      independentLifecycle: true,
    },
  };

  const adapter = defineAdapter({
    name: reference.provider,
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async snapshotInspect() {
          return info;
        },
        snapshotRestore: {
          mountInput: marker === "specs" ? ("specs" as const) : undefined,
          async prepare(input) {
            prepares++;
            preparedMounts = input.request.mounts;

            return input;
          },
          async submit(input) {
            submits++;

            return { id: "box", state: "running" as const, mounts: input.request.mounts };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const snapshot = new AdapterSnapshot(client, reference);
  const volume = new AdapterVolume(client, { ...reference, kind: "volume", nativeId: "data" });

  try {
    for (const mounts of [undefined, [], JSON.parse("{}")]) {
      expect((await snapshot.restore({ networkPolicy: "blocked", mounts })).id).toBe("box");

      if (marker === "missing") expect(preparedMounts).toBeUndefined();
    }

    prepares = submits = 0;
    const mounts = [volume.at("/data")];

    if (marker === "missing") {
      await expect(snapshot.restore({ networkPolicy: "blocked", mounts })).rejects.toMatchObject({
        code: "UNSUPPORTED",
        effect: "none",
        unmetRequirements: [expect.stringContaining("Upgrade this adapter")],
      });
      expect(prepares).toBe(0);
      expect(submits).toBe(0);
    } else {
      expect((await snapshot.restore({ networkPolicy: "blocked", mounts })).id).toBe("box");
      expect(preparedMounts).toEqual(mounts);
      prepares = submits = 0;

      for (const change of [
        { restore: { ...info.restore, mounts: false } },
        { preserve: "filesystem+memory" as const, restoreExecution: "resume" as const },
        { mountHandling: "unknown" as const },
        { mounts },
      ]) {
        const original = structuredClone(info);
        Object.assign(info, change);
        await expect(snapshot.restore({ networkPolicy: "blocked", mounts })).rejects.toMatchObject({
          code: "UNSUPPORTED",
          effect: "none",
        });
        Object.assign(info, original);
      }

      expect(prepares).toBe(0);
      expect(submits).toBe(0);
    }

    for (const changed of [
      { ...mounts[0]!, volume: { ...volume.reference, provider: "foreign" } },
      {
        ...mounts[0]!,
        volume: { ...volume.reference, scope: { ...scope, partition: { region: "other" } } },
      },
      {
        ...mounts[0]!,
        volume: {
          ...volume.reference,
          scope: { ...scope, authority: { ...scope.authority, id: "other" } },
        },
      },
    ])
      await expect(
        snapshot.restore({ networkPolicy: "blocked", mounts: [changed] }),
      ).rejects.toMatchObject({ effect: "none" });
  } finally {
    await client.close();
  }
});
