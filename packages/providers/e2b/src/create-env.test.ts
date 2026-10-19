import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import type { E2BRecord, E2BTransport } from "./transport";

const SECRET = "CANARY-e2b-env-secret";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

test("E2B passes create env to the native create once and persists no value", async () => {
  const creates: Parameters<E2BTransport["create"]>[0][] = [];

  const record: E2BRecord = {
    id: "sandbox_env",
    templateId: "base",
    metadata: {},
    state: "running",
  };

  const transport: E2BTransport = {
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async buildImage() {
      throw new Error("No build expected");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      creates.push(input);
      record.metadata = input.metadata;
      record.allowPublicTraffic = input.allowPublicTraffic;

      return record.id;
    },
    async get(id) {
      return id === record.id ? record : null;
    },
    async list() {
      return { items: [record] };
    },
    async kill() {
      return true;
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  };

  const saved: AdapterRecoveryReference[] = [];

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(() => transport),
    config: {},
    credentials: { apiKey: "private-key" },
    onReference(reference) {
      saved.push(structuredClone(reference));
    },
  });

  try {
    expect((await client.capabilities()).createEnv).toBe(true);
    const operation = await client.sandboxes.submitCreate({ env: { API_TOKEN: SECRET } });
    const box = await operation.wait();
    expect(box.id).toBe("sandbox_env");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.env).toEqual({ API_TOKEN: SECRET });
    expect(saved.some((reference) => reference.token !== undefined)).toBe(true);
    expect(JSON.stringify([operation.reference, box.reference, saved])).not.toContain(SECRET);

    await client.sandboxes.create();
    expect(creates[1]).not.toHaveProperty("env");
  } finally {
    await client.close();
  }
});

test("E2B native create carries envVars and redacts an echoed value from rejections", async () => {
  const bodies: { envVars?: Record<string, string> }[] = [];

  // SAFETY: This deterministic fetch boundary matches Bun's fetch/preconnect shape and receives only fixture credentials.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.pathname === "/v2/templates") return Response.json([]);

      if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
        const body = z
          .object({ envVars: z.record(z.string(), z.string()).optional() })
          .parse(await request.json());

        bodies.push(body);

        return Response.json(
          { code: 400, message: `invalid envVars ${JSON.stringify(body.envVars)}` },
          { status: 400 },
        );
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const client = await Sandbar.connect({
    adapter: createE2BAdapter(),
    config: {},
    credentials: { apiKey: "fixture-key" },
  });

  try {
    const error = await client.sandboxes.create({ env: { API_TOKEN: SECRET } }).then(
      () => undefined,
      (cause: Error) => cause,
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.envVars).toEqual({ API_TOKEN: SECRET });
    expect(String(error?.message)).not.toContain(SECRET);
    expect(String(error?.message)).toContain("[redacted]");
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await client.close();
  }
});
