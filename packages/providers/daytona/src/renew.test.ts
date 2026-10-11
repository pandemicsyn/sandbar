import { z } from "zod";
import { expect, test } from "bun:test";
import {
  Image,
  Sandbar,
  type AdapterRecoveryReference,
  type AdvancedObservation,
} from "sandbar-sdk";
import { createDaytonaAdapter } from "./adapter";

function expectedPreservation(action: "suspend" | "resume") {
  if (action === "suspend") return { preserve: "filesystem", processes: "terminated" };

  return {};
}

function fixture() {
  let creates = 0;
  let status = 200;
  let unavailable = false;
  let renewMode = "ok";
  let postStatus = 200;
  let authStatus = 200;
  let releasePost = () => {};

  let enteredPost = () => {};

  const postEntered = new Promise<void>((resolve) => {
    enteredPost = resolve;
  });

  const postHeld = new Promise<void>((resolve) => {
    releasePost = resolve;
  });

  const windows: number[] = [];
  let initialMinutes = 0;

  type CreationLabels = Record<string, string>;

  const labels: CreationLabels = {};

  const native = {
    id: "native-reopen",
    name: "",
    organizationId: "org-1",
    target: "us",
    state: "started",
    labels,
    networkBlockAll: true,
    public: false,
    autoDestroyAt: "2026-10-01T01:00:00Z",
    autoStopInterval: 5,
    autoDeleteInterval: -1,
    sandboxClass: "container",
    // SAFETY: This deterministic fixture allows omitted native mount metadata.
    volumes: [] as { volumeId: string; mountPath: string }[] | undefined,
  };

  const calls: string[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" }, { status: authStatus });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots/prepared")
        return Response.json({
          id: "prepared",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/sandbox" && method === "POST") {
        creates++;
        initialMinutes = JSON.parse(String(init?.body)).ttlMinutes;
        Object.assign(native, JSON.parse(String(init?.body)));

        return Response.json(native);
      }

      if (url.pathname === "/api/sandbox" && method === "GET")
        return Response.json({ items: [native] });

      if (
        ["/api/sandbox/native-reopen/stop", "/api/sandbox/native-reopen/start"].includes(
          url.pathname,
        )
      ) {
        enteredPost();

        if (renewMode === "hold") await postHeld;
        native.state = url.pathname.endsWith("/stop") ? "stopped" : "started";

        if (renewMode === "lost") throw new TypeError("lost ACK");

        if (renewMode === "get-failed") unavailable = true;

        return new Response(null, { status: postStatus });
      }

      if (url.pathname.startsWith("/api/sandbox/native-reopen/ttl/")) {
        expect(method).toBe("POST");
        windows.push(Number(url.pathname.split("/").at(-1)) * 60);
        enteredPost();

        if (renewMode === "hold") await postHeld;

        if (renewMode === "lost") throw new TypeError("lost ACK");

        if (renewMode === "get-failed") unavailable = true;

        return Response.json(native, { status: postStatus });
      }

      if (url.pathname === "/api/sandbox/native-reopen") {
        if (unavailable) throw new TypeError("offline transport fault");

        return Response.json(native, { status });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  const adapter = createDaytonaAdapter(fetcher);

  return {
    native,
    calls,
    creates: () => creates,
    windows,
    initialMinutes: () => initialMinutes,
    renewMode(value: string) {
      renewMode = value;
    },
    postStatus(value: number) {
      postStatus = value;
    },
    authStatus(value: number) {
      authStatus = value;
    },
    postEntered,
    releasePost,
    connect: (
      config: {
        ttlMinutes?: number;
        lifecycle?: {
          lifetimeSeconds?: number;
          suspension?: { preserve: "filesystem" | "filesystem+memory" };
        };
        target?: string;
      } = {},
      onReference?: (ref: AdapterRecoveryReference) => void | Promise<void>,
      key = "first-key",
    ) =>
      Sandbar.connect({
        adapter,
        config: { target: "us", ...config },
        credentials: { apiKey: key },
        onReference,
      }),
    status(value: number) {
      status = value;
    },
    available() {
      unavailable = false;
    },
    unavailable() {
      unavailable = true;
    },
  };
}

async function create(
  f: ReturnType<typeof fixture>,
  config: Parameters<ReturnType<typeof fixture>["connect"]>[0] = {},
  onReference?: Parameters<ReturnType<typeof fixture>["connect"]>[1],
) {
  const client = await f.connect(config, onReference);
  const box = await client.sandboxes.create({ environment: Image.prepared("prepared") });

  return { client, box };
}

test("Daytona configured/default/explicit lifetime resolves upward once and stays outside identity", async () => {
  for (const [config, expected] of [
    [{}, 3600],
    [{ ttlMinutes: 15 }, 900],
    [{ lifecycle: { lifetimeSeconds: 61 } }, 120],
  ] as const) {
    const f = fixture();
    const { client, box } = await create(f, config);

    try {
      expect(f.initialMinutes()).toBe(expected / 60);
      const original = JSON.stringify(box.reference);
      expect((await box.renew()).requested).toEqual({ forSeconds: expected });
      expect((await box.renew({ forSeconds: 61 })).requested).toEqual({ forSeconds: 120 });
      expect((await box.renew({ forSeconds: 1 })).requested).toEqual({ forSeconds: 60 });
      expect((await box.renew({ forSeconds: 86400 })).requested).toEqual({ forSeconds: 86400 });
      expect(f.windows).toEqual([expected, 120, 60, 86400]);
      expect(JSON.stringify(box.reference)).toBe(original);
      expect((await box.capabilities()).lifecycle?.renew).toMatchObject({
        status: "supported",
        value: { maxSeconds: 86400, stepSeconds: 60, scope: "sandbox" },
      });
    } finally {
      await client.close();
    }
  }
});

test("Daytona renewal validation, identity, state and credential gates precede the POST", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    for (const forSeconds of [
      0,
      -1,
      1.2,
      86401,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
      NaN,
    ])
      await expect(box.renew({ forSeconds })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        effect: "none",
      });

    for (const state of ["stopped", "archived", "creating", "future"]) {
      f.native.state = state;
      await expect(box.renew()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
    }

    f.native.state = "started";
    f.native.labels["sandbar.operation"] = "forged";
    await expect(box.renew()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });
    expect(f.windows).toEqual([]);
  } finally {
    await client.close();
  }

  for (const config of [
    { ttlMinutes: 1, lifecycle: { lifetimeSeconds: 60 } },
    { lifecycle: { lifetimeSeconds: 86401 } },
    { lifecycle: { lifetimeSeconds: 0 } },
  ]) {
    const before = f.calls.length;
    await expect(f.connect(config)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(f.calls.length).toBe(before);
  }
});

test("Daytona ACK survives failed GET and failed compatibility checkpoint save; serialized ACK uses old resolved intent", async () => {
  const f = fixture();
  let saved: AdapterRecoveryReference | undefined;

  const { client, box } = await create(f, { lifecycle: { lifetimeSeconds: 61 } }, (ref) => {
    saved = ref;
  });

  f.renewMode("get-failed");
  const result = await box.renew();
  expect(result).toMatchObject({
    acknowledged: true,
    requested: { forSeconds: 120 },
    observation: null,
  });
  const receipt = JSON.parse(JSON.stringify(saved));
  expect(receipt.renewal).toEqual({ forSeconds: 120 });
  await client.close();
  const fresh = await f.connect({ lifecycle: { lifetimeSeconds: 600 } }, undefined, "new-key");

  try {
    const op = await fresh.recover(receipt);
    expect(op.kind).toBe("sandbox_renew");

    if (op.kind !== "sandbox_renew") throw Error("kind");
    expect(await op.wait()).toEqual(result);
    expect(f.windows).toEqual([120]);
  } finally {
    await fresh.close();
  }

  const g = fixture();

  const setup = await create(g, {}, (ref) => {
    if (ref.kind === "sandbox_renew" && ref.token) throw Error("storage failed");
  });

  try {
    expect((await setup.box.renew()).acknowledged).toBe(true);
    expect(g.windows).toEqual([3600]);
  } finally {
    await setup.client.close();
  }
});

test("Daytona lost ACK remains uncertain across repeated reads/fresh defaults, never another reset", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.renewMode("lost");
  const op = await box.submitRenew({ forSeconds: 61 });

  for (let i = 0; i < 2; i++)
    await expect(op.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  await expect(op.observe()).rejects.toMatchObject({
    code: "OUTCOME_UNKNOWN",
    outcome: {
      kind: "sandbox_renew",
      requested: { forSeconds: 120 },
      observation: { state: "running" },
    },
  });
  const saved = JSON.parse(JSON.stringify(op.reference));
  await client.close();
  const next = await f.connect({ ttlMinutes: 2 });

  try {
    const recovered = await next.recover(saved);
    await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(recovered.continue()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(f.windows).toEqual([120]);
  } finally {
    await next.close();
  }
});

test("Daytona native rejection remains definitive without clamping/retry", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.postStatus(422);

  try {
    await expect(box.renew({ forSeconds: 600 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
    expect(f.windows).toEqual([600]);
  } finally {
    await client.close();
  }
});

test("Daytona cancellation before dispatch vs after one held POST", async () => {
  const f = fixture();
  let release = () => {};

  let entered = () => {};

  const held = new Promise<void>((r) => {
    release = r;
  });

  const barrier = new Promise<void>((r) => {
    entered = r;
  });

  const { client, box } = await create(f, {}, async (ref) => {
    if (ref.kind === "sandbox_renew") {
      entered();
      await held;
    }
  });

  const pre = new AbortController();
  const submitting = box.renew(undefined, { signal: pre.signal });
  await barrier;
  pre.abort();
  await expect(submitting).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
  release();
  await Bun.sleep(10);
  expect(f.windows).toEqual([]);
  await client.close();
  const g = fixture();
  const setup = await create(g);
  g.renewMode("hold");
  const post = new AbortController();
  const pending = setup.box.renew(undefined, { signal: post.signal });
  await g.postEntered;
  post.abort();
  await expect(pending).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "possible",
    reference: { kind: "sandbox_renew", renewal: { forSeconds: 3600 } },
  });
  g.releasePost();
  await Bun.sleep(10);
  expect(g.windows).toEqual([3600]);
  await setup.client.close();
});

test("daytona renewal rejects a mismatched provider/scope before native reads", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    for (const reference of [
      { ...box.reference!, provider: "different" },
      {
        ...box.reference!,
        scope: {
          ...box.reference!.scope,
          authority: { kind: box.reference!.scope.authority.kind, id: "different" },
        },
      },
    ]) {
      const count = f.calls.length;
      await expect(
        client.operations.prepare("sandbox_renew", {
          sandbox: { id: box.id, reference },
          forSeconds: 60,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(f.calls.length).toBe(count);
    }
  } finally {
    await client.close();
  }
});

test("Daytona renewal uses current credentials and preserves native detail denial before POST", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.status(403);

  try {
    await expect(box.renew()).rejects.toMatchObject({ code: "FORBIDDEN", effect: "none" });
    expect(f.windows).toEqual([]);
  } finally {
    await client.close();
  }
});

test("advanced renewal ledger saves resolved intent before dispatch and recovers without replay", async () => {
  for (const explicit of [false, true]) {
    for (const lost of [false, true]) {
      const f = fixture();
      const { client, box } = await create(f, { lifecycle: { lifetimeSeconds: 61 } });

      if (!box.reference) throw Error("Missing sandbox reference");

      const sandbox = { id: box.id, reference: box.reference };

      const prepared = await client.operations.prepare(
        "sandbox_renew",
        explicit ? { sandbox, forSeconds: 61 } : { sandbox },
      );

      expect(prepared.renewal).toEqual({ forSeconds: 120 });
      // Mutating a caller's copy cannot change the intent saved or dispatched.
      Object.assign(prepared.renewal ?? {}, { forSeconds: 600 });
      expect(prepared.renewal).toEqual({ forSeconds: 120 });
      let saved: AdvancedObservation | undefined;

      if (lost) f.renewMode("lost");

      try {
        await prepared.submit(
          { operationId: "renew-op", submissionId: "renew-sub", invocationKey: "renew-key" },
          {
            beforeSubmit: async () => {
              expect(f.windows).toEqual([]);
              saved = JSON.parse(
                JSON.stringify({
                  scope: client.scope,
                  kind: "sandbox_renew",
                  operationId: "renew-op",
                  submissionId: "renew-sub",
                  sandboxId: box.id,
                  sandboxReference: box.reference,
                  renewal: prepared.renewal,
                }),
              );

              return true;
            },
            onCheckpoint: async (token, tokenVersion) => {
              if (!saved) throw Error("Missing submission marker");
              saved = JSON.parse(JSON.stringify({ ...saved, token, tokenVersion }));
            },
          },
        );
      } finally {
        await client.close();
      }

      if (!saved) throw Error("Missing saved renewal");
      expect(saved.renewal).toEqual({ forSeconds: 120 });
      const fresh = await f.connect({ lifecycle: { lifetimeSeconds: 600 } });

      try {
        const result = await fresh.operations.observe(saved);

        if (lost) {
          expect(result).toMatchObject({
            kind: "unknown",
            outcome: { requested: { forSeconds: 120 } },
          });
        } else {
          expect(result).toMatchObject({
            kind: "completed",
            value: { acknowledged: true, requested: { forSeconds: 120 } },
          });
        }

        expect(f.windows).toEqual([120]);
      } finally {
        await fresh.close();
      }
    }
  }
});

test("Daytona suspend/resume native defaults and saved-reference workflow retain identity", async () => {
  for (const preserve of [undefined, "filesystem", "filesystem"] as const) {
    const f = fixture();

    const config: Parameters<ReturnType<typeof fixture>["connect"]>[0] = {
      lifecycle: { lifetimeSeconds: 61 },
    };

    if (preserve) config.lifecycle!.suspension = { preserve };
    const { client, box } = await create(f, config);

    try {
      const saved = JSON.parse(JSON.stringify(box.reference));
      const before = await box.inspect();
      const caps = await box.capabilities();
      expect(caps.lifecycle?.suspend).toMatchObject({
        status: "supported",
        value: { preserve: "filesystem", processes: "terminated", connections: "dropped" },
      });
      const op = await box.submitSuspend();
      const suspended = await op.wait();
      expect(suspended).toMatchObject({
        reference: saved,
        preserve: "filesystem",
        processes: "terminated",
        connections: "dropped",
        observation: { state: "stopped" },
      });
      expect(suspended.observation.expires).toEqual(before.expires);
      await expect(box.suspend()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });

      const fresh = await f.connect(
        { lifecycle: { lifetimeSeconds: 600 } },
        undefined,
        "rotated-key",
      );

      try {
        const reopened = await fresh.sandboxes.get(saved);
        expect((await reopened.inspect()).state).toBe("stopped");
        expect((await reopened.capabilities()).lifecycle?.resume.status).toBe("supported");

        const beforeCalls = f.calls.filter(
          (c) =>
            c === "POST /api/sandbox/native-reopen/stop" ||
            c === "POST /api/sandbox/native-reopen/start",
        ).length;

        await expect(reopened.exec(["true"])).rejects.toThrow();
        await expect(reopened.readFile("/file")).rejects.toThrow();
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(beforeCalls);
        const resumed = await reopened.resume();
        expect(resumed).toMatchObject({
          reference: saved,
          execution: "fresh",
          executionIdentity: { status: "unknown" },
          observation: { state: "running" },
        });
        await expect(reopened.resume()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });
        expect(reopened.reference).toEqual(saved);
        const recovered = await fresh.recover(JSON.parse(JSON.stringify(op.reference)));

        if (recovered.kind !== "sandbox_suspend") throw Error("kind");
        expect(await recovered.wait()).toEqual(suspended);
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(2);
        expect(resumed.observation.expires).toEqual(before.expires);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  }
});

test.each(["mounted", "unknown-mounts", "transition", "missing", "class", "auto-delete"])(
  "Daytona lifecycle gate %s rejects before POST",
  async (gate) => {
    const f = fixture();
    const { client, box } = await create(f);

    try {
      if (gate === "mounted") f.native.volumes = [{ volumeId: "vol", mountPath: "/mnt" }];

      if (gate === "unknown-mounts") f.native.volumes = undefined;

      if (gate === "transition") f.native.state = "stopping";

      if (gate === "missing") f.status(404);

      if (gate === "class") f.native.sandboxClass = "linux-vm";

      if (gate === "auto-delete") f.native.autoDeleteInterval = 0;
      await expect(box.suspend()).rejects.toMatchObject({
        code:
          gate === "missing"
            ? "NOT_FOUND"
            : gate === "mounted" || gate === "class"
              ? "UNSUPPORTED"
              : "UNAVAILABLE",
        effect: "none",
      });
      expect(
        f.calls.filter(
          (c) =>
            c === "POST /api/sandbox/native-reopen/stop" ||
            c === "POST /api/sandbox/native-reopen/start",
        ),
      ).toHaveLength(0);
    } finally {
      await client.close();
    }
  },
);

test.each(["suspend", "resume"] as const)(
  "Daytona %s ACK preserves partial facts and fresh-client recovery never replays",
  async (action) => {
    const f = fixture();
    let saved: AdapterRecoveryReference | undefined;

    const { client, box } = await create(f, { lifecycle: { lifetimeSeconds: 61 } }, (ref) => {
      if (ref.kind === `sandbox_${action}`) saved = JSON.parse(JSON.stringify(ref));
    });

    if (action === "resume") f.native.state = "stopped";
    f.renewMode("get-failed");

    try {
      const op = action === "suspend" ? await box.submitSuspend() : await box.submitResume();
      await expect(op.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: {
          kind: `sandbox_${action}`,
          status: "partial",
          acknowledged: true,
          observation: null,
          ...expectedPreservation(action),
        },
      });
      expect(saved?.lifecycle).toEqual(
        action === "suspend" ? { action, preserve: "filesystem" } : { action },
      );
      f.available();

      const fresh = await f.connect(
        { lifecycle: { lifetimeSeconds: 600 } },
        undefined,
        "rotated-key",
      );

      try {
        const recovered = await fresh.recover(saved!);
        expect(await recovered.wait()).toMatchObject({ reference: box.reference });
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(1);
        // A confirmed read is historical evidence: later external state change or failed metadata cannot erase it.
        f.native.state = "stopping";
        f.renewMode("get-failed");
        f.unavailable();
        const again = await fresh.recover(JSON.parse(JSON.stringify(recovered.reference)));
        expect(await again.wait()).toEqual(await recovered.wait());
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(1);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  },
);

test.each(["lost", "409", "503"])(
  "Daytona suspend unacknowledged %s remains unknown despite matching state",
  async (mode) => {
    const f = fixture();
    const { client, box } = await create(f);

    if (mode === "lost") f.renewMode(mode);
    else f.postStatus(Number(mode));

    try {
      const op = await box.submitSuspend();
      await expect(op.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { status: "unknown", acknowledged: false, observation: { state: "stopped" } },
      });
      const recovered = await client.recover(JSON.parse(JSON.stringify(op.reference)));
      await expect(recovered.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { acknowledged: false },
      });
      expect(
        f.calls.filter(
          (c) =>
            c === "POST /api/sandbox/native-reopen/stop" ||
            c === "POST /api/sandbox/native-reopen/start",
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test("Daytona lifecycle cancellation before dispatch has no effect; after dispatch only stops local wait", async () => {
  const f = fixture();
  const pre = new AbortController();

  const { client, box } = await create(f, {}, (ref) => {
    if (ref.kind === "sandbox_suspend") pre.abort();
  });

  try {
    await expect(box.suspend({ signal: pre.signal })).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      effect: "none",
    });
    expect(
      f.calls.filter(
        (c) =>
          c === "POST /api/sandbox/native-reopen/stop" ||
          c === "POST /api/sandbox/native-reopen/start",
      ),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }

  const g = fixture();
  const post = new AbortController();
  const setup = await create(g);
  g.renewMode("hold");

  try {
    const waiting = setup.box.suspend({ signal: post.signal });
    await g.postEntered;
    post.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      effect: "possible",
      reference: { kind: "sandbox_suspend" },
    });
    g.releasePost();
    expect(
      g.calls.filter(
        (c) =>
          c === "POST /api/sandbox/native-reopen/stop" ||
          c === "POST /api/sandbox/native-reopen/start",
      ),
    ).toHaveLength(1);
  } finally {
    g.releasePost();
    await setup.client.close();
  }
});

test("Daytona rejects memory minimum at connection before allocation", async () => {
  const f = fixture();
  await expect(
    f.connect({ lifecycle: { suspension: { preserve: "filesystem+memory" } } }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls).toHaveLength(0);
});

test.each(["suspend", "resume"] as const)(
  "Daytona %s cancellation after ACK retains native facts",
  async (action) => {
    for (const completed of [false, true]) {
      const f = fixture();
      const abort = new AbortController();

      const { client, box } = await create(f, {}, (ref) => {
        if (
          ref.kind === `sandbox_${action}` &&
          ref.token &&
          z
            .object({ acknowledged: z.literal(true), completed: z.json().optional() })
            .safeParse(ref.token).success &&
          !!z.object({ completed: z.json().optional() }).parse(ref.token).completed === completed
        )
          abort.abort();
      });

      if (action === "resume") f.native.state = "stopped";

      try {
        await expect(
          action === "suspend"
            ? box.suspend({ signal: abort.signal })
            : box.resume({ signal: abort.signal }),
        ).rejects.toMatchObject({
          code: "WAIT_ABORTED",
          outcome: {
            kind: `sandbox_${action}`,
            status: completed ? "completed" : "partial",
            acknowledged: true,
            ...expectedPreservation(action),
          },
        });
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  },
);

test.each(["suspend", "resume"] as const)(
  "Daytona %s checkpoint callback failure does not erase confirmed success",
  async (action) => {
    const f = fixture();

    const { client, box } = await create(f, {}, (ref) => {
      if (ref.kind === `sandbox_${action}` && ref.token) throw Error("storage failed");
    });

    if (action === "resume") f.native.state = "stopped";

    try {
      const result = action === "suspend" ? await box.suspend() : await box.resume();
      expect(result.reference).toEqual(box.reference!);
      expect(
        f.calls.filter(
          (c) =>
            c === "POST /api/sandbox/native-reopen/stop" ||
            c === "POST /api/sandbox/native-reopen/start",
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test.each(["lost", "409", "503"])(
  "Daytona resume %s cannot attribute observed running state",
  async (mode) => {
    const f = fixture();
    const { client, box } = await create(f);
    f.native.state = "stopped";

    if (mode === "lost") f.renewMode(mode);
    else f.postStatus(Number(mode));

    try {
      const op = await box.submitResume();
      await expect(op.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { status: "unknown", acknowledged: false, observation: { state: "running" } },
      });
      const recovered = await client.recover(JSON.parse(JSON.stringify(op.reference)));
      await expect(recovered.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { acknowledged: false },
      });
      expect(
        f.calls.filter(
          (c) =>
            c === "POST /api/sandbox/native-reopen/stop" ||
            c === "POST /api/sandbox/native-reopen/start",
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test("Daytona inactive mounted/unknown resources cannot resume and capabilities agree", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.native.state = "stopped";

  try {
    f.native.volumes = [{ volumeId: "v", mountPath: "/mnt" }];
    await expect(box.resume()).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect((await box.capabilities()).lifecycle?.resume.status).toBe("unsupported");
    f.native.volumes = undefined;
    await expect(box.resume()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
    f.status(404);
    await expect(box.resume()).rejects.toMatchObject({ code: "NOT_FOUND", effect: "none" });
    expect(
      f.calls.filter(
        (c) =>
          c === "POST /api/sandbox/native-reopen/stop" ||
          c === "POST /api/sandbox/native-reopen/start",
      ),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("Daytona archived resume starts the same UUID once without resetting hard TTL", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.native.state = "archived";

  try {
    const deadline = (await box.inspect()).expires;
    const result = await box.resume();
    expect(result.observation.expires).toEqual(deadline);
    expect(result.reference.nativeId).toBe(box.id);
    expect(result.execution).toBe("fresh");
    expect(f.calls.filter((c) => c === "POST /api/sandbox/native-reopen/start")).toHaveLength(1);
    expect(f.windows).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test.each(["suspend", "resume"] as const)(
  "Daytona %s recovery persistence failure retains confirmed lifecycle facts",
  async (action) => {
    const f = fixture();
    const { client, box } = await create(f);

    if (action === "resume") f.native.state = "stopped";
    f.renewMode("get-failed");

    try {
      const op = action === "suspend" ? await box.submitSuspend() : await box.submitResume();

      f.available();

      const fresh = await f.connect({}, () => {
        throw Error("storage failed");
      });

      try {
        const recovered = await fresh.recover(JSON.parse(JSON.stringify(op.reference)));
        await expect(recovered.wait()).rejects.toMatchObject({
          code: "OUTCOME_UNKNOWN",
          outcome: {
            kind: `sandbox_${action}`,
            status: "completed",
            acknowledged: true,
            observation: { state: action === "suspend" ? "stopped" : "running" },
            ...expectedPreservation(action),
          },
        });
        expect(await recovered.wait()).toMatchObject({ reference: box.reference });
        expect(
          f.calls.filter(
            (c) =>
              c === "POST /api/sandbox/native-reopen/stop" ||
              c === "POST /api/sandbox/native-reopen/start",
          ),
        ).toHaveLength(1);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  },
);
