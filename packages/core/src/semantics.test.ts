import { expect, test } from "bun:test";
import { captureBoundedOutput, correlateDriverResult, normalizeCreate, normalizeExec, outputLimit, resultDisposition } from "./semantics";
import type { NativeRef, NativeScope } from "@sandbar/provider-spi";

const scope: NativeScope = { provider: "fake", connectionId: "fixture", accountId: "account", region: "local" };
const sandbox: NativeRef = { scope, nativeId: "native_1", kind: "sandbox" };
const observedAt = new Date().toISOString();

test("normalization validates public inputs and fixes provider defaults", () => {
  expect(normalizeCreate({ environment: { kind: "prepared", imageId: "image" } })).toEqual({ image: { kind: "prepared", value: "image" }, networkPolicy: "blocked", region: undefined, labels: undefined });
  expect(normalizeExec({ command: { kind: "argv", argv: ["echo"] } }).maxOutputBytes).toBe(1_048_576);
  expect(outputLimit({ capture: "none" })).toBe(0);
  expect(() => normalizeExec({ command: { kind: "argv", argv: [] } })).toThrow();
  expect(() => normalizeCreate({ environment: { kind: "prepared", imageId: "image" }, misspelledPolicy: "open" })).toThrow();
});

test("correlation rejects mismatched submission and resource scope", () => {
  const completed = { status: "completed", effect: "applied", submissionId: "submission", value: { kind: "execution", observation: { ref: { scope, nativeId: "exec_1", kind: "execution" }, sandbox, completed: true, exitCode: 9, observedAt } } } as const;
  expect(correlateDriverResult(completed, { submissionId: "submission", kind: "exec", scope, sandbox })).toEqual(completed);
  expect(() => correlateDriverResult(completed, { submissionId: "other", kind: "exec", scope, sandbox })).toThrow("submission mismatch");
  expect(() => correlateDriverResult(completed, { submissionId: "submission", kind: "exec", scope, sandbox: { ...sandbox, nativeId: "other" } })).toThrow("identity mismatch");
  expect(() => correlateDriverResult(completed, { submissionId: "submission", kind: "exec", scope: { ...scope, accountId: "other" }, sandbox })).toThrow("identity mismatch");
});

test("ambiguous effects remain observe only and output bounds preserve binary bytes", () => {
  const unknown = correlateDriverResult({ status: "unknown", effect: "possible", submissionId: "submission", reason: "response lost" }, { submissionId: "submission", kind: "create", scope });
  expect(resultDisposition(unknown)).toBe("observe_only");
  const bytes = Buffer.from([0, 255, 65]);
  const captured = captureBoundedOutput(bytes.toString("base64"), Buffer.from([66]).toString("base64"), 2);
  expect(Buffer.from(captured.payload.stdoutBase64, "base64")).toEqual(bytes.subarray(0, 2));
  expect(captured.payload.stderrBase64).toBe("");
  expect(captured.bytes).toBe(2);
  expect(captured.truncated).toBe(true);
});
