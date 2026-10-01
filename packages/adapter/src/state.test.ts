import { expect, test } from "bun:test";
import {
  assertResourceIdentity,
  assertResourceScope,
  ResourceReference,
  resolveSnapshot,
  SnapshotRequest,
  stateCapabilities,
  type SnapshotProfile,
  type RuntimeSession,
} from "./index";

const scope = {
  authority: { kind: "account", id: "one" },
  partition: { region: "us", cluster: "a" },
};

const profile: SnapshotProfile = {
  id: "stop-files",
  preserve: "filesystem",
  sourceStates: ["running", "stopped"],
  interruption: "stop",
  sourceAfter: "stopped",
  connections: "dropped",
  consistency: "crash-consistent",
  restoreExecution: "fresh",
  mountHandling: "excluded",
  minimumRetentionSeconds: 3600,
};

test("versioned references roundtrip all resource kinds and preserve native generation and ownership", () => {
  for (const kind of [
    "sandbox",
    "image",
    "snapshot",
    "volume",
    "volume-version",
    "mount",
    "session",
  ] as const) {
    const reference = ResourceReference.parse({
      version: 1,
      kind,
      provider: "fixture",
      scope,
      nativeId: "reused",
      generation: "epoch-2",
      ownership: "borrowed",
    });

    expect(ResourceReference.parse(JSON.parse(JSON.stringify(reference)))).toEqual(reference);
    assertResourceIdentity(reference, { ...reference, ownership: "unknown" });
    expect(() =>
      assertResourceIdentity(reference, { ...reference, generation: "epoch-3" }),
    ).toThrow("generation differs");
    expect(() =>
      assertResourceIdentity(reference, { ...reference, generation: undefined }),
    ).toThrow("generation differs");
    assertResourceScope(reference, {
      provider: "fixture",
      scope: {
        authority: { id: "one", kind: "account" },
        partition: { cluster: "a", region: "us" },
      },
    });

    for (const binding of [
      { provider: "other", scope },
      {
        provider: "fixture",
        scope: { ...scope, authority: { ...scope.authority, id: "other" } },
      },
    ])
      expect(() => assertResourceScope(reference, binding)).toThrow("different verified binding");
  }

  expect(ResourceReference.safeParse({ version: 2 })).toMatchObject({ success: false });
});

test("profiles never form a Cartesian product or downgrade exact preservation", () => {
  const memory: SnapshotProfile = {
    ...profile,
    id: "memory",
    preserve: "filesystem+memory",
    restoreExecution: "resume",
    interruption: "pause",
    sourceAfter: "unchanged",
  };

  const support = {
    status: "supported" as const,
    value: { profiles: [profile, memory], defaultProfileId: profile.id },
  };

  expect(
    resolveSnapshot(support, { requirements: { preserve: "filesystem" } }, "running").status,
  ).toBe("supported");
  expect(
    resolveSnapshot(support, { requirements: { preserve: "filesystem+memory" } }, "running").status,
  ).toBe("unsupported");
  expect(
    resolveSnapshot(
      { status: "supported", value: { profiles: [memory], defaultProfileId: memory.id } },
      { requirements: { preserve: "filesystem", maxInterruption: "terminate" } },
      "running",
    ).status,
  ).toBe("unsupported");
  expect(
    resolveSnapshot(
      support,
      { requirements: { preserve: "filesystem", maxInterruption: "stop", sourceAfter: "stopped" } },
      "running",
    ),
  ).toMatchObject({
    status: "supported",
    value: { profile, sourceState: "running", restoreRestrictions: "unknown" },
  });
  expect(resolveSnapshot(support, {}, "unknown").status).toBe("unknown");
  expect(resolveSnapshot(support, {}, "destroyed").status).toBe("unavailable");
  const unknownRetention = { ...memory, minimumRetentionSeconds: undefined };
  expect(
    resolveSnapshot(
      {
        status: "supported",
        value: { profiles: [unknownRetention], defaultProfileId: unknownRetention.id },
      },
      { requirements: { preserve: "filesystem+memory" }, retention: { minimumSeconds: 1 } },
      "running",
    ).status,
  ).toBe("unknown");
  expect(
    resolveSnapshot(
      support,
      { requirements: { preserve: "filesystem+memory" }, retention: { minimumSeconds: 3601 } },
      "running",
    ).status,
  ).toBe("unsupported");
  expect(
    SnapshotRequest.safeParse({
      requirements: { preserve: "filesystem" },
      retention: { minimumSeconds: 10, cleanupAfterSeconds: 9 },
    }).success,
  ).toBe(false);
});

test("absent mutation cannot advertise capture and read checks propagate unavailable or unknown", async () => {
  let reads = 0;

  const session: RuntimeSession = {
    scope,
    supports: { images: ["prepared"], network: ["blocked"] },
    create: async () => ({ id: "box", state: "running" }),
    destroy: async () => ({ computeStopped: true, retainedResources: [] }),
    snapshotProfiles: async () => {
      reads++;

      return { status: "supported", value: { profiles: [profile], defaultProfileId: profile.id } };
    },
  };

  const context = { signal: new AbortController().signal, deadline: Date.now() + 1000 };
  expect((await stateCapabilities(session, {}, context)).snapshots.capture.status).toBe(
    "unsupported",
  );
  expect(reads).toBe(0);
  session.snapshotCapture = async () => {
    throw new Error("Must not submit from a check");
  };

  for (const status of ["unavailable", "unknown"] as const) {
    session.snapshotProfiles = async () => ({ status, reason: "fixture evidence" });
    expect((await stateCapabilities(session, {}, context)).snapshots.capture.status).toBe(status);
  }
});

test("optional source lifecycle requirements validate only the default", () => {
  const support = {
    status: "supported" as const,
    value: { profiles: [profile], defaultProfileId: profile.id },
  };

  expect(resolveSnapshot(support, {}, "running").status).toBe("supported");
  expect(
    resolveSnapshot(support, { requirements: { sourceAfter: "unchanged" } }, "running").status,
  ).toBe("unsupported");
  expect(
    resolveSnapshot(support, { requirements: { sourceAfter: "unchanged" } }, "stopped").status,
  ).toBe("supported");
  expect(resolveSnapshot(support, {}, "unknown").status).toBe("unknown");
});

test("capability reads enforce their deadline and abort stalled hooks", async () => {
  let readSignal: AbortSignal | undefined;

  const session: RuntimeSession = {
    scope,
    supports: { images: ["prepared"], network: ["blocked"] },
    create: async () => ({ id: "box", state: "running" }),
    destroy: async () => ({ computeStopped: true, retainedResources: [] }),
    snapshotCapture: async () => {
      throw new Error("Must not capture");
    },
    snapshotProfiles: async (_target, context) => {
      readSignal = context.signal;

      return new Promise(() => {});
    },
  };

  await expect(
    stateCapabilities(
      session,
      {},
      {
        signal: new AbortController().signal,
        deadline: Date.now() + 20,
      },
    ),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(readSignal?.aborted).toBe(true);

  const controller = new AbortController();

  const checking = stateCapabilities(
    session,
    {},
    {
      signal: controller.signal,
      deadline: Date.now() + 30_000,
    },
  );

  await Promise.resolve();
  controller.abort(new Error("Caller aborted"));
  await expect(checking).rejects.toThrow("Caller aborted");
  expect(readSignal?.aborted).toBe(true);
});

test("snapshot list capabilities retain managed-only coverage and unknown declarations", async () => {
  const session: RuntimeSession = {
    scope,
    supports: { images: [], network: [] },
    async create() {
      throw new Error("No effects");
    },
    async destroy() {
      throw new Error("No effects");
    },
    async snapshotList() {
      return { items: [], coverage: "sandbar-managed" };
    },
    snapshotListCoverage: "sandbar-managed",
  };

  const context = { signal: new AbortController().signal, deadline: Date.now() + 1000 };
  expect((await stateCapabilities(session, {}, context)).snapshots.list).toEqual({
    status: "supported",
    value: { coverage: "sandbar-managed" },
  });
  delete session.snapshotListCoverage;
  expect((await stateCapabilities(session, {}, context)).snapshots.list.status).toBe("unknown");
});
