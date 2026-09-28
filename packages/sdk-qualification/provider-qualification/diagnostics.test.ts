import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAdapter } from "../../adapter/src/index";
import { Sandbar } from "sandbar-sdk";
import { LedgerStore } from "./ledger";
import { FailureCapture, redactDiagnostic } from "./diagnostics";
import { e2bEnvdVersion } from "./e2b-profile";
import { runPrepared } from "./lifecycle";
import { parseReport } from "./report";

const directories: string[] = [];

const secret = "synthetic-diagnostic-key";

const owned = "owned-fixture-123";

const logs: string[] = [];

let logSpy: ReturnType<typeof spyOn> | undefined;

afterEach(async () => {
  logSpy?.mockRestore();
  logs.splice(0);

  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function ledger() {
  logSpy = spyOn(console, "error").mockImplementation((value) => {
    logs.push(String(value));
  });
  const directory = await mkdtemp(join(tmpdir(), "sandbar-diagnostic-fixture-"));
  directories.push(directory);
  const store = new LedgerStore(directory, crypto.randomUUID());
  await store.initialize(
    "e2b",
    { kind: "borrowed-prepared", class: "prepared" },
    { templateId: "base", timeoutSeconds: 300 },
  );

  return store;
}

async function run(
  phase: "write" | "read" | "compare" | "destroy" | "close",
  metadataFails = false,
) {
  const store = await ledger();
  let writes = 0;
  let reads = 0;
  let bytes = new Uint8Array(0);
  let destroys = 0;

  const adapter = defineAdapter({
    name: "diagnostic-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        if (phase === "close") throw new Error(`Close failed ${secret} ${owned}`);
      });

      return {
        scope: { authority: { kind: "fixture", id: "private-authority" }, partition: {} },
        supports: {
          images: ["prepared"] as const,
          network: ["blocked"] as const,
          fileWrite: { overwrite: true, noClobber: true },
        },
        async create() {
          return { id: owned, state: "running" as const };
        },
        async inspect() {
          return { id: owned, state: "running" as const };
        },
        destroy: {
          async submit(_input, ctx) {
            destroys++;

            return phase === "destroy"
              ? ctx.reject("UNAVAILABLE", `Destroy denied ${secret} ${owned}`)
              : { computeStopped: true, retainedResources: [] };
          },
        },
        files: {
          maxBytes: 1024,
          write: {
            async submit(input, ctx) {
              writes++;

              if (phase === "write" && writes === 2)
                return ctx.reject(
                  "UNAUTHENTICATED",
                  `Permission denied ${secret} sandbox ${owned}`,
                );
              bytes =
                phase === "compare" && writes === 2
                  ? new Uint8Array([...input.bytes, 99])
                  : new Uint8Array(input.bytes);

              return { bytesWritten: input.bytes.length };
            },
          },
          async read() {
            reads++;

            if (phase === "read" && reads === 2)
              throw Object.assign(new Error(`Read denied ${secret} ${owned}`), {
                name: "FilesystemError",
                code: "EACCES",
              });

            return bytes;
          },
        },
      };
    },
  });

  const steps = await runPrepared(
    (onReference, onDiagnostic) =>
      Sandbar.connect({ adapter, config: {}, credentials: {}, onReference, onDiagnostic }),
    store,
    "base",
    {
      network: "blocked",
      cleanupWaitMs: 0,
      redactions: [secret],
      envdVersion: async () => {
        if (metadataFails) throw new Error(`Metadata denied ${secret} ${owned}`);

        return "0.5.8";
      },
      selectedScenarios: new Set(["file-binary", "file-overwrite", "file-no-clobber"]),
    },
  );

  return { store, steps, writes, destroys };
}

for (const phase of ["write", "read", "compare"] as const)
  test(`overwrite ${phase} failure captures its stage before cleanup and blocks dependent write`, async () => {
    const result = await run(phase);
    const failed = result.steps.find((entry) => entry.scenario === "file-overwrite")!;
    expect(failed.status).toBe("failed");
    expect(failed.diagnostic?.stage).toBe(phase);
    expect(failed.diagnostic?.expectedBytes).toEqual([2, 254, 0]);
    expect(failed.diagnostic?.expectedLength).toBe(3);

    if (phase === "compare") {
      expect(failed.diagnostic?.actualBytes).toEqual([2, 254, 0, 99]);
      expect(failed.diagnostic?.actualLength).toBe(4);
      expect(failed.diagnostic?.error.message).toBe("File byte comparison failed");
    } else {
      expect(failed.diagnostic?.error.code).toBe(phase === "write" ? "UNAUTHENTICATED" : "EACCES");
      expect(failed.diagnostic?.error.name).toBe(
        phase === "read" ? "FilesystemError" : "SandbarError",
      );
      expect(failed.diagnostic?.actualBytes).toBeUndefined();
    }

    expect(result.steps.find((entry) => entry.scenario === "file-no-clobber")?.status).toBe(
      "blocked",
    );
    expect(result.writes).toBe(2);
    expect(result.destroys).toBe(1);
    const state = await result.store.read();
    expect(state.cleanup).toBe("confirmed");
    expect(state.envd).toEqual({ status: "available", version: "0.5.8" });
    expect(state.diagnostics?.some((entry) => entry.stage === phase)).toBe(true);
    const serialized = JSON.stringify({ diagnostic: failed.diagnostic, logs });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(owned);
    expect(logs.some((entry) => entry.includes('"persisted":true'))).toBe(true);
  });

for (const phase of ["destroy", "close"] as const)
  test(`${phase} failure retains error diagnostics separately from exercise`, async () => {
    const { store, steps } = await run(phase);
    expect(steps.find((entry) => entry.scenario === phase)?.diagnostic?.stage).toBe(phase);
    expect((await store.read()).diagnostics?.some((entry) => entry.scenario === phase)).toBe(true);
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(owned);
  });

test("authentication failure is captured without a create or required teardown", async () => {
  const store = await ledger();

  const steps = await runPrepared(
    async () => {
      throw Object.assign(new Error(`Authentication rejected Authorization: Bearer ${secret}`), {
        name: "AuthenticationError",
        code: 401,
      });
    },
    store,
    "base",
    { network: "blocked", redactions: [secret] },
  );

  expect(steps[0]?.diagnostic).toMatchObject({
    stage: "connect",
    error: { name: "AuthenticationError", code: "401" },
  });
  expect((await store.read()).cleanup).toBe("not-required");
  expect(logs.join("\n")).not.toContain(secret);
});

test("envd collector reads only the owned sandbox and discards identifiers", async () => {
  const requested: string[] = [];

  const fetcher = async (url: string, options: RequestInit) => {
    requested.push(String(url));
    expect(new Headers(options?.headers).get("X-API-Key")).toBe(secret);

    return Response.json({
      envdVersion: "0.5.8",
      sandboxID: owned,
      templateID: "private-template",
    });
  };

  expect(await e2bEnvdVersion(secret, fetcher)(owned)).toBe("0.5.8");
  expect(requested).toEqual([`https://api.e2b.app/sandboxes/${owned}`]);
  expect(await e2bEnvdVersion(secret, async () => Response.json({}))(owned)).toBeUndefined();
  await expect(
    e2bEnvdVersion(secret, async () => new Response("private body", { status: 403 }))(owned),
  ).rejects.toThrow("HTTP 403");
});

test("redaction keeps useful quoted explanations while excluding custody and native identifiers", () => {
  const message = `Permission denied: "read only filesystem" ${secret} ${owned} token=other-secret sandboxID=unknown-id https://host/sandboxes/other-id Bearer other-token`;
  const output = redactDiagnostic(message, [secret, owned]);
  expect(output).toContain('"read only filesystem"');

  for (const value of [secret, owned, "other-secret", "unknown-id", "other-id", "other-token"])
    expect(output).not.toContain(value);
});

test("bounded byte evidence and error causes survive schema parsing", async () => {
  const store = await ledger();
  const capture = new FailureCapture(store, "file-overwrite", "write", [secret]);
  capture.file(new Uint8Array([1]), true);

  try {
    capture.compareBytes(new Uint8Array(40).fill(2), new Uint8Array([1]));
  } catch {
    /* Capture the synthetic mismatch below. */
  }

  const diagnostic = await capture.failure(
    new Error("Outer failure", {
      cause: Object.assign(new Error(`Inner failure ${secret}`), { code: "EIO" }),
    }),
  );

  expect(diagnostic.actualBytes).toHaveLength(32);
  expect(diagnostic.actualLength).toBe(40);
  expect(diagnostic.bytesTruncated).toBe(true);
  expect(diagnostic.causes?.[0]?.code).toBe("EIO");

  const report = parseReport({
    schemaVersion: 1,
    records: [
      {
        schemaVersion: 1,
        provider: "e2b",
        scenario: "file-overwrite",
        mode: "fixture",
        status: "failed",
        sdkCommit: "a".repeat(40),
        sdkVersion: "0.0.0",
        runtime: "Bun",
        platform: "fixture",
        timestamp: new Date().toISOString(),
        configuration: { imageClass: "prepared", network: "blocked", regionClass: "fixture" },
        diagnostic,
      },
    ],
  });

  expect(report.records[0]?.diagnostic).toEqual(diagnostic);
});

test("unavailable envd metadata does not hide the original failure or prevent cleanup", async () => {
  const { store, steps } = await run("compare", true);
  const state = await store.read();
  expect(state.envd).toMatchObject({ status: "unavailable", error: { name: "Error" } });
  expect(JSON.stringify(state.envd)).not.toContain(secret);
  expect(JSON.stringify(state.envd)).not.toContain(owned);
  expect(steps.find((entry) => entry.scenario === "file-overwrite")?.diagnostic?.stage).toBe(
    "compare",
  );
  expect(state.cleanup).toBe("confirmed");
});

test("failed diagnostic checkpoint retains a sanitized console capture and original error", async () => {
  const store = await ledger();
  const updateSpy = spyOn(store, "update").mockRejectedValue(new Error("Checkpoint unavailable"));

  try {
    const capture = new FailureCapture(store, "file-overwrite", "read", [secret]);
    const diagnostic = await capture.failure(new Error(`Original read failed ${secret}`));
    expect(diagnostic.error.message).toContain("Original read failed");
    expect(logs[0]).toContain('"persisted":false');
    expect(logs[0]).not.toContain(secret);
    expect((await store.read()).diagnostics).toBeUndefined();
  } finally {
    updateSpy.mockRestore();
  }
});

test("command mismatch captures bounded output and exit status", async () => {
  const store = await ledger();
  await store.update((value) => ({ ...value, sandboxId: owned }));
  const capture = new FailureCapture(store, "exec-argv", "exec", [secret]);
  capture.output(
    {
      stdoutText: () => `wrong output ${secret} ${owned}` + "x".repeat(1100),
      stderrText: () => "permission denied",
      exitCode: 7,
      truncated: false,
    },
    "expected",
    "",
  );
  const diagnostic = await capture.failure(new Error("Output mismatch"));
  expect(diagnostic.stage).toBe("compare");
  expect(diagnostic.expectedStdout).toBe("expected");
  expect(diagnostic.actualStdout?.length).toBeLessThanOrEqual(1024);
  expect(diagnostic.actualStderr).toBe("permission denied");
  expect(diagnostic.exitCode).toBe(7);
  expect(diagnostic.outputTruncated).toBe(true);
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(JSON.stringify(diagnostic)).not.toContain(owned);
});
