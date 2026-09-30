import { expect, test } from "bun:test";
import { z } from "zod";
import { AdapterCheckpointError, defineAdapter, type SnapshotProfile } from "sandbar-adapter";
import { Image, Sandbar, SandbarError } from "./index";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const reference = {
  version: 1 as const,
  kind: "snapshot" as const,
  provider: "fixture.results",
  scope,
  nativeId: "snapshot-1",
  generation: "build-1",
  ownership: "verified-created" as const,
};

const profile: SnapshotProfile = {
  id: "filesystem",
  preserve: "filesystem",
  interruption: "stop",
  sourceStates: ["running"],
  sourceAfter: "unchanged",
  consistency: "crash-consistent",
  connections: "dropped",
  mountHandling: "none",
  restoreExecution: "fresh",
};

const capture = {
  preserve: "filesystem" as const,
  interruption: "stop" as const,
  restoreExecution: "fresh" as const,
};

const snapshot = {
  reference,
  state: "ready" as const,
  source: { id: "box", class: "fixture" },
  createdAt: null,
  expiration: "unknown" as const,
  excludedPaths: null,
  mounts: [],
  mountHandling: "none" as const,
  preserve: "filesystem" as const,
  consistency: "crash-consistent" as const,
  restoreExecution: "fresh" as const,
  restore: {
    networkPolicies: ["blocked"],
    resources: false,
    mounts: false,
    independentLifecycle: true,
  },
  dependencies: [],
  nativeDependencies: [],
};

function fixture(mode: "success" | "failed" | "uncertain" | "unknown" | "checkpoint") {
  let effects = 0;
  let reads = 0;

  const adapter = defineAdapter({
    name: reference.provider,
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        async inspect() {
          return { id: "box", state: "running" };
        },
        async snapshotProfiles() {
          return {
            status: "supported",
            value: { profiles: [profile], defaultProfileId: profile.id },
          };
        },
        async snapshotInspect() {
          reads++;

          return snapshot;
        },
        snapshotCapture: {
          recovery: { version: 1, token: z.strictObject({ acknowledged: z.boolean() }) },
          async submit(_input, ctx) {
            effects++;

            if (mode === "unknown") return ctx.unknown("Response lost without an ID");

            const outcome = {
              kind: "snapshot_capture" as const,
              status: "partial" as const,
              snapshot: reference,
              capture,
              source: {
                state: "stopped" as const,
                connections: "dropped" as const,
                observedAt: "2026-09-30T12:00:00.000Z",
              },
              restart: {
                status: (
                  {
                    failed: "failed",
                    checkpoint: "not-submitted",
                    uncertain: "uncertain",
                    success: "uncertain",
                  } as const
                )[mode],
              },
            };

            if (mode === "checkpoint") {
              try {
                await ctx.checkpoint({ acknowledged: true });
              } catch (error) {
                if (error instanceof AdapterCheckpointError) error.outcome = outcome;
                throw error;
              }
            }

            if (mode !== "success") return ctx.unknown("Source restart did not complete", outcome);

            return {
              snapshot,
              capture,
              source: {
                state: "running",
                connections: "dropped",
                observedAt: "2026-09-30T12:00:00.000Z",
              },
              retainedResources: Array.from({ length: 40 }, (_, i) => ({
                ...reference,
                nativeId: `snapshot-${i}`,
                history: "x".repeat(4000),
              })),
            };
          },
        },
      };
    },
  });

  const connect = () =>
    Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      onReference(ref) {
        if (mode === "checkpoint" && ref.token) throw new Error("Storage offline");
      },
    });

  return { connect, effects: () => effects, reads: () => reads };
}

test("ordinary capture preserves all results and reopens a JSON identity with a fresh client", async () => {
  const f = fixture("success");
  const client = await f.connect();
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });
  const captured = await box.snapshot();
  expect(captured.snapshot.provider).toBe(reference.provider);
  expect(captured.snapshot.id).toBe(reference.nativeId);
  expect(captured.retainedResources).toHaveLength(40);
  expect(JSON.stringify(captured.retainedResources).length).toBeGreaterThan(16384);
  const saved = JSON.parse(JSON.stringify(captured.snapshot.reference));
  await client.close();
  const fresh = await f.connect();

  try {
    const reopened = await fresh.snapshots.get(saved);
    expect(reopened.reference.generation).toBe("build-1");
    const reads = f.reads();
    await expect(fresh.snapshots.get({ ...saved, provider: "other" })).rejects.toBeInstanceOf(
      SandbarError,
    );
    expect(f.reads()).toBe(reads);
    expect(f.effects()).toBe(1);
  } finally {
    await fresh.close();
  }
});

for (const mode of ["failed", "uncertain", "unknown", "checkpoint"] as const) {
  test(`${mode} reports the known partial result without replay`, async () => {
    const f = fixture(mode);
    const client = await f.connect();

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });
      let failure: SandbarError | undefined;

      try {
        await box.snapshot();
      } catch (error) {
        if (!(error instanceof SandbarError)) throw error;
        failure = error;
      }

      const codes = {
        failed: "SOURCE_RESTART_FAILED",
        checkpoint: "REFERENCE_SAVE_FAILED",
        uncertain: "OUTCOME_UNKNOWN",
        unknown: "OUTCOME_UNKNOWN",
      };

      expect(failure?.code).toBe(codes[mode]);

      if (mode === "unknown") expect(failure?.outcome).toBeUndefined();
      else {
        expect(failure?.outcome).toMatchObject({
          kind: "snapshot_capture",
          status: "partial",
          snapshot: reference,
          capture,
        });
        const saved = JSON.parse(JSON.stringify(failure?.outcome));
        const fresh = await f.connect();

        try {
          expect((await fresh.snapshots.get(saved.snapshot)).id).toBe(reference.nativeId);
        } finally {
          await fresh.close();
        }
      }

      expect(f.effects()).toBe(1);
    } finally {
      await client.close();
    }
  });
}
