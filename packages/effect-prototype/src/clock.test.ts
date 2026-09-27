import { expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";
import { pollReadOnly } from "./index";

test("read-only polling obeys TestClock and stops after success", async () => {
  let reads = 0;

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      pollReadOnly(() => Effect.sync(() => (++reads === 3 ? "observed" : null)), 100),
    );

    yield* TestClock.adjust(100);
    yield* TestClock.adjust(100);
    expect(yield* Fiber.join(fiber)).toBe("observed");
  }).pipe(Effect.provide(TestContext.TestContext));

  await Effect.runPromise(program);
  expect(reads).toBe(3);
});
