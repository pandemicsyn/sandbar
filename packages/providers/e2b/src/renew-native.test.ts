import { z } from "zod";
import { afterEach, expect, test } from "bun:test";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import { createSdkTransport } from "./transport";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type NativeFixtureDetail = {
  sandboxID: string;
  templateID: string;
  metadata: Record<string, string>;
  state: string;
  envdVersion: string;
  envdAccessToken: string;
  domain: string;
  network: { allowPublicTraffic: boolean };
  lifecycle?: { onTimeout?: string; autoResume?: boolean };
  endAt: string;
  volumeMounts?: { name: string; path: string }[];
};

const NativePayload = z.object({
  timeout: z.number().int().optional(),
  memory: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  autoPause: z.boolean().optional(),
  autoResume: z.object({ enabled: z.boolean() }).optional(),
});

function expectedPreservation(action: "suspend" | "resume") {
  if (action === "suspend") return { preserve: "filesystem+memory", processes: "preserved" };

  return {};
}

function fixture() {
  const calls: {
    method: string;
    path: string;
    key: string | null;
    body?: z.infer<typeof NativePayload>;
  }[] = [];

  const detail: NativeFixtureDetail = {
    sandboxID: "sandbox_one",
    templateID: "template_one",
    metadata: {},
    state: "running",
    envdVersion: "0.5.0",
    envdAccessToken: "guest-token",
    domain: "e2b.app",
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    endAt: "2026-10-01T01:00:00Z",
    volumeMounts: [],
  };

  let mode = "ok",
    postStatus = 204,
    authStatus = 200,
    failedRead = false;

  let detailStatus = 200;

  let entered = () => {},
    release = () => {};

  const postEntered = new Promise<void>((r) => {
    entered = r;
  });

  const held = new Promise<void>((r) => {
    release = r;
  });

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      const body =
        request.method === "POST" ? NativePayload.parse(await request.json()) : undefined;

      calls.push({
        method: request.method,
        path: url.pathname,
        key: request.headers.get("X-API-Key"),
        body,
      });

      if (url.pathname.startsWith("/teams/")) return Response.json({}, { status: authStatus });

      if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
        detail.metadata = body!.metadata!;

        return Response.json(detail, { status: 201 });
      }

      if (
        ["/sandboxes/sandbox_one/pause", "/v2/sandboxes/sandbox_one/connect"].includes(url.pathname)
      ) {
        entered();

        if (mode === "hold") await held;
        detail.state = url.pathname.endsWith("/pause") ? "paused" : "running";

        if (mode === "lost") throw new TypeError("lost ACK");

        if (mode === "get-failed") failedRead = true;

        return new Response(null, { status: postStatus });
      }

      if (url.pathname === "/sandboxes/sandbox_one/timeout") {
        entered();

        if (mode === "hold") await held;

        if (mode === "lost") throw new TypeError("lost ACK");

        if (mode === "get-failed") failedRead = true;

        return new Response(null, { status: postStatus });
      }

      if (url.pathname === "/sandboxes/sandbox_one") {
        if (failedRead) throw new TypeError("read failed");

        return Response.json(detail, { status: detailStatus });
      }

      throw Error(`Unexpected fixture ${request.method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  const connect = (
    config: {
      timeoutSeconds?: number;
      lifecycle?: {
        lifetimeSeconds?: number;
        suspension?: { preserve: "filesystem" | "filesystem+memory" };
      };
      teamId?: string;
    } = {},
    onReference?: (ref: AdapterRecoveryReference) => void | Promise<void>,
    key = "first-key",
  ) =>
    Sandbar.connect({
      adapter: createE2BAdapter(({ apiKey }) => createSdkTransport(apiKey, fetcher)),
      config: { teamId: "team_one", ...config },
      credentials: { apiKey: key },
      onReference,
    });

  return {
    calls,
    detail,
    connect,
    postEntered,
    release,
    status(v: number) {
      detailStatus = v;
    },
    available() {
      failedRead = false;
    },
    mode(v: string) {
      mode = v;
    },
    postStatus(v: number) {
      postStatus = v;
    },
    authStatus(v: number) {
      authStatus = v;
    },
    windows: () => calls.flatMap((c) => (c.path.endsWith("/timeout") ? [c.body?.timeout] : [])),
  };
}

async function create(
  f: ReturnType<typeof fixture>,
  config: Parameters<ReturnType<typeof fixture>["connect"]>[0] = {},
  onReference?: Parameters<ReturnType<typeof fixture>["connect"]>[1],
) {
  const client = await f.connect(config, onReference);
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { client, box };
}

test("E2B native create and renewal share configured lifetime; resolved seconds and one POST", async () => {
  for (const [config, expected] of [
    [{}, 300],
    [{ timeoutSeconds: 120 }, 120],
    [{ lifecycle: { lifetimeSeconds: 1 } }, 60],
    [{ lifecycle: { lifetimeSeconds: 61 } }, 61],
  ] as const) {
    const f = fixture();
    const { client, box } = await create(f, config);

    try {
      const allocation = f.calls.find((c) => c.method === "POST" && c.path === "/v2/sandboxes")!;
      expect(allocation.body).toMatchObject({
        timeout: expected,
        autoPause: false,
        autoResume: { enabled: false },
      });
      const identity = JSON.stringify(box.reference);
      expect((await box.renew()).requested.forSeconds).toBe(expected);
      expect((await box.renew({ forSeconds: 1 })).requested.forSeconds).toBe(60);
      expect((await box.renew({ forSeconds: 61 })).requested.forSeconds).toBe(61);
      expect((await box.renew({ forSeconds: 3600 })).requested.forSeconds).toBe(3600);
      expect(f.windows()).toEqual([expected, 60, 61, 3600]);
      expect(JSON.stringify(box.reference)).toBe(identity);
      expect((await box.inspect()).expires).toMatchObject({
        status: "known",
        at: f.detail.endAt,
        scope: "running-session",
      });
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(5);
    } finally {
      await client.close();
    }
  }
});

test("E2B bounds/conflicts/identity/state/current credentials reject before POST", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    for (const forSeconds of [
      0,
      -1,
      1.1,
      3601,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      Infinity,
      NaN,
    ])
      await expect(box.renew({ forSeconds })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        effect: "none",
      });

    for (const state of ["paused", "unknown", "starting"]) {
      f.detail.state = state;
      await expect(box.renew()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
    }

    f.detail.state = "running";
    const metadata = f.detail.metadata;
    f.detail.metadata = { ...metadata, sandbar_operation: "forged" };
    await expect(box.renew()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });
    f.detail.metadata = metadata;
    f.authStatus(403);
    await expect(box.renew()).rejects.toMatchObject({ code: "FORBIDDEN", effect: "none" });
    f.authStatus(200);
    expect(f.windows()).toEqual([]);
  } finally {
    await client.close();
  }

  for (const config of [
    { timeoutSeconds: 60, lifecycle: { lifetimeSeconds: 60 } },
    { lifecycle: { lifetimeSeconds: 3601 } },
    { lifecycle: { lifetimeSeconds: 0 } },
  ]) {
    const before = f.calls.length;
    await expect(f.connect(config)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(f.calls.length).toBe(before);
  }
});

test("E2B ACK + failed GET is confirmed and saved intent survives fresh defaults/key rotation", async () => {
  const f = fixture();
  let saved: AdapterRecoveryReference | undefined;

  const { client, box } = await create(f, { lifecycle: { lifetimeSeconds: 61 } }, (ref) => {
    saved = ref;
  });

  f.mode("get-failed");
  const result = await box.renew();
  expect(result).toMatchObject({
    acknowledged: true,
    requested: { forSeconds: 61 },
    observation: null,
  });
  const receipt = JSON.parse(JSON.stringify(saved));
  await client.close();
  const next = await f.connect({ timeoutSeconds: 120 }, undefined, "new-key");

  try {
    const op = await next.recover(receipt);

    if (op.kind !== "sandbox_renew") throw Error("kind");
    expect(await op.wait()).toEqual(result);
    expect(f.windows()).toEqual([61]);
    expect(f.calls.at(-1)?.key).toBe("new-key");
  } finally {
    await next.close();
  }
});

test("E2B lost ACK and 503 stay uncertain across observations without a second POST", async () => {
  for (const mode of ["lost", "503"]) {
    const f = fixture();
    const { client, box } = await create(f);

    if (mode === "lost") f.mode("lost");
    else f.postStatus(503);
    const op = await box.submitRenew({ forSeconds: 61 });

    for (let i = 0; i < 2; i++)
      await expect(op.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(op.observe()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      outcome: {
        kind: "sandbox_renew",
        requested: { forSeconds: 61 },
        observation: { state: "running" },
      },
    });
    const receipt = JSON.parse(JSON.stringify(op.reference));
    await client.close();
    const next = await f.connect({ timeoutSeconds: 600 }, undefined, "new-key");

    try {
      const recovered = await next.recover(receipt);
      await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      await expect(recovered.continue()).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(f.windows()).toEqual([61]);
    } finally {
      await next.close();
    }
  }
});

test("E2B definitive native limits are preserved without retry", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.postStatus(400);

  try {
    await expect(box.renew({ forSeconds: 600 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
    expect(f.windows()).toEqual([600]);
  } finally {
    await client.close();
  }
});

test("E2B stops local waiting after possible dispatch and keeps the reference", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.mode("hold");
  const abort = new AbortController();
  const pending = box.renew(undefined, { signal: abort.signal });
  await f.postEntered;
  abort.abort();
  await expect(pending).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "possible",
    reference: { renewal: { forSeconds: 300 } },
  });
  f.release();
  await Bun.sleep(10);
  expect(f.windows()).toEqual([300]);
  await client.close();
});

test.each(["pause", "auto-resume", "missing", "unknown"])(
  "E2B renewal rejects changed/unknown native policy before POST: %s",
  async (mode) => {
    const f = fixture();
    const { client, box } = await create(f);

    try {
      switch (mode) {
        case "missing":
          f.detail.lifecycle = undefined;
          break;
        case "auto-resume":
          f.detail.lifecycle = { onTimeout: "kill", autoResume: true };
          break;
        case "pause":
          f.detail.lifecycle = { onTimeout: "pause", autoResume: false };
          break;
        default:
          f.detail.lifecycle = { autoResume: false };
          break;
      }

      await expect(box.renew()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(f.windows()).toEqual([]);
      expect((await box.inspect()).state).toBe("running");
    } finally {
      await client.close();
    }
  },
);

test("e2b renewal rejects a mismatched provider/scope before native reads", async () => {
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

test("E2B suspend/resume native defaults and saved-reference workflow retain identity", async () => {
  for (const preserve of [undefined, "filesystem", "filesystem+memory"] as const) {
    const f = fixture();

    const config: Parameters<ReturnType<typeof fixture>["connect"]>[0] = {
      lifecycle: { lifetimeSeconds: 61 },
    };

    if (preserve) config.lifecycle!.suspension = { preserve };
    const { client, box } = await create(f, config);

    try {
      const saved = JSON.parse(JSON.stringify(box.reference));
      const _before = await box.inspect();
      const caps = await box.capabilities();
      expect(caps.lifecycle?.suspend).toMatchObject({
        status: "supported",
        value: { preserve: "filesystem+memory", processes: "preserved", connections: "dropped" },
      });
      const op = await box.submitSuspend();
      const suspended = await op.wait();
      expect(suspended).toMatchObject({
        reference: saved,
        preserve: "filesystem+memory",
        processes: "preserved",
        connections: "dropped",
        observation: { state: "suspended" },
      });
      expect(suspended.observation.expires).toEqual({ status: "none" });
      await expect(box.suspend()).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });

      const fresh = await f.connect(
        { lifecycle: { lifetimeSeconds: 600 } },
        undefined,
        "rotated-key",
      );

      try {
        const reopened = await fresh.sandboxes.get(saved);
        expect((await reopened.inspect()).state).toBe("suspended");
        expect((await reopened.capabilities()).lifecycle?.resume.status).toBe("supported");

        const beforeCalls = f.calls.filter(
          (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
        ).length;

        await expect(reopened.exec(["true"])).rejects.toMatchObject({ code: "UNAVAILABLE" });
        await expect(reopened.readFile("/file")).rejects.toMatchObject({ code: "UNAVAILABLE" });
        expect(
          f.calls.filter(
            (c) =>
              c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
          ),
        ).toHaveLength(beforeCalls);
        const resumed = await reopened.resume();
        expect(resumed).toMatchObject({
          reference: saved,
          execution: "unknown",
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
              c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
          ),
        ).toHaveLength(2);
        expect(
          f.calls
            .filter(
              (c) =>
                c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
            )
            .map((c) => c.body),
        ).toEqual([{ memory: true }, { timeout: 600 }]);
        expect(f.windows()).toEqual([]);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  }
});

test.each(["mounted", "transition", "missing", "policy"])(
  "E2B lifecycle gate %s rejects before POST",
  async (gate) => {
    const f = fixture();
    const { client, box } = await create(f);

    try {
      if (gate === "mounted") f.detail.volumeMounts = [{ name: "vol", path: "/mnt" }];

      if (gate === "transition") f.detail.state = "stopping";

      if (gate === "missing") f.status(404);

      if (gate === "policy") f.detail.lifecycle = { autoResume: true };
      await expect(box.suspend()).rejects.toMatchObject({
        code: {
          missing: "NOT_FOUND",
          mounted: "UNSUPPORTED",
          transition: "UNAVAILABLE",
          policy: "UNAVAILABLE",
        }[gate],
        effect: "none",
      });
      expect(
        f.calls.filter(
          (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
        ),
      ).toHaveLength(0);
    } finally {
      await client.close();
    }
  },
);

test.each(["suspend", "resume"] as const)(
  "E2B %s ACK preserves partial facts and fresh-client recovery never replays",
  async (action) => {
    const f = fixture();
    let saved: AdapterRecoveryReference | undefined;

    const { client, box } = await create(f, { lifecycle: { lifetimeSeconds: 61 } }, (ref) => {
      if (ref.kind === `sandbox_${action}`) saved = JSON.parse(JSON.stringify(ref));
    });

    if (action === "resume") f.detail.state = "paused";
    f.mode("get-failed");

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
        action === "suspend"
          ? { action, preserve: "filesystem+memory" }
          : { action, forSeconds: 61 },
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
              c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
          ),
        ).toHaveLength(1);
        // A confirmed read is historical evidence: later external state change or failed metadata cannot erase it.
        f.detail.state = "stopping";
        f.mode("get-failed");
        const again = await fresh.recover(JSON.parse(JSON.stringify(recovered.reference)));
        expect(await again.wait()).toEqual(await recovered.wait());
        expect(
          f.calls.filter(
            (c) =>
              c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
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
  "E2B suspend unacknowledged %s remains unknown despite matching state",
  async (mode) => {
    const f = fixture();
    const { client, box } = await create(f);

    if (mode === "lost") f.mode(mode);
    else f.postStatus(Number(mode));

    try {
      const op = await box.submitSuspend();
      await expect(op.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { status: "unknown", acknowledged: false, observation: { state: "suspended" } },
      });
      const recovered = await client.recover(JSON.parse(JSON.stringify(op.reference)));
      await expect(recovered.wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        outcome: { acknowledged: false },
      });
      expect(
        f.calls.filter(
          (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test("E2B lifecycle cancellation before dispatch has no effect; after dispatch only stops local wait", async () => {
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
        (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
      ),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }

  const g = fixture();
  const post = new AbortController();
  const setup = await create(g);
  g.mode("hold");

  try {
    const waiting = setup.box.suspend({ signal: post.signal });
    await g.postEntered;
    post.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      effect: "possible",
      reference: { kind: "sandbox_suspend" },
    });
    g.release();
    expect(
      g.calls.filter(
        (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
      ),
    ).toHaveLength(1);
  } finally {
    g.release();
    await setup.client.close();
  }
});

test.each(["suspend", "resume"] as const)(
  "E2B %s cancellation after ACK retains native facts",
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

      if (action === "resume") f.detail.state = "paused";

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
              c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
          ),
        ).toHaveLength(1);
      } finally {
        await client.close();
      }
    }
  },
);

test.each(["suspend", "resume"] as const)(
  "E2B %s checkpoint callback failure does not erase confirmed success",
  async (action) => {
    const f = fixture();

    const { client, box } = await create(f, {}, (ref) => {
      if (ref.kind === `sandbox_${action}` && ref.token) throw Error("storage failed");
    });

    if (action === "resume") f.detail.state = "paused";

    try {
      const result = action === "suspend" ? await box.suspend() : await box.resume();
      expect(result.reference).toEqual(box.reference!);
      expect(
        f.calls.filter(
          (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test.each(["lost", "409", "503"])(
  "E2B resume %s cannot attribute observed running state",
  async (mode) => {
    const f = fixture();
    const { client, box } = await create(f);
    f.detail.state = "paused";

    if (mode === "lost") f.mode(mode);
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
          (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test("E2B inactive mounted resources cannot resume and capabilities agree", async () => {
  const f = fixture();
  const { client, box } = await create(f);
  f.detail.state = "paused";

  try {
    f.detail.volumeMounts = [{ name: "v", path: "/mnt" }];
    await expect(box.resume()).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    expect((await box.capabilities()).lifecycle?.resume.status).toBe("unsupported");
    f.status(404);
    await expect(box.resume()).rejects.toMatchObject({ code: "NOT_FOUND", effect: "none" });
    expect(
      f.calls.filter(
        (c) => c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
      ),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test.each(["missing", "empty"] as const)(
  "E2B %s mount metadata allows private-state suspension and fresh-client resume",
  async (mounts) => {
    const f = fixture();
    const { client, box } = await create(f);
    const saved = JSON.parse(JSON.stringify(box.reference));
    f.detail.volumeMounts = mounts === "empty" ? [] : undefined;

    try {
      expect((await box.capabilities()).lifecycle?.suspend.status).toBe("supported");
      expect(await box.suspend()).toMatchObject({
        preserve: "filesystem+memory",
        observation: { state: "suspended" },
      });
      // Native paused detail omits mount metadata even when running detail supplied it.
      f.detail.volumeMounts = undefined;
      await client.close();
      const fresh = await f.connect({ lifecycle: { lifetimeSeconds: 600 } });

      try {
        const reopened = await fresh.sandboxes.get(saved);
        expect((await reopened.capabilities()).lifecycle?.resume.status).toBe("supported");
        expect(await reopened.resume()).toMatchObject({
          reference: saved,
          execution: "unknown",
          observation: { state: "running" },
        });
        expect(f.detail.volumeMounts).toBeUndefined();
        expect(
          f.calls
            .filter(
              (c) =>
                c.method === "POST" && (c.path.endsWith("/pause") || c.path.endsWith("/connect")),
            )
            .map((c) => c.body),
        ).toEqual([{ memory: true }, { timeout: 600 }]);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  },
);
