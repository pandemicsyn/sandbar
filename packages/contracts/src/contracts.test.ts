import { describe, expect, test } from "bun:test";
import { canonicalJson, CreateSandboxRequest, ExecRequest, Operation, StreamFrame, intentSha256 } from "./index";
import { openApiDocument } from "./openapi";

describe("public contract", () => {
  test("strict inputs reject unknown security-sensitive fields while outputs accept additive fields", () => {
    const valid = { environment: { kind: "prepared" as const, imageId: "fake-starter" }, network: { policy: "blocked" } };
    expect(CreateSandboxRequest.safeParse({ ...valid, netwrok: { policy: "open" } }).success).toBe(false);
    expect(CreateSandboxRequest.parse(valid)).toEqual(valid);
    expect(ExecRequest.safeParse({ command: { kind: "argv", argv: ["echo"] }, shel: true }).success).toBe(false);
    const operation = { id: "op_1", projectId: "p_1", kind: "create", status: "unknown", phase: "submitted", createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:00Z", effect: "possible", recovery: ["check_again"], futureField: "safe" };
    expect(Operation.parse(operation)).not.toHaveProperty("futureField");
    expect(Operation.parse({ ...operation, kind: "file_write", status: "succeeded", effect: "applied", result: { kind: "file_write", receipt: { path: "/blob", bytesWritten: 3, complete: true, effect: "applied" } } }).result).toEqual({ kind: "file_write", receipt: { path: "/blob", bytesWritten: 3, complete: true, effect: "applied" } });
  });
  test("intent canonicalization preserves omission and is key-order independent", async () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(await intentSha256({ a: 1 })).not.toBe(await intentSha256({ a: 1, b: null }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  test("stream frames and initial OpenAPI expose real protocol shapes", () => {
    expect(StreamFrame.safeParse({ kind: "gap", executionId: "e1", fromSequence: 1, toSequence: 3 }).success).toBe(true);
    expect(StreamFrame.safeParse({ kind: "stdout", executionId: "e1", sequence: 1, bytesBase64: "not-base64" }).success).toBe(false);
    expect(openApiDocument.paths["/v1/projects/{projectId}/sandboxes"].post.responses["202"]).toBeDefined();
    expect(openApiDocument.components.schemas.CreateSandboxRequest).toBeDefined();
  });
});
