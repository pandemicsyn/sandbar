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
};

const NativePayload = z.object({
  timeout: z.number().int(),
  metadata: z.record(z.string(), z.string()).optional(),
  autoPause: z.boolean().optional(),
  autoResume: z.object({ enabled: z.boolean() }).optional(),
});

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
  };

  let mode = "ok",
    postStatus = 204,
    authStatus = 200,
    failedRead = false;

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

      if (url.pathname === "/sandboxes/sandbox_one/timeout") {
        entered();

        if (mode === "hold") await held;

        if (mode === "lost") throw new TypeError("lost ACK");

        if (mode === "get-failed") failedRead = true;

        return new Response(null, { status: postStatus });
      }

      if (url.pathname === "/sandboxes/sandbox_one") {
        if (failedRead) throw new TypeError("read failed");

        return Response.json(detail);
      }

      throw Error(`Unexpected fixture ${request.method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  const connect = (
    config: {
      timeoutSeconds?: number;
      lifecycle?: { lifetimeSeconds?: number };
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
