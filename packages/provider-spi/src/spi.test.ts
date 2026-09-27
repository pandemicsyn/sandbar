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

test("provider observations enforce reference roles and execution scope", () => {
  const scope = { provider: "fake", connectionId: "c1", accountId: "local" };
  const sandbox = { scope, nativeId: "fake_sandbox_1", kind: "sandbox" };
  const execution = { scope, nativeId: "fake_execution_2", kind: "execution" };

  const completedSandbox = {
    status: "completed",
    effect: "applied",
    value: {
      kind: "sandbox",
      observation: { ref: sandbox, state: "running", observedAt: "2026-09-26T10:00:00Z" },
    },
  };

  const completedExecution = {
    status: "completed",
    effect: "applied",
    value: {
      kind: "execution",
      observation: {
        ref: execution,
        sandbox,
        completed: true,
        observedAt: "2026-09-26T10:00:00Z",
      },
    },
  };

  expect(
    DriverResult.safeParse({
      ...completedSandbox,
      value: {
        ...completedSandbox.value,
        observation: {
          ...completedSandbox.value.observation,
          ref: { ...sandbox, kind: "execution" },
        },
      },
    }).success,
  ).toBe(false);
  expect(DriverResult.safeParse(completedExecution).success).toBe(true);
  expect(
    DriverResult.safeParse({
      ...completedExecution,
      value: {
        ...completedExecution.value,
        observation: { ...completedExecution.value.observation, ref: sandbox },
      },
    }).success,
  ).toBe(false);
  expect(
    DriverResult.safeParse({
      ...completedExecution,
      value: {
        ...completedExecution.value,
        observation: {
          ...completedExecution.value.observation,
          sandbox: { ...sandbox, scope: { ...scope, accountId: "other" } },
        },
      },
    }).success,
  ).toBe(false);
  expect(
    DriverResult.safeParse({
      status: "completed",
      effect: "applied",
      value: {
        kind: "destroy",
        observation: { sandbox: execution, computeStopped: true, retainedResources: [] },
      },
    }).success,
  ).toBe(false);
  expect(
    DriverResult.safeParse({
      status: "completed",
      effect: "applied",
      value: {
        kind: "file_write",
        observation: { sandbox: execution, path: "/x", bytesWritten: 1, complete: true },
      },
    }).success,
  ).toBe(false);
});
