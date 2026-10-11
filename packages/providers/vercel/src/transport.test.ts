import { expect, test } from "bun:test";
import { boundedBody } from "./transport";

test("bounded native bodies preserve bytes at the limit", async () => {
  const bytes = Buffer.from([0, 255, 129]);
  expect(await boundedBody(new Response(bytes), bytes.length)).toEqual(bytes);
});

test("oversized bodies reject promptly even when cancellation never settles", async () => {
  let canceled = 0;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
    },
    cancel() {
      canceled++;

      return new Promise<void>(() => {});
    },
  });

  await expect(boundedBody(new Response(stream), 3)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(canceled).toBe(1);
  expect(stream.locked).toBe(false);
}, 1000);

test("aborted nonsettling native reads do not await a nonsettling cancellation", async () => {
  let canceled = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
    cancel() {
      canceled++;

      return new Promise<void>(() => {});
    },
  });

  const controller = new AbortController();
  const reading = boundedBody(new Response(stream), 3, controller.signal);
  controller.abort();
  await expect(reading).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(canceled).toBe(1);
  expect(stream.locked).toBe(false);
}, 1000);

test("already aborted native reads reject and release their reader", async () => {
  const stream = new ReadableStream<Uint8Array>();
  await expect(boundedBody(new Response(stream), 3, AbortSignal.abort())).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  expect(stream.locked).toBe(false);
}, 1000);
