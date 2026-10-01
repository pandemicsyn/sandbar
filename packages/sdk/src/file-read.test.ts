import { expect, spyOn, test } from "bun:test";
import { AdapterError, defineAdapter, type ReadContext } from "sandbar-adapter";
import { z } from "zod";
import { Image, Sandbar, type ReadOptions, type SandboxHandle } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

async function fixture(
  read: (ctx: ReadContext) => Promise<Uint8Array | ReadableStream<Uint8Array>>,
) {
  let calls = 0;
  const entered = deferred<ReadContext>();

  const adapter = defineAdapter({
    name: "example.read-cancellation",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        files: {
          maxBytes: 1024,
          async read(_input, ctx) {
            calls++;
            entered.resolve(ctx);

            return read(ctx);
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  const box: SandboxHandle = await client.sandboxes.create({
    environment: Image.prepared("image"),
  });

  return { client, box, entered: entered.promise, calls: () => calls };
}

test("pre-aborted read makes no adapter call; settled read ignores later abort and removes listeners", async () => {
  const f = await fixture(async () => Uint8Array.of(0, 255, 128));
  const controller = new AbortController();
  const options: ReadOptions = { signal: controller.signal };
  const remove = spyOn(controller.signal, "removeEventListener");
  const bytes = await f.box.readFile("/file", options);
  expect(bytes).toEqual(Uint8Array.of(0, 255, 128));
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  controller.abort();
  expect(bytes).toEqual(Uint8Array.of(0, 255, 128));
  await expect(f.box.readFile("/file", options)).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "none",
  });
  expect(f.calls()).toBe(1);
  remove.mockRestore();
  await f.client.close();
});

for (const stop of ["abort", "close", "deadline"] as const) {
  for (const kind of ["provider", "stream"] as const) {
    test(`${stop} promptly stops never-resolving ${kind} and releases owned resources`, async () => {
      const native = deferred<Uint8Array | ReadableStream<Uint8Array>>();
      const pulling = deferred<void>();
      let cancelled = 0;

      const stream = new ReadableStream<Uint8Array>({
        pull() {
          pulling.resolve();

          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled++;

          return new Promise<void>(() => {});
        },
      });

      const f = await fixture(() =>
        kind === "provider" ? native.promise : Promise.resolve(stream),
      );

      const controller = new AbortController();
      let expire!: () => void;

      const timer = spyOn(globalThis, "setTimeout").mockImplementation(
        (handler, delay, ...args) => {
          if (delay === 30_000) expire = () => handler(...args);

          const scheduled = setInterval(() => {
            clearInterval(scheduled);
            handler(...args);
          }, delay);

          return scheduled;
        },
      );

      const pending = f.box.readFile("/file", { signal: controller.signal });
      const outcome = pending.catch((error: Error) => error);

      try {
        const ctx = await f.entered;
        expect(ctx.deadline - Date.now()).toBeGreaterThan(29_000);

        if (kind === "stream") await pulling.promise;

        if (stop === "abort") controller.abort();
        else if (stop === "close") await f.client.close();
        else expire();
        expect(await outcome).toMatchObject({
          code: { abort: "WAIT_ABORTED", close: "CLIENT_CLOSED", deadline: "TIMEOUT" }[stop],
          effect: "none",
        });
        expect(ctx.signal.aborted).toBe(true);

        if (kind === "provider") {
          native.resolve(stream); // late stream must be disposed, even when cancel stalls
          await native.promise;
          await Promise.resolve();
        }

        expect(cancelled).toBe(1);
        expect(stream.locked).toBe(false);
      } finally {
        timer.mockRestore();
        await f.client.close();
      }
    });
  }
}

test("late provider rejection is handled after caller abort", async () => {
  const native = deferred<Uint8Array>();
  const f = await fixture(() => native.promise);
  const controller = new AbortController();
  const pending = f.box.readFile("/file", { signal: controller.signal });
  const outcome = pending.catch((error: Error) => error);
  await f.entered;
  controller.abort();
  expect(await outcome).toMatchObject({ code: "WAIT_ABORTED" });
  native.reject(new Error("late failure"));
  await Promise.resolve();
  await f.client.close();
});

test("abort during provider settlement disposes the stream without reading it", async () => {
  const controller = new AbortController();
  let cancelled = 0;

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });

  const f = await fixture(async () => {
    controller.abort();

    return stream;
  });

  await expect(f.box.readFile("/file", { signal: controller.signal })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
  });
  expect(cancelled).toBe(1);
  expect(stream.locked).toBe(false);
  await f.client.close();
});

test("streamed success preserves exact bytes and releases its lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(Uint8Array.of(0, 255));
      c.enqueue(Uint8Array.of(128, 1));
      c.close();
    },
  });

  const f = await fixture(async () => stream);
  expect(await f.box.readFile("/file")).toEqual(Uint8Array.of(0, 255, 128, 1));
  expect(stream.locked).toBe(false);
  await f.client.close();
});

test("provider and reader failures preserve their error without cancellation", async () => {
  const failure = new Error("reader failed");

  for (const native of [
    () => Promise.reject(new AdapterError("NOT_FOUND", "missing")),
    () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.error(failure);
          },
        }),
      ),
  ]) {
    const f = await fixture(native);

    try {
      await f.box.readFile("/file");
      throw Error("read succeeded");
    } catch (error) {
      if (error !== failure) expect(error).toMatchObject({ code: "NOT_FOUND", effect: "none" });
    }

    await f.client.close();
  }
});

test("file read preserves the custom adapter method receiver", async () => {
  const adapter = defineAdapter({
    name: "example.file-receiver",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        files: {
          maxBytes: 7,
          async read() {
            return Uint8Array.of(this.maxBytes);
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("image") });
    expect(await box.readFile("/file")).toEqual(Uint8Array.of(7));
  } finally {
    await client.close();
  }
});
