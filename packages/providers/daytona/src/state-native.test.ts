import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, SnapshotInfo, ResourceReference, type Scope } from "sandbar-adapter";
import {
  Sandbar,
  AdapterSnapshot,
  AdapterVolume,
  SandbarError,
  Image,
  OutcomeUnknownError,
  WaitAbortedError,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { daytonaState } from "./state-native";

interface FixtureStartHook {
  callback?: () => void;
}

function fixture(
  options: { stopped?: boolean; restartAfterCapture?: boolean; largeScope?: boolean } = {},
) {
  let scope: Scope = {
    authority: { kind: "organization", id: "org-one" },
    partition: { target: "us" },
  };

  if (options.largeScope) {
    scope = {
      ...scope,
      partition: {
        target: "us",
        apiUrl: "https://fixture.invalid/" + "a".repeat(2000),
        toolboxOrigin: "https://toolbox.invalid/" + "b".repeat(2000),
      },
    };
  }

  let state = options.stopped ? "stopped" : "started";

  let snapshot: {
    id: string;
    name: string;
    organizationId: string;
    general: boolean;
    state: string;
    sourceSandboxId: string;
    sandboxClass: string;
    regionIds: string[];
  } | null = null;

  const startHook: FixtureStartHook = {};
  const snapshotHook: FixtureStartHook = {};
  const sourceHook: FixtureStartHook = {};
  const deleteReadHook: FixtureStartHook = {};

  const snapshotReadStatuses: number[] = [];
  const volumeAbsenceReadStatuses: number[] = [];

  const modes = {
    mounted: false,
    stopLost: false,
    volumeCreateStatus: 0,
    stopRejectedStatus: 0,
    stopRejectedButStopped: false,
    captureLost: false,
    captureRejected: false,
    nativeCaptureError: false,
    restartLost: false,
    restartRejected: false,
    restartUnavailable: false,
    failedDelete: false,
    failedDeleteStatus: 500,
    snapshotReadStatuses,
    volumeAbsenceReadStatuses,
    snapshotReadAttempts: 0,
    snapshotReadStatus: 0,
    pendingReadBodyCancel: false,
    poolsDenied: false,
    poolsDisabled: false,
    sharedSnapshot: false,
    pools: 0,
    slowReads: 0,
    snapshotReads: 0,
    sourceReads: 0,
    sourceReadStatus: 0,
    onSourceRead: sourceHook,
    onStart: startHook,
    onSnapshotRead: snapshotHook,
    onDeleteRead: deleteReadHook,
  };

  const volumes = new Map<
    string,
    { id: string; name: string; organizationId: string; state: string }
  >();

  let volumeCreates = 0;
  const calls = { stop: 0, capture: 0, start: 0, delete: 0, poolReads: 0 };

  // SAFETY: This deterministic native boundary matches the fetch call and preconnect contract.
  const fetcher = Object.assign(
    async (value: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(value));
      const method = init?.method ?? "GET";

      if (
        method === "GET" &&
        (url.pathname.startsWith("/snapshots/") || url.pathname.startsWith("/volumes/"))
      )
        modes.onDeleteRead.callback?.();

      if (url.pathname === "/sandbox/source") {
        modes.sourceReads++;
        modes.onSourceRead.callback?.();

        if (modes.sourceReadStatus === -1) throw new Error("Source read network unavailable");

        if (modes.sourceReadStatus) return new Response(null, { status: modes.sourceReadStatus });

        return Response.json({
          id: "source",
          organizationId: "org-one",
          target: "us",
          state,
          sandboxClass: "container",
          volumes: modes.mounted ? [{ volumeId: "external", mountPath: "/mnt/data" }] : [],
        });
      }

      if (url.pathname === "/sandbox/source/stop" && method === "POST") {
        calls.stop++;

        if (modes.stopRejectedStatus) {
          if (modes.stopRejectedButStopped) state = "stopped";

          return new Response(null, { status: modes.stopRejectedStatus });
        }

        state = "stopped";

        if (modes.stopLost) throw new Error("Lost stop acknowledgement");

        return Response.json({});
      }

      if (url.pathname === "/sandbox/source/start" && method === "POST") {
        calls.start++;
        modes.onStart.callback?.();
        await Promise.resolve();

        if (modes.restartRejected) return new Response(null, { status: 422 });

        if (modes.restartUnavailable) return new Response(null, { status: 503 });
        state = "started";

        if (modes.restartLost) throw new Error("Lost start acknowledgement");

        return Response.json({});
      }

      if (url.pathname === "/sandbox/source/snapshot" && method === "POST") {
        calls.capture++;
        expect(state).toBe("stopped");

        const input = z
          .object({ name: z.string(), includeMemory: z.literal(false) })
          .parse(JSON.parse(String(init?.body)));

        if (modes.captureRejected) return new Response(null, { status: 422 });
        snapshot = {
          id: "snapshot-one",
          name: input.name,
          organizationId: "org-one",
          general: false,
          state: "active",
          sourceSandboxId: "source",
          sandboxClass: "container",
          regionIds: ["us"],
        };

        if (modes.captureLost) throw new Error("Lost capture acknowledgement");

        return Response.json({ id: "source", state });
      }

      if (url.pathname === "/warm-pools") {
        calls.poolReads++;

        if (modes.poolsDisabled) return new Response(null, { status: 404 });

        if (modes.poolsDenied) return new Response(null, { status: 403 });

        return Response.json(
          modes.pools
            ? [{ id: "external-pool", organizationId: "org-one", snapshot: "snapshot-one" }]
            : [],
        );
      }

      if (url.pathname.startsWith("/snapshots/")) {
        if (method === "DELETE") {
          calls.delete++;

          if (modes.failedDelete && modes.failedDeleteStatus < 500)
            return new Response(null, { status: modes.failedDeleteStatus });
          snapshot = null;

          return new Response(null, {
            status: modes.failedDelete ? modes.failedDeleteStatus : 204,
          });
        }

        modes.snapshotReadAttempts++;
        const readStatus = modes.snapshotReadStatus || modes.snapshotReadStatuses.shift();

        if (readStatus)
          return new Response(
            modes.pendingReadBodyCancel
              ? new ReadableStream({ cancel: () => new Promise<void>(() => undefined) })
              : null,
            { status: readStatus },
          );
        const id = decodeURIComponent(url.pathname.slice("/snapshots/".length));

        if (snapshot) {
          modes.snapshotReads++;
          modes.onSnapshotRead.callback?.();
        }

        return snapshot && (snapshot.id === id || snapshot.name === id)
          ? Response.json({
              ...snapshot,
              state: modes.nativeCaptureError
                ? "error"
                : modes.snapshotReads <= modes.slowReads
                  ? "creating"
                  : snapshot.state,
              general: modes.sharedSnapshot,
            })
          : new Response(null, { status: 404 });
      }

      if (url.pathname === "/volumes" && method === "POST") {
        volumeCreates++;

        if (modes.volumeCreateStatus)
          return new Response(null, { status: modes.volumeCreateStatus });

        const volume = {
          id: `volume-${volumeCreates}`,
          name: JSON.parse(String(init?.body)).name,
          organizationId: "org-one",
          state: "ready",
        };

        volumes.set(volume.id, volume);

        return Response.json(volume);
      }

      if (url.pathname.startsWith("/volumes/by-name/"))
        return new Response(null, { status: modes.volumeAbsenceReadStatuses.shift() ?? 404 });

      if (url.pathname.startsWith("/volumes/") && method === "DELETE") {
        calls.delete++;

        if (modes.failedDelete) return new Response(null, { status: modes.failedDeleteStatus });
        volumes.delete(url.pathname.slice("/volumes/".length));

        return new Response(null, { status: 204 });
      }

      if (url.pathname.startsWith("/volumes/")) {
        const volume = volumes.get(url.pathname.slice("/volumes/".length));

        return volume ? Response.json(volume) : new Response(null, { status: 404 });
      }

      if (url.pathname === "/volumes") return Response.json([...volumes.values()]);
      throw new Error(`Unexpected native fixture route: ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const connect = (
    onReference?: (ref: AdapterRecoveryReference) => void,
    apiKey = "fixture-key",
  ) => {
    const resource = daytonaState({
      scope,
      apiUrl: "https://fixture.invalid",
      apiKey,
      target: "us",
      restartAfterCapture: options.restartAfterCapture,
      fetch: fetcher,
    });

    return Sandbar.connect({
      adapter: defineAdapter({
        name: "daytona",
        config: z.strictObject({}),
        credentials: z.strictObject({}),
        async connect() {
          return {
            ...resource.fields,
            scope,
            supports: { images: ["prepared"], network: ["blocked"] },
            async create() {
              return { id: "source", state: "running" };
            },
            async destroy() {
              return { computeStopped: true, retainedResources: [] };
            },
            async inspect(box) {
              return { id: box.id, state: state === "started" ? "running" : "stopped" };
            },
          };
        },
      }),
      config: {},
      credentials: {},
      onReference,
    });
  };

  return {
    connect,
    volumes,
    volumeCreates: () => volumeCreates,
    calls,
    modes,
    state: () => state,
    renameSnapshot(name: string) {
      if (snapshot) snapshot.name = name;
    },
    replaceSnapshot() {
      if (snapshot) snapshot = { ...snapshot, id: "replacement-artifact" };
    },
    setState(value: string) {
      state = value;
    },
  };
}

for (const variant of ["default", "stopped", "leave-stopped"] as const) {
  test(`Daytona no-argument capture uses native default: ${variant}`, async () => {
    const f = fixture({
      stopped: variant === "stopped",
      restartAfterCapture: variant !== "leave-stopped",
    });

    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const result = await source.snapshot();
      expect(result.capture).toEqual({
        preserve: "filesystem",
        interruption: variant === "stopped" ? "none" : "stop",
        restoreExecution: "fresh",
      });
      expect(result.source.state).toBe(variant === "default" ? "running" : "stopped");
      expect(f.calls.stop).toBe(variant === "stopped" ? 0 : 1);
      expect(f.calls.start).toBe(variant === "default" ? 1 : 0);
      expect(f.calls.capture).toBe(1);
      const saved = structuredClone(result.snapshot.reference);
      const opened = await client.snapshots.get(saved);
      expect((await opened.inspect()).restoreExecution).toBe("fresh");
      await opened.delete();
      expect(f.calls.delete).toBe(1);
    } finally {
      await client.close();
    }
  });
}

for (const request of [
  { requirements: { preserve: "filesystem+memory" as const } },
  { requirements: { maxInterruption: "pause" as const } },
  { requirements: { sourceAfter: "stopped" as const } },
]) {
  test(`Daytona strict requirement rejects configured default before effects: ${JSON.stringify(request)}`, async () => {
    const f = fixture();
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      await expect(source.snapshot(request)).rejects.toMatchObject({
        code: "UNSUPPORTED",
        effect: "none",
      });
      expect(f.calls.stop).toBe(0);
      expect(f.calls.capture).toBe(0);
      expect(f.calls.start).toBe(0);
    } finally {
      await client.close();
    }
  });
}

test("Daytona unknown consistency does not satisfy a hard requirement without caller attestation", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    expect((await source.checkSnapshot()).status).toBe("supported");
    expect(
      (await source.checkSnapshot({ requirements: { consistency: "crash-consistent" } })).status,
    ).toBe("unknown");
    expect(
      (
        await source.checkSnapshot({
          consistency: "caller-quiesced",
          requirements: { consistency: "caller-quiesced" },
        })
      ).status,
    ).toBe("supported");
  } finally {
    await client.close();
  }
});

for (const mode of ["stopLost", "captureLost"] as const) {
  test(`Daytona ${mode} stays read-only and never advances an uncertain stage`, async () => {
    const f = fixture();
    f.modes[mode] = true;
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await source.submitSnapshot();
      await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      const saved = structuredClone(operation.reference);
      await expect((await client.recover(saved)).wait()).rejects.toBeInstanceOf(
        OutcomeUnknownError,
      );
      expect(f.calls.stop).toBe(1);
      expect(f.calls.capture).toBe(mode === "stopLost" ? 0 : 1);
      expect(f.calls.start).toBe(0);
    } finally {
      await client.close();
    }
  });
}

for (const restartAfterCapture of [true, false]) {
  test(`Daytona definitive capture failure restores the source only when configured: ${restartAfterCapture}`, async () => {
    const f = fixture({ restartAfterCapture });
    f.modes.captureRejected = true;
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await source.submitSnapshot();
      await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(operation.reference.token).toMatchObject({
        captureState: "failed",
        captureFailure: "Native capture definitively rejected",
      });
      expect(f.state()).toBe(restartAfterCapture ? "started" : "stopped");
      expect(f.calls.start).toBe(restartAfterCapture ? 1 : 0);
      await expect((await client.recover(operation.reference)).wait()).rejects.toBeInstanceOf(
        OutcomeUnknownError,
      );
      expect(f.calls.capture).toBe(1);
      expect(f.calls.start).toBe(restartAfterCapture ? 1 : 0);
    } finally {
      await client.close();
    }
  });
}

test.each(["failed", "uncertain"] as const)(
  "Daytona retained capture is a direct partial result when restart is %s",
  async (restart) => {
    const f = fixture();
    f.modes.restartRejected = restart === "failed";
    f.modes.restartUnavailable = restart === "uncertain";
    const client = await f.connect();
    let savedSnapshot;
    let savedOperation;

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await source.submitSnapshot();
      const error = await operation.wait().catch((error) => error);
      expect(error).toBeInstanceOf(SandbarError);

      if (!(error instanceof SandbarError)) throw error;
      expect(error.code).toBe(restart === "failed" ? "SOURCE_RESTART_FAILED" : "OUTCOME_UNKNOWN");
      expect(error.outcome).toMatchObject({
        kind: "snapshot_capture",
        status: "partial",
        snapshot: { kind: "snapshot", nativeId: "snapshot-one", ownership: "verified-created" },
        capture: { preserve: "filesystem", interruption: "stop", restoreExecution: "fresh" },
        source: { state: "stopped", connections: "dropped", observedAt: expect.any(String) },
        restart: { status: restart },
      });

      if (error.outcome?.kind !== "snapshot_capture" || !error.outcome.snapshot) throw error;
      savedSnapshot = JSON.parse(JSON.stringify(error.outcome.snapshot));
      savedOperation = JSON.parse(JSON.stringify(operation.reference));
      expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
    } finally {
      await client.close();
    }

    f.modes.sourceReadStatus = 404;
    const reopened = await f.connect(undefined, "rotated-key-same-org");

    try {
      const snapshot = await reopened.snapshots.get(savedSnapshot);
      expect(await snapshot.inspect()).toMatchObject({ state: "ready", mountHandling: "none" });
      const recovered = await reopened.recover(savedOperation);
      await expect(recovered.wait()).rejects.toMatchObject({
        code: restart === "failed" ? "SOURCE_RESTART_FAILED" : "OUTCOME_UNKNOWN",
        outcome: { snapshot: savedSnapshot, capture: { preserve: "filesystem" } },
      });
      await snapshot.delete();
      expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1, delete: 1 });
    } finally {
      await reopened.close();
    }
  },
);

test("Daytona reports capture and restart failures independently", async () => {
  const f = fixture();
  f.modes.captureRejected = true;
  f.modes.restartRejected = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(operation.reference.token).toMatchObject({
      captureState: "failed",
      captureFailure: "Native capture definitively rejected",
      restartFailure: "Source start response was not successful; no replay",
    });
  } finally {
    await client.close();
  }
});

for (const mode of ["pools", "poolsDenied", "sharedSnapshot"] as const) {
  test(`Daytona deletion rechecks unsafe native dependencies after durable barrier: ${mode}`, async () => {
    const f = fixture();

    const client = await f.connect((ref) => {
      if (ref.kind === "snapshot_delete") {
        if (mode === "pools") f.modes.pools = 1;
        else f.modes[mode] = true;
      }
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const result = await source.snapshot();
      await expect(result.snapshot.delete()).rejects.toBeDefined();
      expect(f.calls.delete).toBe(0);
    } finally {
      await client.close();
    }
  });
}

test("Daytona uncertain delete response reconciles exact artifact absence without replay", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const result = await source.snapshot();
    f.modes.failedDelete = true;
    const operation = await result.snapshot.submitDelete();
    expect(await operation.wait()).toMatchObject({ deleted: true });
    expect(await (await client.recover(operation.reference)).wait()).toMatchObject({
      deleted: true,
    });
    const legacy = structuredClone(operation.reference);
    legacy.token = { reference: result.snapshot.reference, accepted: false };
    await expect((await client.recover(legacy)).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test("Daytona newly mounted source rejects before stop", async () => {
  const f = fixture();

  const client = await f.connect((ref) => {
    if (ref.kind === "snapshot_capture") f.modes.mounted = true;
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    await expect(source.snapshot()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.calls.stop).toBe(0);
    expect(f.calls.capture).toBe(0);
  } finally {
    await client.close();
  }
});

test("Daytona caller cancellation during restart retains acknowledged artifact and stage custody", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.modes.onStart.callback = () => controller.abort();
  const saved: unknown[] = [];
  const client = await f.connect((ref) => saved.push(structuredClone(ref)));

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    let error: unknown;

    try {
      await source.snapshot(undefined, { signal: controller.signal });
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(WaitAbortedError);

    if (!(error instanceof WaitAbortedError)) throw new Error("Expected wait abort");
    expect(error.outcome).toMatchObject({
      kind: "snapshot_capture",
      status: "partial",
      snapshot: {
        kind: "snapshot",
        nativeId: "snapshot-one",
        provider: "daytona",
        scope: client.scope,
      },
      capture: { preserve: "filesystem", interruption: "stop", restoreExecution: "fresh" },
    });

    const token = z
      .object({
        captureState: z.literal("completed"),
        snapshot: SnapshotInfo.extend({ reference: ResourceReference.omit({ scope: true }) }),
        sourceState: z.literal("running"),
      })
      .parse(error.reference.token);

    expect(
      saved.some(
        (ref) =>
          z.object({ token: z.object({ captureState: z.literal("completed") }) }).safeParse(ref)
            .success,
      ),
    ).toBe(true);
    const recovered = await (await client.recover(error.reference)).wait();
    expect(recovered).toMatchObject({ source: { state: "running" } });
    await (
      await client.snapshots.get({ ...token.snapshot.reference, scope: client.scope })
    ).delete();
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
  } finally {
    await client.close();
  }
});

test("Daytona cancellation during an uncertain restart retains confirmed capture directly", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.modes.onStart.callback = () => controller.abort();
  f.modes.restartUnavailable = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });

    const error = await source
      .snapshot(undefined, { signal: controller.signal })
      .catch((error: Error) => error);

    expect(error).toBeInstanceOf(WaitAbortedError);

    if (!(error instanceof WaitAbortedError) || error.outcome?.kind !== "snapshot_capture")
      throw new Error("Expected direct partial capture on cancellation");
    expect(error.outcome).toMatchObject({
      status: "partial",
      snapshot: {
        kind: "snapshot",
        nativeId: "snapshot-one",
        provider: "daytona",
        scope: client.scope,
      },
      capture: { preserve: "filesystem", interruption: "stop", restoreExecution: "fresh" },
      restart: { status: "uncertain" },
    });
    expect((await (await client.snapshots.get(error.outcome.snapshot!)).inspect()).state).toBe(
      "ready",
    );
    expect(await (await client.recover(error.reference)).observe()).toBeNull();
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
  } finally {
    await client.close();
  }
});

test("Daytona lost start acknowledgement is confirmed read-only without another start", async () => {
  const f = fixture();
  f.modes.restartLost = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    const result = await operation.wait();
    expect(result.source.state).toBe("running");
    expect(operation.reference.token).toMatchObject({
      sourceState: "running",
      captureState: "completed",
    });
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
  } finally {
    await client.close();
  }
});

test("Daytona default orchestration waits beyond ten seconds for accepted native capture readiness", async () => {
  const f = fixture();
  f.modes.slowReads = 45;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const result = await source.snapshot();
    expect(result.source.state).toBe("running");
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
  } finally {
    await client.close();
  }
}, 20000);

test("Daytona preserves caller consistency attestation across a new connection", async () => {
  const f = fixture();
  const client = await f.connect();
  let reference;

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    reference = (await source.snapshot({ consistency: "caller-quiesced" })).snapshot.reference;
  } finally {
    await client.close();
  }

  const reopened = await f.connect();

  try {
    expect(await (await reopened.snapshots.get(reference!)).inspect()).toMatchObject({
      consistency: "caller-quiesced",
      restoreExecution: "fresh",
    });
  } finally {
    await reopened.close();
  }
});

test("Daytona stopped-to-running drift cannot violate maxInterruption none", async () => {
  const f = fixture({ stopped: true });

  const client = await f.connect((ref) => {
    if (ref.kind === "snapshot_capture") f.setState("started");
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    await expect(
      source.snapshot({ requirements: { maxInterruption: "none" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect(f.calls).toMatchObject({ stop: 0, capture: 0, start: 0 });
  } finally {
    await client.close();
  }
});

test("Daytona recovery never adopts or authorizes deletion of a replacement captured name", async () => {
  const f = fixture();
  f.modes.restartRejected = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    await expect(operation.wait()).rejects.toMatchObject({ code: "SOURCE_RESTART_FAILED" });
    const saved = structuredClone(operation.reference);
    expect(saved.token).toMatchObject({
      snapshotId: "snapshot-one",
      snapshot: { reference: { nativeId: "snapshot-one" } },
    });
    f.replaceSnapshot();
    f.setState("started");
    const recovered = await client.recover(saved);
    await expect(recovered.wait()).rejects.toMatchObject({ code: "SOURCE_RESTART_FAILED" });
    expect(recovered.reference.token).toMatchObject({
      snapshot: { reference: { nativeId: "snapshot-one" } },
    });
    expect(f.calls).toMatchObject({ capture: 1, start: 1, delete: 0 });
  } finally {
    await client.close();
  }
});

test("Daytona accepted capture binds the first observed ID before readiness and rejects name reuse", async () => {
  const f = fixture();
  f.modes.slowReads = 100;
  const controller = new AbortController();
  f.modes.onSnapshotRead.callback = () => controller.abort();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot(undefined, { signal: controller.signal });
    expect(operation.reference.token).toMatchObject({
      captureState: "accepted",
      snapshotId: "snapshot-one",
      snapshot: { reference: { nativeId: "snapshot-one", ownership: "verified-created" } },
    });
    const unsigned = structuredClone(operation.reference);
    const unsignedToken = z.object({ snapshot: z.json() }).catchall(z.json()).parse(unsigned.token);
    const { snapshot: _snapshot, ...withoutReceipt } = unsignedToken;
    unsigned.token = withoutReceipt;
    await expect((await client.recover(unsigned)).wait()).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    f.modes.onSnapshotRead.callback = undefined;
    f.modes.slowReads = 0;
    f.replaceSnapshot();
    await expect((await client.recover(operation.reference)).wait()).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    const legacy = JSON.parse(JSON.stringify(operation.reference));
    delete legacy.token.snapshotId;
    await expect((await client.recover(legacy)).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toMatchObject({ capture: 1, start: 0, delete: 0 });
  } finally {
    await client.close();
  }
});

for (const stopped of [false, true]) {
  for (const phase of ["prepare", "revalidate", "native-submit"] as const) {
    test(`Daytona rejects capture plan drift before effects: ${stopped ? "stopped-to-running" : "running-to-stopped"} / ${phase}`, async () => {
      const f = fixture({ stopped });
      const driftRead = { prepare: 2, revalidate: 5, "native-submit": 6 }[phase];
      f.modes.onSourceRead.callback = () => {
        if (f.modes.sourceReads === driftRead) f.setState(stopped ? "started" : "stopped");
      };

      const client = await f.connect();

      try {
        const source = await client.sandboxes.create({ environment: Image.prepared("base") });
        await expect(source.snapshot()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        expect(f.modes.sourceReads).toBe(driftRead);
        expect(f.calls).toMatchObject({ stop: 0, capture: 0, start: 0 });
      } finally {
        await client.close();
      }
    });
  }
}

test("Daytona organization-disabled warm pools do not prevent owned snapshot cleanup", async () => {
  const f = fixture();
  f.modes.poolsDisabled = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const captured = await source.snapshot();
    expect((await captured.snapshot.inspect()).nativeDependencies).toEqual([]);
    await captured.snapshot.delete();
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

for (const mode of [
  "matching",
  "wrong-id",
  "wrong-scope",
  "renamed-tombstone",
  "lost-ack",
] as const) {
  test(`Daytona deleted volume tombstone requires checkpointed scoped identity: ${mode}`, async () => {
    const scope = { authority: { kind: "organization", id: "org" }, partition: { target: "us" } };
    let deleted = false;
    let deletes = 0;

    const native = () => ({
      id: deleted && mode === "wrong-id" ? "replacement" : "vol",
      name: deleted && mode === "renamed-tombstone" ? "owned-deleted" : "owned",
      organizationId: deleted && mode === "wrong-scope" ? "foreign" : "org",
      state: deleted ? "deleted" : "ready",
    });

    // SAFETY: The deterministic native boundary implements the fetch/preconnect contract.
    const fetcher = Object.assign(
      async (value: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(value)).pathname;

        if (path === "/volumes/by-name/owned") return new Response(null, { status: 404 });

        if (path === "/volumes" && init?.method === "POST") return Response.json(native());

        if (path === "/volumes/vol" && init?.method === "DELETE") {
          deletes++;
          deleted = true;

          if (mode === "lost-ack") throw Error("Lost acknowledgment");

          return new Response(null, { status: 204 });
        }

        if (path === "/volumes/vol") return Response.json(native());

        throw Error("Unexpected volume fixture route");
      },
      { preconnect() {} },
    ) as typeof fetch;

    const adapter = defineAdapter({
      name: "daytona",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        const state = daytonaState({
          scope,
          apiUrl: "https://fixture.invalid",
          apiKey: "fixture",
          target: "us",
          fetch: fetcher,
        });

        return {
          ...state.fields,
          scope,
          supports: { images: ["prepared"], network: ["blocked"] },
          async create() {
            throw Error("This fixture never allocates compute");
          },
          async destroy() {
            return { computeStopped: true, retainedResources: [] };
          },
          async close() {},
        };
      },
    });

    const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

    try {
      const volume = await client.volumes.create({ name: "owned" });
      const operation = await volume.submitDelete();

      if (mode === "matching" || mode === "renamed-tombstone" || mode === "lost-ack") {
        expect(await operation.wait()).toMatchObject({ deleted: true });
        await expect(volume.inspect()).rejects.toMatchObject({ code: "NOT_FOUND" });
      } else await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(deletes).toBe(1);
    } finally {
      await client.close();
    }
  });
}

test("Daytona snapshot history reopens with rotated credentials in the same organization", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  const saved = JSON.parse(JSON.stringify((await source.snapshot()).snapshot.reference));
  await client.close();
  const reopened = await f.connect(undefined, "rotated-key-same-org");

  try {
    const snapshot = await reopened.snapshots.get(saved);
    expect((await snapshot.inspect()).mountHandling).toBe("none");
    await snapshot.delete();
    expect(f.calls.delete).toBe(1);
  } finally {
    await reopened.close();
  }
});

test("Daytona delayed capture stays read-only until continuation restarts exactly once", async () => {
  const f = fixture();
  f.modes.slowReads = 1;
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  f.modes.onSnapshotRead.callback = () => {
    offset = 61000;
  };

  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    Date.now = originalNow;
    f.modes.onSnapshotRead.callback = undefined;
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 0 });
    const saved = JSON.parse(JSON.stringify(operation.reference));
    const reopened = await f.connect();

    try {
      const recovered = await reopened.recover(saved);
      await (await recovered.continue()).wait();
      await (await recovered.continue()).wait();
      expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
      expect(f.state()).toBe("started");
      expect(recovered.reference.submissionId).toBe(saved.submissionId);
    } finally {
      await reopened.close();
    }
  } finally {
    Date.now = originalNow;
    await client.close();
  }
});

for (const stage of ["stop", "capture", "restart"] as const) {
  test(`Daytona persistence failure before ${stage} dispatch prevents that native effect`, async () => {
    const f = fixture();

    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((reference) => {
      saved = structuredClone(reference);

      const parsed = z
        .object({
          token: z.object({
            stopState: z.string(),
            captureState: z.string(),
            restartState: z.string(),
          }),
        })
        .safeParse(reference);

      if (parsed.success && parsed.data.token[`${stage}State`] === "uncertain")
        throw new Error("Durable store unavailable");
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      await expect(source.submitSnapshot()).rejects.toMatchObject({
        code: "REFERENCE_SAVE_FAILED",
      });
      expect(f.calls).toMatchObject({
        stop: stage === "stop" ? 0 : 1,
        capture: stage === "restart" ? 1 : 0,
        start: 0,
      });
      expect(saved?.token).toMatchObject({ [`${stage}State`]: "uncertain" });
    } finally {
      await client.close();
    }
  });
}

test("Daytona terminal native capture failure retains artifact and restores configured source", async () => {
  const f = fixture();
  f.modes.nativeCaptureError = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(operation.reference.token).toMatchObject({
      captureState: "failed",
      snapshotId: "snapshot-one",
      restartState: "completed",
    });
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
    await expect((await operation.continue()).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls.start).toBe(1);
  } finally {
    await client.close();
  }
});

test("Daytona explicit continuation observes cancellation inside restart checkpoint", async () => {
  const f = fixture();
  f.modes.slowReads = 1;
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  f.modes.onSnapshotRead.callback = () => {
    offset = 61000;
  };

  const first = await f.connect();

  try {
    const source = await first.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    Date.now = originalNow;
    f.modes.onSnapshotRead.callback = undefined;
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const controller = new AbortController();

    const reopened = await f.connect((reference) => {
      const parsed = z
        .object({ token: z.object({ restartState: z.literal("uncertain") }) })
        .safeParse(reference);

      if (parsed.success) controller.abort();
    });

    try {
      const continued = await reopened.recover(operation.reference);
      await continued.continue({ signal: controller.signal });
      expect(f.calls.start).toBe(0);
      expect(continued.reference.token).toMatchObject({ restartState: "not-submitted" });
    } finally {
      await reopened.close();
    }
  } finally {
    Date.now = originalNow;
    await first.close();
  }
});

test("Daytona continuation rejects contradictory saved workflow before lifecycle effects", async () => {
  const f = fixture();
  f.modes.stopLost = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    const saved = JSON.parse(JSON.stringify(operation.reference));
    saved.token.restartRequired = false;
    const recovered = await client.recover(saved);
    await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
  } finally {
    await client.close();
  }
});

test("Daytona caller-selected private snapshot deletion does not require SDK creation history", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const original = (await source.snapshot()).snapshot;
    const selected = JSON.parse(JSON.stringify(original.reference));
    selected.ownership = "borrowed";
    delete selected.history;
    await client.snapshots.delete(selected);
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

for (const rejectCheckpoint of [false, true]) {
  test(
    "daytona volume ACK is persisted and recoverable with fresh credentials: " + rejectCheckpoint,
    async () => {
      const f = fixture();
      let saved: AdapterRecoveryReference | undefined;

      const callback = async (reference: AdapterRecoveryReference) => {
        if (reference.kind !== "volume_create") return;

        const token = z
          .object({ state: z.literal("accepted"), volume: z.object({ nativeId: z.string() }) })
          .safeParse(reference.token);

        if (!token.success) return;
        saved = JSON.parse(JSON.stringify(reference));
        expect(token.data.volume.nativeId).toBeTruthy();

        if (rejectCheckpoint) throw Error("Application persistence failed after ACK");
      };

      const client = await f.connect(callback);

      try {
        if (rejectCheckpoint)
          await expect(client.volumes.create({ name: "durable-volume" })).rejects.toBeInstanceOf(
            OutcomeUnknownError,
          );
        else await client.volumes.create({ name: "durable-volume" });
        expect(saved).toBeDefined();
        expect(f.volumeCreates()).toBe(1);
        const reopened = await f.connect(undefined, "rotated-key");

        try {
          const volume = await (await reopened.recover(saved!)).wait();
          expect(volume).toMatchObject({ reference: { kind: "volume" } });
          expect(f.volumeCreates()).toBe(1);
          const native = [...f.volumes.values()][0]!;
          native.name = "replacement-name";
          await expect((await reopened.recover(saved!)).wait()).rejects.toBeInstanceOf(
            OutcomeUnknownError,
          );
          expect(f.volumeCreates()).toBe(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}

test("acknowledged native capture still in progress remains pending without replay or restart", async () => {
  const f = fixture();
  f.modes.slowReads = 1000000;
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  f.modes.onSnapshotRead.callback = () => {
    offset = 61000;
  };

  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    Date.now = originalNow;
    f.modes.onSnapshotRead.callback = undefined;
    await expect(
      (await client.recover(operation.reference)).wait({
        signal: AbortSignal.timeout(100),
        pollMs: 50,
      }),
    ).rejects.toBeInstanceOf(WaitAbortedError);
    expect(operation.reference.token).toMatchObject({ captureState: "accepted" });
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 0 });
  } finally {
    Date.now = originalNow;
    await client.close();
  }
});

for (const kind of ["snapshot", "volume"] as const) {
  for (const barrier of ["reject-before", "abort-before", "abort-read", "reject-after"] as const) {
    test(`Daytona ${kind} delete ${barrier} checkpoints custody without replay`, async () => {
      const f = fixture();
      const controller = new AbortController();
      let saved: AdapterRecoveryReference | undefined;

      const client = await f.connect((reference) => {
        if (reference.kind !== `${kind}_delete`) return;
        const token = z.object({ accepted: z.boolean() }).safeParse(reference.token);

        if (!token.success) {
          saved = JSON.parse(JSON.stringify(reference));

          if (barrier === "abort-read")
            f.modes.onDeleteRead.callback = () => {
              controller.abort();
              throw controller.signal.reason;
            };

          return;
        }

        expect(f.calls.delete).toBe(token.data.accepted ? 1 : 0);

        if (barrier === "abort-before" && !token.data.accepted) controller.abort();
        else if (
          (barrier === "reject-before" && !token.data.accepted) ||
          (barrier === "reject-after" && token.data.accepted)
        )
          throw Error("Persistence unavailable");
        saved = JSON.parse(JSON.stringify(reference));
      });

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "checkpointed" });

        try {
          const operation = await artifact.submitDelete({ signal: controller.signal });
          await operation.wait({ signal: controller.signal });
          throw Error("Expected interrupted deletion");
        } catch (error) {
          if (barrier === "abort-before" || barrier === "abort-read")
            expect(error).toMatchObject({ code: "UNAVAILABLE", effect: "none" });
          else expect(error).toBeInstanceOf(OutcomeUnknownError);
        }

        expect(saved).toBeDefined();

        if (barrier === "abort-before" || barrier === "abort-read")
          expect(saved!.token).toMatchObject({ accepted: false, stage: "rejected" });

        if (barrier === "reject-after")
          expect(saved!.token).toMatchObject({ accepted: false, stage: "uncertain" });
        expect(f.calls.delete).toBe(barrier === "reject-after" ? 1 : 0);
        f.modes.onDeleteRead.callback = undefined;
        const reopened = await f.connect(undefined, "rotated-key");

        try {
          const recovered = await reopened.recover(saved!);

          if (barrier === "reject-after") {
            expect(await recovered.wait()).toMatchObject({ deleted: true });
            const mismatched = structuredClone(saved!);

            const token = z
              .object({
                reference: z.object({ nativeId: z.string() }).catchall(z.json()),
                accepted: z.boolean(),
                stage: z.string(),
              })
              .parse(mismatched.token);

            token.reference.nativeId = "other-artifact";
            mismatched.token = token;
            await expect((await reopened.recover(mismatched)).wait()).rejects.toBeInstanceOf(
              OutcomeUnknownError,
            );
          } else await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
          expect(f.calls.delete).toBe(barrier === "reject-after" ? 1 : 0);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    });
  }
}

for (const mode of ["recovers", "exhausted", "cancelled", "cancel-pending-body"] as const) {
  test(`Daytona snapshot read transient gateway retry is bounded: ${mode}`, async () => {
    const f = fixture();
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const artifact = (await source.snapshot()).snapshot;
      const before = f.modes.snapshotReadAttempts;
      f.modes.pendingReadBodyCancel = mode === "cancel-pending-body";
      f.modes.snapshotReadStatuses = mode === "recovers" ? [502, 503] : [502, 503, 504];

      if (mode === "recovers") expect(await artifact.inspect()).toMatchObject({ state: "ready" });
      else if (mode === "exhausted")
        await expect(artifact.inspect()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      else
        await expect(artifact.inspect({ signal: AbortSignal.timeout(30) })).rejects.toBeDefined();
      expect(f.modes.snapshotReadAttempts - before).toBe(mode.startsWith("cancel") ? 1 : 3);
      expect(f.calls.capture).toBe(1);
    } finally {
      await client.close();
    }
  });
}

test("Daytona gateway DELETE failure never repeats the mutation", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const artifact = (await source.snapshot()).snapshot;
    f.modes.failedDelete = true;
    f.modes.failedDeleteStatus = 502;
    expect(await artifact.delete()).toMatchObject({ deleted: true });
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test("Daytona native state read aborts even when gateway body cancellation never settles", async () => {
  const scope = { authority: { kind: "organization", id: "org" }, partition: { target: "us" } };
  let reads = 0;

  // SAFETY: The deterministic fixture implements fetch and preconnect without native provider access.
  const fetcher = Object.assign(
    async (_value: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      reads++;

      return new Response(
        new ReadableStream({ cancel: () => new Promise<void>(() => undefined) }),
        {
          status: 502,
        },
      );
    },
    { preconnect() {} },
  ) as typeof fetch;

  const state = daytonaState({
    scope,
    apiUrl: "https://fixture.invalid",
    apiKey: "fixture",
    target: "us",
    fetch: fetcher,
  });

  const reference = ResourceReference.parse({
    version: 1,
    kind: "snapshot",
    provider: "daytona",
    scope,
    nativeId: "snap",
    ownership: "unknown",
  });

  await expect(
    state.fields.snapshotInspect!(reference, {
      signal: AbortSignal.timeout(30),
      deadline: Date.now() + 1000,
    }),
  ).rejects.toBeDefined();
  expect(reads).toBe(1);
});

for (const kind of ["snapshot", "volume"] as const) {
  test(`Daytona ${kind} absence gateway exhaustion rejects unavailable before effects`, async () => {
    const f = fixture();
    const client = await f.connect();

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });

      if (kind === "snapshot") f.modes.snapshotReadStatuses = [502, 503, 504];
      else f.modes.volumeAbsenceReadStatuses = [502, 503, 504];
      await expect(
        kind === "snapshot" ? source.snapshot() : client.volumes.create({ name: "unavailable" }),
      ).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(f.calls).toMatchObject({ stop: 0, capture: 0, start: 0 });
      expect(f.volumeCreates()).toBe(0);
    } finally {
      await client.close();
    }
  });
}

test("Daytona cancelled volume-create checkpoint survives fresh recovery without dispatch", async () => {
  const f = fixture();
  const controller = new AbortController();
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect((reference) => {
    if (reference.kind !== "volume_create" || !reference.token) return;
    saved = JSON.parse(JSON.stringify(reference));
    controller.abort();
  });

  try {
    try {
      await client.volumes.create({ name: "cancelled" }, { signal: controller.signal });
      throw Error("Expected cancellation");
    } catch (error) {
      expect(
        error instanceof WaitAbortedError ||
          (error instanceof SandbarError && error.effect === "none"),
      ).toBe(true);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved?.token).toMatchObject({ state: "rejected" });
    const before = structuredClone(f.calls);
    const reopened = await f.connect(undefined, "rotated-key");

    try {
      const recovered = await reopened.recover(saved!);
      await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      await recovered.continue();
      await expect(recovered.wait()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(f.calls).toEqual(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await client.close();
  }
});

test.each([400, 401, 403, 422])(
  "Daytona definitive stop rejection preserves no capture effect: HTTP %s",
  async (status) => {
    const f = fixture();
    f.modes.stopRejectedStatus = status;
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((reference) => {
      if (reference.kind === "snapshot_capture") saved = structuredClone(reference);
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      await expect(source.snapshot()).rejects.toMatchObject({
        code: "UNAVAILABLE",
        effect: "none",
      });
      expect(saved?.token).toMatchObject({
        stopState: "failed",
        captureState: "not-submitted",
        sourceState: "running",
      });
      expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
      const reopened = await f.connect(undefined, "rotated-key");

      try {
        const recovered = await reopened.recover(saved!);
        await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
        await expect((await recovered.continue()).wait()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  },
);

test("Daytona rejected stop cannot claim no effect when the source changed", async () => {
  const f = fixture();
  f.modes.stopRejectedStatus = 403;
  f.modes.stopRejectedButStopped = true;
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect((reference) => {
    if (reference.kind === "snapshot_capture") saved = structuredClone(reference);
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    await expect(source.snapshot()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const recovered = await client.recover(saved!);
    await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
  } finally {
    await client.close();
  }
});

for (const kind of ["snapshot", "volume"] as const) {
  test.each([400, 401, 403, 422])(
    `Daytona ${kind} definitive DELETE rejection survives reopen: HTTP %s`,
    async (status) => {
      const f = fixture();
      let saved: AdapterRecoveryReference | undefined;

      const client = await f.connect((reference) => {
        if (reference.kind === `${kind}_delete`) saved = structuredClone(reference);
      });

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "rejected-delete" });

        f.modes.failedDelete = true;
        f.modes.failedDeleteStatus = status;
        await expect(artifact.delete()).rejects.toMatchObject({
          code: "UNAVAILABLE",
          effect: "none",
        });
        expect(saved?.token).toMatchObject({ accepted: false, stage: "rejected" });
        expect(f.calls.delete).toBe(1);
        const reopened = await f.connect(undefined, "rotated-key");

        try {
          const recovered = await reopened.recover(saved!);
          await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
          await expect((await recovered.continue()).wait()).rejects.toMatchObject({
            code: "UNAVAILABLE",
            effect: "none",
          });
          const legacy = structuredClone(saved!);

          const legacyToken = z
            .object({ accepted: z.boolean(), stage: z.string(), reference: z.json() })
            .parse(legacy.token);

          legacy.token = legacyToken;
          await expect(
            (await (await reopened.recover(legacy)).continue()).wait(),
          ).rejects.toBeInstanceOf(OutcomeUnknownError);
          await expect(artifact.inspect()).resolves.toBeDefined();
          expect(f.calls.delete).toBe(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}

test.each(["conflict", "missing", "unreadable"] as const)(
  "Daytona stop rejection cannot settle ambiguous source evidence: %s",
  async (mode) => {
    const f = fixture();
    f.modes.stopRejectedStatus = mode === "conflict" ? 409 : 403;
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((reference) => {
      if (reference.kind !== "snapshot_capture") return;
      saved = structuredClone(reference);

      if (z.object({ stopState: z.literal("failed") }).safeParse(reference.token).success) {
        if (mode === "missing") f.modes.sourceReadStatus = 404;

        if (mode === "unreadable") f.modes.sourceReadStatus = 500;
      }
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      await expect(source.snapshot()).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(saved?.token).toMatchObject({ captureState: "not-submitted" });
      expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
      f.modes.sourceReadStatus = 0;
      const recovered = await client.recover(saved!);

      if (mode === "conflict")
        await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(
          OutcomeUnknownError,
        );
      else {
        f.modes.sourceReadStatus = mode === "missing" ? 404 : 500;

        if (mode === "missing")
          await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(
            OutcomeUnknownError,
          );
        else await expect(recovered.continue()).rejects.toBeInstanceOf(OutcomeUnknownError);
      }

      expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
    } finally {
      await client.close();
    }
  },
);

for (const kind of ["snapshot", "volume"] as const) {
  test.each([408, 499])(
    `Daytona ${kind} ambiguous DELETE response keeps dispatch uncertainty: HTTP %s`,
    async (status) => {
      const f = fixture();
      const client = await f.connect();

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "ambiguous-delete" });

        f.modes.failedDelete = true;
        f.modes.failedDeleteStatus = status;
        const operation = await artifact.submitDelete();
        expect(operation.reference.token).toMatchObject({ accepted: false, stage: "uncertain" });
        expect(await operation.observe()).toBeNull();
        const recovered = await client.recover(operation.reference);
        expect(await recovered.observe()).toBeNull();
        await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(
          OutcomeUnknownError,
        );
        expect(f.calls.delete).toBe(1);
      } finally {
        await client.close();
      }
    },
  );
}

test("Daytona failed stop checkpoint preserves uncertainty without replay", async () => {
  const f = fixture();
  f.modes.stopRejectedStatus = 403;
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect((reference) => {
    if (reference.kind !== "snapshot_capture") return;

    if (z.object({ stopState: z.literal("failed") }).safeParse(reference.token).success)
      throw new Error("persistence unavailable");
    saved = structuredClone(reference);
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    await expect(source.snapshot()).rejects.toMatchObject({ code: "REFERENCE_SAVE_FAILED" });
    expect(saved?.token).toMatchObject({ stopState: "uncertain", captureState: "not-submitted" });
    const reopened = await f.connect(undefined, "rotated-key");

    try {
      const recovered = await reopened.recover(saved!);
      await expect((await recovered.continue()).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(f.calls).toMatchObject({ stop: 1, capture: 0, start: 0 });
    } finally {
      await reopened.close();
    }
  } finally {
    await client.close();
  }
});

test("Daytona oversized native volume inventory reports SDK capacity", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    await client.volumes.create({ name: "first" });
    await client.volumes.create({ name: "second" });
    await expect(client.volumes.list({ limit: 1 })).rejects.toMatchObject({ code: "CAPACITY" });
    expect((await client.volumes.list({ limit: 2 })).items).toHaveLength(2);
  } finally {
    await client.close();
  }
});

for (const kind of ["snapshot", "volume"] as const) {
  test.each([false, true])(
    `Daytona ${kind} deletion checkpoints large valid metadata compactly: cancelled %s`,
    async (cancelled) => {
      const f = fixture();
      const controller = new AbortController();
      let saved: AdapterRecoveryReference | undefined;

      const client = await f.connect((reference) => {
        if (reference.kind !== `${kind}_delete`) return;
        saved = structuredClone(reference);

        if (
          cancelled &&
          z.object({ stage: z.literal("uncertain") }).safeParse(reference.token).success
        )
          controller.abort();
      });

      try {
        const artifact =
          kind === "snapshot"
            ? (
                await (
                  await client.sandboxes.create({ environment: Image.prepared("base") })
                ).snapshot()
              ).snapshot
            : await client.volumes.create({ name: "large-reference" });

        const selected = ResourceReference.parse({
          ...artifact.reference,
          history: { padding: "x".repeat(3000) },
          receipt: "x".repeat(4096),
        });

        const opened =
          kind === "snapshot"
            ? await client.snapshots.get(selected)
            : await client.volumes.get(selected);

        if (cancelled)
          await expect(opened.delete({ signal: controller.signal })).rejects.toMatchObject({
            code: "UNAVAILABLE",
            effect: "none",
          });
        else expect(await opened.delete()).toMatchObject({ deleted: true });

        const token = z
          .object({ reference: z.object({ nativeId: z.string() }) })
          .parse(saved?.token);

        expect(token.reference.nativeId).toBe(selected.nativeId);
        expect(new TextEncoder().encode(JSON.stringify(saved?.token)).length).toBeLessThan(4096);
        const reopened = await f.connect(undefined, "rotated-key");

        try {
          const recovered = await reopened.recover(saved!);

          if (cancelled)
            await expect((await recovered.continue()).wait()).rejects.toMatchObject({
              code: "UNAVAILABLE",
              effect: "none",
            });
          else expect(await recovered.wait()).toMatchObject({ deleted: true });
          expect(f.calls.delete).toBe(cancelled ? 0 : 1);
        } finally {
          await reopened.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}

test("Daytona accepted legacy full-reference delete checkpoints still recover", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const volume = await client.volumes.create({ name: "legacy-delete" });
    const operation = await volume.submitDelete();
    const legacy = structuredClone(operation.reference);
    legacy.token = { reference: volume.reference, accepted: true, stage: "accepted" };
    expect(await (await client.recover(legacy)).wait()).toMatchObject({ deleted: true });
    expect(f.calls.delete).toBe(1);
  } finally {
    await client.close();
  }
});

test.each(["x".repeat(128), "🚀".repeat(64)])(
  "Daytona bounds advanced capture names and fresh recovery: %s",
  async (submissionId) => {
    const f = fixture();
    const client = await f.connect();
    let token: import("sandbar-adapter").Json | undefined;
    let tokenVersion: number | undefined;

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const plan = await source.checkSnapshot();

      if (plan.status !== "supported") throw new Error("capture unsupported");

      const prepared = await client.operations.prepare("snapshot_capture", {
        sandbox: { id: source.id },
        request: {},
      });

      const identity = {
        operationId: "advanced-capture",
        submissionId,
        invocationKey: "long-identity",
      };

      const result = await prepared.submit(identity, {
        beforeSubmit: async () => true,
        onCheckpoint: async (value, version) => {
          token = structuredClone(value);
          tokenVersion = version;
        },
      });

      expect(result).toMatchObject({ kind: "completed" });
      expect(z.object({ name: z.string() }).parse(token).name).toMatch(
        /^sandbar-capture-[a-f0-9]{64}$/,
      );
      const reopened = await f.connect(undefined, "rotated-key");

      try {
        expect(
          await reopened.operations.observe({
            scope: reopened.scope,
            kind: "snapshot_capture",
            operationId: identity.operationId,
            submissionId,
            sandboxId: source.id,
            capture: { profile: plan.value.profile, sourceState: plan.value.sourceState },
            token,
            tokenVersion,
          }),
        ).toMatchObject({ kind: "completed" });
        expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 1 });
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  },
);

test("Daytona capture recovery accepts bounded legacy names", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    const legacy = structuredClone(operation.reference);
    const token = z.record(z.string(), z.json()).parse(legacy.token);
    const name = `sandbar-capture-${legacy.submissionId}`;
    token.name = name;
    legacy.token = token;
    f.renameSnapshot(name);
    expect(await (await client.recover(legacy)).wait()).toMatchObject({
      snapshot: { reference: { nativeId: "snapshot-one" } },
    });
    expect(f.calls.capture).toBe(1);
  } finally {
    await client.close();
  }
});

test("Daytona initial capture checkpoint cancellation persists no-dispatch rejection", async () => {
  const f = fixture();
  const controller = new AbortController();
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect((ref) => {
    if (ref.kind !== "snapshot_capture" || !ref.token) return;
    saved = structuredClone(ref);
    controller.abort();
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });

    try {
      await source.snapshot(undefined, { signal: controller.signal });
    } catch (error) {
      expect(
        error instanceof WaitAbortedError ||
          (error instanceof SandbarError && error.effect === "none"),
      ).toBe(true);
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved?.token).toMatchObject({
      rejectedBeforeDispatch: true,
      captureState: "not-submitted",
      stopState: "not-submitted",
    });
    expect(f.calls).toMatchObject({ stop: 0, capture: 0, start: 0 });
    const before = { ...f.calls, reads: f.modes.sourceReads };
    const reopened = await f.connect(undefined, "rotated-key");

    try {
      const operation = await reopened.recover(saved!);
      await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
      await operation.continue();
      await expect(operation.wait()).rejects.toMatchObject({ effect: "none", code: "UNAVAILABLE" });
      expect({ ...f.calls, reads: f.modes.sourceReads }).toEqual(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await client.close();
  }
});

for (const status of [400, 401, 403, 422, 408, 429, 500]) {
  test(`Daytona volume HTTP ${status} preserves rejection or uncertainty without replay`, async () => {
    const f = fixture();
    f.modes.volumeCreateStatus = status;
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((ref) => {
      if (ref.kind === "volume_create") saved = structuredClone(ref);
    });

    const rejected = [400, 401, 403, 422].includes(status);

    try {
      const creation = client.volumes.create({ name: "native-status" });

      if (rejected) await expect(creation).rejects.toMatchObject({ effect: "none" });
      else await expect(creation).rejects.toBeInstanceOf(OutcomeUnknownError);
      expect(saved?.token).toMatchObject({ state: rejected ? "rejected" : "uncertain" });
      const reopened = await f.connect(undefined, "rotated-key");

      try {
        const operation = await reopened.recover(saved!);
        await operation.continue();

        if (rejected) await expect(operation.wait()).rejects.toMatchObject({ effect: "none" });
        else await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
        expect(f.volumeCreates()).toBe(1);
        expect(f.volumes.size).toBe(0);
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  });
}

for (const kind of ["snapshot_capture", "volume_create"] as const) {
  test(`Daytona ${kind} large scope custody fits checkpoints and recovers`, async () => {
    const f = fixture({ largeScope: true });
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((ref) => {
      if (ref.kind !== kind || !ref.token) return;
      expect(new TextEncoder().encode(JSON.stringify(ref.token)).length).toBeLessThanOrEqual(4096);
      saved = structuredClone(ref);
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });

      const resource =
        kind === "snapshot_capture"
          ? (await source.snapshot()).snapshot
          : await client.volumes.create({ name: "large-scope" });

      expect(saved).toBeDefined();
      const reopened = await f.connect(undefined, "rotated-key");

      try {
        const result = await (await reopened.recover(saved!)).wait();

        const recovered =
          kind === "snapshot_capture"
            ? z.object({ snapshot: z.instanceof(AdapterSnapshot) }).parse(result).snapshot
            : z.instanceof(AdapterVolume).parse(result);

        expect(recovered.reference).toEqual(resource.reference);
        expect(f.calls.capture).toBe(kind === "snapshot_capture" ? 1 : 0);
        expect(f.volumeCreates()).toBe(kind === "volume_create" ? 1 : 0);

        const handle =
          kind === "snapshot_capture"
            ? await reopened.snapshots.get(recovered.reference)
            : await reopened.volumes.get(recovered.reference);

        await handle.delete();
      } finally {
        await reopened.close();
      }
    } finally {
      await client.close();
    }
  });
}

test("Daytona delayed acknowledged capture remains recoverable after source deletion without replay", async () => {
  const f = fixture();
  f.modes.slowReads = 1;
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  f.modes.onSnapshotRead.callback = () => {
    offset = 61000;
  };

  const client = await f.connect();
  let saved;

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    saved = JSON.parse(JSON.stringify(operation.reference));
  } finally {
    Date.now = originalNow;
    f.modes.onSnapshotRead.callback = undefined;
    await client.close();
  }

  f.modes.sourceReadStatus = 404;
  const reopened = await f.connect(undefined, "current-key");

  try {
    const operation = await reopened.recover(saved);
    const error = await operation.wait().catch((error) => error);
    expect(error).toBeInstanceOf(OutcomeUnknownError);

    if (!(error instanceof SandbarError) || error.outcome?.kind !== "snapshot_capture") throw error;
    expect(error.outcome).toMatchObject({
      status: "partial",
      snapshot: { nativeId: "snapshot-one" },
      capture: { preserve: "filesystem" },
      restart: { status: "not-submitted" },
      source: { state: "stopped", observedAt: expect.any(String) },
    });
    const snapshot = await reopened.snapshots.get(error.outcome.snapshot!);
    expect((await snapshot.inspect()).state).toBe("ready");
    await expect((await operation.continue()).wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 0 });
  } finally {
    await reopened.close();
  }
});

test("Daytona a failed restart checkpoint retains confirmed capture without dispatching start", async () => {
  const f = fixture();

  const client = await f.connect((reference) => {
    if (
      reference.kind === "snapshot_capture" &&
      z.object({ stage: z.literal("restart") }).safeParse(reference.token).success
    )
      throw new Error("Durable write unavailable");
  });

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const error = await source.snapshot().catch((error: Error) => error);
    expect(error).toBeInstanceOf(SandbarError);
    expect(error).toMatchObject({
      code: "REFERENCE_SAVE_FAILED",
      outcome: {
        kind: "snapshot_capture",
        status: "partial",
        snapshot: { nativeId: "snapshot-one" },
        capture: { preserve: "filesystem" },
        restart: { status: "uncertain" },
      },
    });

    if (!(error instanceof SandbarError) || error.reference?.mode !== "direct")
      throw new Error("Expected latest checkpoint reference");
    expect(error.reference.token).toMatchObject({
      stage: "restart",
      captureState: "completed",
      snapshotId: "snapshot-one",
    });
    await client.close();
    const reopened = await f.connect();

    try {
      const recovered = await reopened.recover(JSON.parse(JSON.stringify(error.reference)));
      expect(recovered.reference).toEqual(JSON.parse(JSON.stringify(error.reference)));
      expect(recovered.kind).toBe("snapshot_capture");
    } finally {
      await reopened.close();
    }

    expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 0 });
  } finally {
    await client.close();
  }
});

test.each(["http", "network"] as const)(
  "Daytona source read outage after capture preserves the direct partial result: %s",
  async (outage) => {
    const f = fixture();
    let saved: AdapterRecoveryReference | undefined;

    const client = await f.connect((reference) => {
      if (reference.kind !== "snapshot_capture") return;
      saved = structuredClone(reference);

      if (z.object({ captureState: z.literal("completed") }).safeParse(reference.token).success) {
        f.modes.sourceReadStatus = outage === "http" ? 500 : -1;
      }
    });

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const error = await source.snapshot().catch((error) => error);
      expect(error).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: {
          kind: "snapshot_capture",
          status: "partial",
          snapshot: { nativeId: "snapshot-one" },
          capture: { preserve: "filesystem" },
          restart: { status: "not-submitted" },
        },
      });

      if (!(error instanceof SandbarError) || error.outcome?.kind !== "snapshot_capture")
        throw error;
      const reopened = await f.connect(undefined, "rotated-key");

      try {
        await expect((await reopened.recover(saved!)).wait()).rejects.toMatchObject({
          code: "OUTCOME_UNKNOWN",
          outcome: {
            status: "partial",
            snapshot: { nativeId: "snapshot-one" },
            source: { state: "stopped", observedAt: expect.any(String) },
          },
        });
        const snapshot = await reopened.snapshots.get(error.outcome.snapshot!);
        expect((await snapshot.inspect()).state).toBe("ready");
      } finally {
        await reopened.close();
      }

      expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: 0 });
    } finally {
      await client.close();
    }
  },
);

test.each([
  ["accepted", "metadata"],
  ["completed", "metadata"],
  ["accepted", "source"],
] as const)(
  "Daytona read outage preserves acknowledged capture identity: %s / %s",
  async (stage, outage) => {
    const f = fixture();
    f.modes.slowReads = stage === "accepted" ? 100 : 0;
    const originalNow = Date.now;
    let offset = 0;
    Date.now = () => originalNow() + offset;

    if (stage === "accepted")
      f.modes.onSnapshotRead.callback = () => {
        offset = 61000;
      };

    const client = await f.connect();
    let saved;

    try {
      const source = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await source.submitSnapshot();

      if (stage === "completed") await operation.wait();
      saved = JSON.parse(JSON.stringify(operation.reference));
    } finally {
      Date.now = originalNow;
      f.modes.onSnapshotRead.callback = undefined;
      await client.close();
    }

    if (outage === "source") f.modes.sourceReadStatus = 500;
    else f.modes.snapshotReadStatus = 500;
    const reopened = await f.connect(undefined, "current-key");

    try {
      const operation = await reopened.recover(saved);

      if (stage === "completed") {
        expect(await operation.wait()).toMatchObject({
          snapshot: { reference: { nativeId: "snapshot-one" } },
          capture: { preserve: "filesystem" },
          source: { state: "running", observedAt: expect.any(String) },
        });
      } else {
        const error = await operation.wait().catch((error) => error);
        expect(error).toBeInstanceOf(OutcomeUnknownError);

        if (!(error instanceof SandbarError) || error.outcome?.kind !== "snapshot_capture")
          throw error;
        expect(error.outcome).toMatchObject({
          kind: "snapshot_capture",
          status: "unknown",
          snapshot: { nativeId: "snapshot-one", kind: "snapshot" },
        });
        expect(error.outcome.capture).toBeUndefined();

        await operation.continue();
        await expect(operation.wait()).rejects.toMatchObject({
          code: "OUTCOME_UNKNOWN",
          outcome: {
            kind: "snapshot_capture",
            status: "unknown",
            snapshot: { nativeId: "snapshot-one", kind: "snapshot" },
          },
        });
      }

      expect(f.calls).toMatchObject({ stop: 1, capture: 1, start: stage === "completed" ? 1 : 0 });
    } finally {
      await reopened.close();
    }
  },
);
