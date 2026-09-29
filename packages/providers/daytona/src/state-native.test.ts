import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, SnapshotInfo } from "sandbar-adapter";
import { Sandbar, Image, OutcomeUnknownError, WaitAbortedError } from "sandbar-sdk";
import { daytonaState } from "./state-native";

interface FixtureStartHook {
  callback?: () => void;
}

function fixture(options: { stopped?: boolean; restartAfterCapture?: boolean } = {}) {
  const scope = { authority: { kind: "organization", id: "org-one" }, partition: { target: "us" } };
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

  const modes = {
    mounted: false,
    stopLost: false,
    captureLost: false,
    captureRejected: false,
    restartLost: false,
    restartRejected: false,
    failedDelete: false,
    poolsDenied: false,
    sharedSnapshot: false,
    pools: 0,
    slowReads: 0,
    snapshotReads: 0,
    sourceReads: 0,
    onSourceRead: sourceHook,
    onStart: startHook,
    onSnapshotRead: snapshotHook,
  };

  const calls = { stop: 0, capture: 0, start: 0, delete: 0, poolReads: 0 };

  // SAFETY: This deterministic native boundary matches the fetch call and preconnect contract.
  const fetcher = Object.assign(
    async (value: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(value));
      const method = init?.method ?? "GET";

      if (url.pathname === "/sandbox/source") {
        modes.sourceReads++;
        modes.onSourceRead.callback?.();

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
        state = "stopped";

        if (modes.stopLost) throw new Error("Lost stop acknowledgement");

        return Response.json({});
      }

      if (url.pathname === "/sandbox/source/start" && method === "POST") {
        calls.start++;
        modes.onStart.callback?.();
        await Promise.resolve();

        if (modes.restartRejected) return new Response(null, { status: 422 });
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
          snapshot = null;

          return new Response(null, { status: modes.failedDelete ? 500 : 204 });
        }

        const id = decodeURIComponent(url.pathname.slice("/snapshots/".length));

        if (snapshot) {
          modes.snapshotReads++;
          modes.onSnapshotRead.callback?.();
        }

        return snapshot && (snapshot.id === id || snapshot.name === id)
          ? Response.json({
              ...snapshot,
              state: modes.snapshotReads <= modes.slowReads ? "creating" : snapshot.state,
              general: modes.sharedSnapshot,
            })
          : new Response(null, { status: 404 });
      }

      if (url.pathname === "/volumes") return Response.json([]);
      throw new Error(`Unexpected native fixture route: ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const connect = (onReference?: (ref: { kind: string }) => void) => {
    const resource = daytonaState({
      scope,
      apiUrl: "https://fixture.invalid",
      apiKey: "fixture-key",
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
    calls,
    modes,
    state: () => state,
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

test("Daytona retained capture remains inspectable and owned when source restart fails", async () => {
  const f = fixture();
  f.modes.restartRejected = true;
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await source.submitSnapshot();
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);

    const token = z
      .object({
        captureState: z.literal("completed"),
        snapshot: SnapshotInfo,
        restartFailure: z.string(),
      })
      .parse(operation.reference.token);

    expect(token.snapshot.reference.ownership).toBe("verified-created");
    expect(token.snapshot.restoreExecution).toBe("fresh");
    await expect((await client.recover(operation.reference)).wait()).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(f.calls.capture).toBe(1);
    expect(f.calls.start).toBe(1);
    await (await client.snapshots.get(token.snapshot.reference)).delete();
  } finally {
    await client.close();
  }
});

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

test("Daytona lost delete acknowledgement remains unknown despite absence", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const source = await client.sandboxes.create({ environment: Image.prepared("base") });
    const result = await source.snapshot();
    f.modes.failedDelete = true;
    const operation = await result.snapshot.submitDelete();
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    await expect((await client.recover(operation.reference)).wait()).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
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

    const token = z
      .object({
        captureState: z.literal("completed"),
        snapshot: SnapshotInfo,
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
    await (await client.snapshots.get(token.snapshot.reference)).delete();
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
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const saved = structuredClone(operation.reference);
    expect(saved.token).toMatchObject({
      snapshotId: "snapshot-one",
      snapshot: { reference: { nativeId: "snapshot-one" } },
    });
    f.replaceSnapshot();
    f.setState("started");
    const recovered = await client.recover(saved);
    await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
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
