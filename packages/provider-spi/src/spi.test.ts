import { expect, test } from "bun:test";
import { DriverResult } from "./index";

test("normalized mutation outcomes cannot contradict their effect classification", () => {
  const scope = { provider: "fake", connectionId: "c1", accountId: "local" };
  const ref = { scope, nativeId: "native_1", kind: "sandbox" };
  const completed = {
    status: "completed",
    effect: "applied",
    value: {
      kind: "sandbox",
      observation: { ref, state: "running", observedAt: "2026-09-26T10:00:00Z" },
    },
  };
  expect(DriverResult.safeParse(completed).success).toBe(true);
  expect(DriverResult.safeParse({ ...completed, effect: "none" }).success).toBe(false);
  const rejected = {
    status: "rejected",
    effect: "none",
    error: { code: "capacity", message: "No capacity", effect: "none", retry: "never" },
  };
  expect(DriverResult.safeParse(rejected).success).toBe(true);
  expect(
    DriverResult.safeParse({ ...rejected, error: { ...rejected.error, effect: "applied" } })
      .success,
  ).toBe(false);
});
