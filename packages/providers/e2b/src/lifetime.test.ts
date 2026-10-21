import { expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import type { E2BRecord, E2BTransport } from "./transport";

function fixture() {
  const timeouts: number[] = [];

  const record: E2BRecord = {
    id: "sandbox_ttl",
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
      timeouts.push(input.timeoutMs);
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

  const connect = (config: { lifecycle?: { lifetimeSeconds: number }; timeoutSeconds?: number }) =>
    Sandbar.connect({
      adapter: createE2BAdapter(() => transport),
      config,
      credentials: { apiKey: "private-key" },
    });

  return { timeouts, connect };
}

test("E2B applies the portable default, the setup lifetime and a per-create override", async () => {
  for (const [config, timeoutMs] of [
    [{}, 900_000],
    [{ lifecycle: { lifetimeSeconds: 7200 } }, 7_200_000],
    [{ timeoutSeconds: 600 }, 600_000],
  ] as const) {
    const f = fixture();
    const client = await f.connect(config);

    try {
      await client.sandboxes.create();
      expect(f.timeouts).toEqual([timeoutMs]);
    } finally {
      await client.close();
    }
  }

  const f = fixture();
  const client = await f.connect({ lifecycle: { lifetimeSeconds: 7200 } });

  try {
    expect((await client.capabilities()).lifetime).toEqual({ minSeconds: 1, maxSeconds: 86_400 });
    await client.sandboxes.create({ lifecycle: { lifetimeSeconds: 1800 } });
    // E2B's minimum timeout is a minute; inspect reports the real expiry.
    await client.sandboxes.create({ lifecycle: { lifetimeSeconds: 20 } });
    expect(f.timeouts).toEqual([1_800_000, 60_000]);

    const over = await client.sandboxes
      .create({ lifecycle: { lifetimeSeconds: 86_401 } })
      .catch((cause: unknown) => cause);

    expect(over).toBeInstanceOf(Error);
    expect(f.timeouts).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test("E2B rejects the new lifetime key together with the deprecated timeoutSeconds", async () => {
  await expect(
    fixture().connect({ lifecycle: { lifetimeSeconds: 600 }, timeoutSeconds: 600 }),
  ).rejects.toThrow();
});
