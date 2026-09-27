import { describe, expect, test } from "bun:test";
import {
  AcceptedExecution,
  canonicalJson,
  CreateSandboxRequest,
  Execution,
  ExecRequest,
  Operation,
  Sandbox,
  StreamFrame,
  intentSha256,
} from "./index";
import { openApiDocument } from "./openapi";

describe("public contract", () => {
  test("strict inputs reject unknown security-sensitive fields while outputs accept additive fields", () => {
    const valid = {
      environment: { kind: "prepared" as const, imageId: "fake-starter" },
      network: { policy: "blocked" },
    };

    expect(CreateSandboxRequest.safeParse({ ...valid, netwrok: { policy: "open" } }).success).toBe(
      false,
    );
    expect(CreateSandboxRequest.parse(valid)).toEqual(valid);
    expect(
      ExecRequest.safeParse({ command: { kind: "argv", argv: ["echo"] }, shel: true }).success,
    ).toBe(false);

    const operation = {
      id: "op_1",
      projectId: "p_1",
      kind: "create",
      status: "unknown",
      phase: "submitted",
      createdAt: "2026-09-26T10:00:00Z",
      updatedAt: "2026-09-26T10:00:00Z",
      effect: "possible",
      recovery: ["check_again"],
      futureField: "safe",
    };

    expect(Operation.parse(operation)).not.toHaveProperty("futureField");
    expect(
      Operation.safeParse({
        ...operation,
        result: { kind: "destroy", computeStopped: true, retainedResources: [] },
      }).success,
    ).toBe(false);
    expect(
      Operation.parse({
        ...operation,
        kind: "file_write",
        status: "succeeded",
        effect: "applied",
        result: {
          kind: "file_write",
          receipt: { path: "/blob", bytesWritten: 3, complete: true, effect: "applied" },
        },
      }).result,
    ).toEqual({
      kind: "file_write",
      receipt: { path: "/blob", bytesWritten: 3, complete: true, effect: "applied" },
    });

    const sandbox = {
      id: "sb_1",
      projectId: "p_1",
      connectionId: "conn_1",
      desiredState: "running",
      observedState: "running",
      revision: 1,
      environment: { kind: "prepared", imageId: "fake-starter", futureField: true },
      network: { policy: "blocked", futureField: true },
      labels: {},
    };

    expect(Sandbox.parse(sandbox).environment).toEqual({
      kind: "prepared",
      imageId: "fake-starter",
    });
    expect(Sandbox.parse(sandbox).network).toEqual({ policy: "blocked" });

    const execution = {
      id: "exec_1",
      projectId: "p_1",
      sandboxId: "sb_1",
      operationId: "op_1",
      status: "completed",
      outputAvailability: "captured",
      capturedBytes: 2,
      stdoutBase64: "/wA=",
    };

    expect(Execution.parse(execution).stdoutBase64).toBe("/wA=");
    expect(Execution.safeParse({ ...execution, stdoutBase64: "not-base64" }).success).toBe(false);
    expect(Execution.safeParse({ ...execution, capturedBytes: 0 }).success).toBe(false);
    expect(Execution.safeParse({ ...execution, outputAvailability: "not_captured" }).success).toBe(
      false,
    );
    expect(
      Execution.safeParse({
        ...execution,
        stdoutBase64: "A".repeat(1_398_104),
        stderrBase64: "AA==",
        capturedBytes: 1_048_576,
      }).success,
    ).toBe(false);
    expect(
      Execution.safeParse({
        ...execution,
        outputAvailability: "expired",
        stdoutBase64: undefined,
      }).success,
    ).toBe(true);
    expect(AcceptedExecution.safeParse({ operation, execution }).success).toBe(false);

    const execOperation = {
      ...operation,
      kind: "exec",
      sandboxId: "sb_1",
      executionId: "exec_1",
    };

    expect(AcceptedExecution.safeParse({ operation: execOperation, execution }).success).toBe(true);
    expect(
      AcceptedExecution.safeParse({
        operation: { ...execOperation, id: "other_op" },
        execution,
      }).success,
    ).toBe(false);
    expect(
      AcceptedExecution.safeParse({
        operation: { ...execOperation, executionId: "other_exec" },
        execution,
      }).success,
    ).toBe(false);
    expect(
      AcceptedExecution.safeParse({
        operation: { ...execOperation, projectId: "other_project" },
        execution,
      }).success,
    ).toBe(false);
    expect(
      AcceptedExecution.safeParse({
        operation: { ...execOperation, sandboxId: "other_sandbox" },
        execution,
      }).success,
    ).toBe(false);
  });
  test("intent canonicalization preserves omission and is key-order independent", async () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(canonicalJson({ "\uE000": 1, "😀": 2, tiny: 1e-7, minusZero: -0 })).toBe(
      '{"minusZero":0,"tiny":1e-7,"😀":2,"":1}',
    );
    expect(await intentSha256({ a: 1 })).not.toBe(await intentSha256({ a: 1, b: null }));
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  test("stream frames and initial OpenAPI expose real protocol shapes", () => {
    expect(
      StreamFrame.safeParse({ kind: "gap", executionId: "e1", fromSequence: 1, toSequence: 3 })
        .success,
    ).toBe(true);
    expect(
      StreamFrame.safeParse({ kind: "gap", executionId: "e1", fromSequence: 3, toSequence: 1 })
        .success,
    ).toBe(false);
    expect(
      StreamFrame.safeParse({
        kind: "stdout",
        executionId: "e1",
        sequence: 1,
        bytesBase64: "not-base64",
      }).success,
    ).toBe(false);
    expect(
      openApiDocument.paths["/v1/projects/{projectId}/sandboxes"].post.responses["202"],
    ).toBeDefined();
    expect(openApiDocument.components.schemas.CreateSandboxRequest).toBeDefined();
    expect(openApiDocument.components.schemas.StreamFrame).toBeDefined();
    expect(openApiDocument.components.schemas.InvocationKey).toHaveProperty("pattern");
    expect(openApiDocument.components.schemas.Id).toHaveProperty("pattern");
    expect(
      openApiDocument.paths["/v1/projects/{projectId}/sandboxes"].parameters[0].schema,
    ).toEqual({ $ref: "#/components/schemas/Id" });
    expect(openApiDocument.components.schemas.SandboxListQuery).toBeDefined();
    expect(
      openApiDocument.paths["/v1/projects/{projectId}/sandboxes"].get.parameters.map((p) => p.name),
    ).toEqual(["cursor", "limit", "connectionId", "state", "q"]);
  });
  test("every accepted operation response documents its polling Location header", () => {
    const paths = openApiDocument.paths;

    const accepted = [
      paths["/v1/projects/{projectId}/sandboxes"].post.responses["202"],
      paths["/v1/projects/{projectId}/sandboxes/{sandboxId}"].delete.responses["202"],
      paths["/v1/projects/{projectId}/sandboxes/{sandboxId}/executions"].post.responses["202"],
      paths["/v1/projects/{projectId}/sandboxes/{sandboxId}/files"].put.responses["202"],
    ];

    for (const response of accepted) {
      expect(response.headers.Location.required).toBe(true);
      expect(response.headers.Location.schema).toEqual({ type: "string", format: "uri-reference" });
    }
  });
  test("OpenAPI preserves additive output fields and strict request inputs", () => {
    expect(openApiDocument.components.schemas.Operation).not.toHaveProperty("additionalProperties");
    expect(openApiDocument.components.schemas.Sandbox).not.toHaveProperty("additionalProperties");
    expect(openApiDocument.components.schemas.CreateSandboxRequest).toHaveProperty(
      "additionalProperties",
      false,
    );
    expect(openApiDocument.components.schemas.Sandbox).not.toHaveProperty(
      "properties.environment.oneOf.0.additionalProperties",
    );
    expect(openApiDocument.components.schemas.Sandbox).not.toHaveProperty(
      "properties.environment.oneOf.1.additionalProperties",
    );
    expect(openApiDocument.components.schemas.Sandbox).not.toHaveProperty(
      "properties.network.additionalProperties",
    );
    expect(openApiDocument.components.schemas.Execution).toHaveProperty(
      "properties.stdoutBase64.contentEncoding",
      "base64",
    );
    expect(openApiDocument.components.schemas.Execution).toHaveProperty(
      "properties.stdoutBase64.maxLength",
      1_398_104,
    );
    expect(openApiDocument.components.schemas.Execution).toHaveProperty(
      "properties.capturedBytes.maximum",
      1_048_576,
    );
    expect(openApiDocument.components.schemas.Operation).toMatchObject({
      oneOf: [
        {
          properties: {
            kind: { const: "create" },
            result: { properties: { kind: { const: "create" } } },
          },
        },
        {
          properties: {
            kind: { const: "exec" },
            result: { properties: { kind: { const: "exec" } } },
          },
        },
        {
          properties: {
            kind: { const: "destroy" },
            result: { properties: { kind: { const: "destroy" } } },
          },
        },
        {
          properties: {
            kind: { const: "file_write" },
            result: { properties: { kind: { const: "file_write" } } },
          },
        },
      ],
    });
    expect(openApiDocument.components.schemas.AcceptedExecution).toMatchObject({
      properties: { operation: { properties: { kind: { const: "exec" } } } },
    });
    expect(openApiDocument.components.schemas.AcceptedExecution).toHaveProperty(
      "description",
      expect.stringContaining("operation.executionId equals execution.id"),
    );
  });
  test("OpenAPI retains constrained label keys", () => {
    expect(openApiDocument.components.schemas.CreateSandboxRequest).toMatchObject({
      properties: {
        labels: { propertyNames: { type: "string", minLength: 1, maxLength: 64 } },
      },
    });
  });
});
