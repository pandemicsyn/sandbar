import { expect, test } from "bun:test";
import { z } from "zod";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  AdapterError,
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type InventoryInput,
  type SandboxListPage,
  type AdapterSession,
} from "@sandbar-sdk/adapter";
import { Sandbar } from "./index";

const scope = { authority: { kind: "fixture", id: "account" }, partition: { region: "one" } };

const listed = (id: string) =>
  sandboxReference("list.fixture", scope, id, { operation: `op-${id}`, submission: `sub-${id}` });

function fixture(options: {
  page?: (input: InventoryInput) => SandboxListPage | Promise<SandboxListPage>;
  list?: false;
  inventory?: AdapterSession["inventory"];
  tracing?: { tracerProvider: NodeTracerProvider };
}) {
  const requests: InventoryInput[] = [];
  const reopened: string[] = [];

  const adapter = defineAdapter({
    name: "list.fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      const session: AdapterSession = {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          throw new AdapterError("UNSUPPORTED", "fixture");
        },
        destroy: {
          async submit() {
            throw new AdapterError("UNSUPPORTED", "fixture");
          },
        },
        async reopen(reference) {
          reopened.push(reference.nativeId);

          return {
            ...unknownSandboxFacts(),
            reference: listed(reference.nativeId),
            state: "stopped",
            nativeState: "stopped",
            observedAt: new Date(0).toISOString(),
          };
        },
      };

      if (options.inventory) session.inventory = options.inventory;

      if (options.list !== false)
        session.sandboxList = async (input) => {
          requests.push(input);

          return (
            options.page?.(input) ?? {
              coverage: "sandbar-managed",
              items: [
                { id: "a", state: "running", reference: listed("a") },
                { id: "b", state: "suspended", reference: null },
              ],
              nextCursor: "next",
            }
          );
        };

      return session;
    },
  });

  return {
    requests,
    reopened,
    connect: () =>
      Sandbar.connect({ adapter, config: {}, credentials: {}, tracing: options.tracing }),
  };
}

test("sandboxes.list applies the default page size and returns reopenable references", async () => {
  const f = fixture({});
  const client = await f.connect();

  try {
    const page = await client.sandboxes.list();
    expect(f.requests).toEqual([{ limit: 50 }]);
    expect(page).toEqual({
      coverage: "sandbar-managed",
      items: [
        { id: "a", state: "running", reference: listed("a") },
        { id: "b", state: "suspended", reference: null },
      ],
      nextCursor: "next",
    });

    await client.sandboxes.list({ cursor: "next", limit: 7 });
    expect(f.requests[1]).toEqual({ cursor: "next", limit: 7 });

    const box = await client.sandboxes.get(page.items[0]!.reference!);
    expect(box.id).toBe("a");
    expect(f.reopened).toEqual(["a"]);
    expect(f.requests).toHaveLength(2);

    for (const input of [{ limit: 0 }, { limit: 101 }, { cursor: "x".repeat(4097) }])
      await expect(client.sandboxes.list(input)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    expect(f.requests).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test("sandboxes.list rejects adapter pages that misstate identity, scope or bounds", async () => {
  const foreign = sandboxReference(
    "list.fixture",
    { ...scope, partition: { region: "two" } },
    "a",
    { operation: "op", submission: "sub" },
  );

  const pages: SandboxListPage[] = [
    { coverage: "provider-scope", items: [{ id: "b", state: "running", reference: listed("a") }] },
    { coverage: "provider-scope", items: [{ id: "a", state: "running", reference: foreign }] },
    {
      coverage: "provider-scope",
      items: [{ id: "a", state: "running", reference: { ...listed("a"), history: { at: 1 } } }],
    },
    {
      coverage: "provider-scope",
      items: [
        { id: "a", state: "running", reference: null },
        { id: "b", state: "running", reference: null },
      ],
    },
  ];

  let next = 0;

  // The last call omits coverage, which the adapter page contract requires.
  const f = fixture({
    page: () => pages[next++] ?? JSON.parse('{"items":[]}'),
  });

  const client = await f.connect();

  try {
    // The fourth page lists two sandboxes for a one-item request.
    for (let call = 0; call <= pages.length; call++)
      await expect(client.sandboxes.list({ limit: 1 })).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    expect(next).toBe(pages.length + 1);
  } finally {
    await client.close();
  }
});

test("sandboxes.list reports unsupported adapters and maps adapter errors", async () => {
  const unsupported = fixture({ list: false });
  const client = await unsupported.connect();

  try {
    await expect(client.sandboxes.list()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.operations.inventory({ limit: 1 })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect((await client.capabilities()).inventory).toBe(false);
  } finally {
    await client.close();
  }

  const failing = fixture({
    page: () => {
      throw new AdapterError("RATE_LIMIT", "Slow down");
    },
  });

  const second = await failing.connect();

  try {
    await expect(second.sandboxes.list()).rejects.toMatchObject({
      name: "SandbarError",
      code: "RATE_LIMIT",
    });
  } finally {
    await second.close();
  }
});

test("operations.inventory derives from sandboxList and keeps a native inventory hook", async () => {
  const derived = fixture({});
  const client = await derived.connect();

  try {
    expect(await client.operations.inventory({ limit: 3 })).toEqual({
      items: [
        { id: "a", state: "running" },
        { id: "b", state: "unknown" },
      ],
      nextCursor: "next",
    });
    expect(derived.requests).toEqual([{ limit: 3 }]);
    expect((await client.capabilities()).inventory).toBe(true);
  } finally {
    await client.close();
  }

  let native = 0;

  const both = fixture({
    async inventory() {
      native++;

      return { items: [{ id: "native", state: "destroyed" }] };
    },
  });

  const second = await both.connect();

  try {
    expect(await second.operations.inventory({ limit: 1 })).toEqual({
      items: [{ id: "native", state: "destroyed" }],
    });
    expect(native).toBe(1);
    expect(both.requests).toHaveLength(0);
  } finally {
    await second.close();
  }
});

test("sandboxes.list records one sandbar.sandbox.list span", async () => {
  const exporter = new InMemorySpanExporter();

  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const client = await fixture({ tracing: { tracerProvider } }).connect();

  try {
    await client.sandboxes.list({ limit: 2 });
  } finally {
    await client.close();
  }

  const spans = exporter.getFinishedSpans().filter((span) => span.name === "sandbar.sandbox.list");

  expect(spans).toHaveLength(1);
  expect(JSON.stringify(spans[0]!.attributes)).not.toContain("op-a");
});
