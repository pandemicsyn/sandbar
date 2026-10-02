import { expect, test } from "bun:test";
import { z } from "zod";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { defineAdapter, type Preview } from "sandbar-adapter";
import { Image, Sandbar } from "./index";

async function fixture(
  preview?: (port: number, signal: AbortSignal) => Promise<Preview>,
  provider?: NodeTracerProvider,
) {
  const adapter = defineAdapter({
    name: "preview.fixture",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "test", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        preview: preview ? async (input, ctx) => preview(input.port, ctx.signal) : undefined,
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    tracing: provider ? { tracerProvider: provider } : false,
  });

  return { client, box: await client.sandboxes.create({ environment: Image.prepared("base") }) };
}

test("preview validates every port boundary before adapter dispatch and accepts closed-port access", async () => {
  const ports: number[] = [];

  const { client, box } = await fixture(async (port) => {
    ports.push(port);

    return { access: "public", url: `https://${port}-one.example.test` };
  });

  try {
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity])
      await expect(box.preview(port)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ports).toEqual([]);

    for (const port of [1, 65535]) expect((await box.preview(port)).access).toBe("public");
    expect(ports).toEqual([1, 65535]);
  } finally {
    await client.close();
  }
});

test("unsupported preview has no effects and malformed credential URL is rejected without exposing it", async () => {
  const unsupported = await fixture();
  await expect(unsupported.box.preview(3000)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await unsupported.client.close();

  const malformed = await fixture(async () => ({
    access: "public",
    url: "https://one.example.test?token=private",
  }));

  await expect(malformed.box.preview(3000)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    message: "Invalid preview access response",
  });
  await malformed.client.close();
});

test("caller abort and client close promptly release local waiting without replay", async () => {
  let calls = 0;

  const f = await fixture(async (_port, signal) => {
    calls++;

    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  });

  const controller = new AbortController();
  const pending = f.box.preview(3000, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  const closeWait = f.box.preview(3000);
  void closeWait.catch(() => undefined);
  await f.client.close();
  await expect(closeWait).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
  expect(calls).toBe(2);
});

test("preview spans exclude returned URL and header credentials, and scrub unknown transport errors", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

  const f = await fixture(
    async () => ({
      access: "protected",
      url: "https://sensitive-host.example.test",
      headers: { "x-token": "sensitive-token" },
    }),
    provider,
  );

  try {
    expect((await f.box.preview(3000)).access).toBe("protected");

    const spans = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );

    expect(spans).not.toContain("sensitive-host");
    expect(spans).not.toContain("sensitive-token");
  } finally {
    await f.client.close();
    await provider.shutdown();
  }

  const failed = await fixture(async () => {
    throw Error("sensitive-token at https://private-host.test");
  });

  try {
    await expect(failed.box.preview(3000)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Preview access is unavailable",
    });
  } finally {
    await failed.client.close();
  }
});
