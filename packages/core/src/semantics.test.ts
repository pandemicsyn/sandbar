import { expect, test } from "bun:test";
import {
  captureBoundedOutput,
  correlateDriverResult,
  normalizeCreate,
  normalizeExec,
  outputLimit,
  resultDisposition,
} from "./semantics";
import type { DriverResult, NativeScope, SandboxRef } from "@sandbar/provider-spi";

const scope: NativeScope = {
  provider: "fake",
  connectionId: "fixture",
  accountId: "account",
  region: "local",
};

const sandbox: SandboxRef = { scope, nativeId: "native_1", kind: "sandbox" };

const observedAt = new Date().toISOString();

test("normalization validates public inputs and fixes provider defaults", () => {
  expect(normalizeCreate({ environment: { kind: "prepared", imageId: "image" } })).toEqual({
    image: { kind: "prepared", value: "image" },
    networkPolicy: "blocked",
    region: undefined,
    labels: undefined,
  });
  expect(normalizeExec({ command: { kind: "argv", argv: ["echo"] } }).maxOutputBytes).toBe(
    1_048_576,
  );
  expect(outputLimit({ capture: "none" })).toBe(0);
  expect(() => normalizeExec({ command: { kind: "argv", argv: [] } })).toThrow();

  const invalidCreate = {
    environment: { kind: "prepared" as const, imageId: "image" },
    misspelledPolicy: "open",
  };

  expect(() => normalizeCreate(invalidCreate)).toThrow();
});

test("correlation rejects mismatched submission and resource scope", () => {
  const completed: DriverResult = {
    status: "completed",
    effect: "applied",
    submissionId: "submission",
    value: {
      kind: "execution",
      observation: {
        ref: { scope, nativeId: "exec_1", kind: "execution" },
        sandbox,
        completed: true,
        exitCode: 9,
        observedAt,
      },
    },
  };

  expect(
    correlateDriverResult(completed, { submissionId: "submission", kind: "exec", scope, sandbox }),
  ).toEqual(completed);
  expect(() =>
    correlateDriverResult(completed, { submissionId: "other", kind: "exec", scope, sandbox }),
  ).toThrow("submission mismatch");
  expect(() =>
    correlateDriverResult(completed, {
      submissionId: "submission",
      kind: "exec",
      scope,
      sandbox: { ...sandbox, nativeId: "other" },
    }),
  ).toThrow("identity mismatch");
  expect(() =>
    correlateDriverResult(completed, {
      submissionId: "submission",
      kind: "exec",
      scope: { ...scope, accountId: "other" },
      sandbox,
    }),
  ).toThrow("identity mismatch");
});

test("an observed rejection after an ambiguous submission cannot authorize replay", () => {
  const unknown = correlateDriverResult(
    { status: "unknown", effect: "possible", submissionId: "submission", reason: "response lost" },
    { submissionId: "submission", kind: "create", scope },
  );

  expect(resultDisposition(unknown, "submission")).toBe("observe_only");

  const rejected = correlateDriverResult(
    {
      status: "rejected",
      effect: "none",
      error: { code: "capacity", message: "full", effect: "none", retry: "never" },
    },
    { submissionId: "submission", kind: "create", scope, requireSubmissionId: true },
  );

  expect(resultDisposition(rejected, "observation")).toBe("observe_only");
  expect(resultDisposition(rejected, "submission")).toBe("definitive_rejection");
});

test("output bounds preserve binary bytes", () => {
  const bytes = Buffer.from([0, 255, 65]);

  const captured = captureBoundedOutput(
    bytes.toString("base64"),
    Buffer.from([66]).toString("base64"),
    2,
  );

  expect(Buffer.from(captured.payload.stdoutBase64, "base64")).toEqual(bytes.subarray(0, 2));
  expect(captured.payload.stderrBase64).toBe("");
  expect(captured.bytes).toBe(2);
  expect(captured.truncated).toBe(true);
});
