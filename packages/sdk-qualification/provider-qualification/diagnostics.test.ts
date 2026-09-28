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
import { reconcileConnection, runPrepared } from "./lifecycle";
import { parseReport, publicIssue } from "./report";

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
  phase: "write" | "read" | "compare" | "destroy" | "close" | "no-clobber",
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

for (const reconcileOnly of [false, true])
  test(`failed authentication retains separate release failure (${reconcileOnly ? "reconcile" : "exercise"})`, async () => {
    const store = await ledger();

    const adapter = defineAdapter({
      name: "failed-connect-release-fixture",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect({ host }) {
        host.onClose(() => {
          throw new Error(`Release denied ${secret}`);
        });
        throw new Error(`Authentication denied ${secret}`);
      },
    });

    const factory: import("./lifecycle").ConnectionFactory = (onReference, onDiagnostic) =>
      Sandbar.connect({ adapter, config: {}, credentials: {}, onReference, onDiagnostic });

    const steps = reconcileOnly
      ? await reconcileConnection(factory, store, 1000, [secret])
      : await runPrepared(factory, store, "base", { network: "blocked", redactions: [secret] });

    expect(steps.find((entry) => entry.scenario === "connect")).toMatchObject({
      status: "failed",
      diagnostic: { stage: "connect", error: { message: "Authentication denied [REDACTED]" } },
    });
    expect(steps.find((entry) => entry.scenario === "close")).toMatchObject({
      status: "failed",
      diagnostic: { stage: "close", error: { message: "Release denied [REDACTED]" } },
    });
    expect((await store.read()).diagnostics?.map((entry) => entry.scenario).sort()).toEqual([
      "close",
      "connect",
    ]);
  });

test("sanitized evidence preserves uncertain mutation classification", async () => {
  const store = await ledger();

  const diagnostic = await new FailureCapture(store, "file-overwrite", "write").failure(
    Object.assign(new Error("Observe submitted mutation without replay"), {
      code: "OUTCOME_UNKNOWN",
    }),
  );

  const report = parseReport({
    schemaVersion: 1,
    records: [
      {
        schemaVersion: 1,
        provider: "e2b",
        scenario: "file-overwrite",
        mode: "fixture",
        status: "failed",
        issue: publicIssue(diagnostic.error.code),
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

  expect(report.records[0]?.issue).toBe("outcome-unknown");
  expect(report.records[0]?.diagnostic?.error.code).toBe("OUTCOME_UNKNOWN");
});

test("an accepted no-clobber write captures destination bytes before reporting the missing conflict", async () => {
  const { store, steps, writes, destroys } = await run("no-clobber");
  expect(steps.find((entry) => entry.scenario === "file-overwrite")?.status).toBe("passed");
  expect(steps.find((entry) => entry.scenario === "file-no-clobber")).toMatchObject({
    status: "failed",
    diagnostic: {
      stage: "compare",
      overwrite: false,
      writeBytes: [0, 255, 1, 128],
      expectedBytes: [2, 254, 0],
      expectedLength: 3,
      actualBytes: [0, 255, 1, 128],
      actualLength: 4,
      error: { message: "No-clobber unexpectedly passed" },
    },
  });
  expect(writes).toBe(3);
  expect(destroys).toBe(1);
  expect((await store.read()).cleanup).toBe("confirmed");
});

test("sandbox-info refuses a redirect without forwarding the API key to another origin", async () => {
  let forwarded = 0;
  let authenticated = 0;

  const destination = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      forwarded++;

      return Response.json({ envdVersion: "0.5.8" });
    },
  });

  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("X-API-Key") === secret) authenticated++;

      return Response.redirect(destination.url, 302);
    },
  });

  try {
    await expect(
      e2bEnvdVersion(secret, (_url, options) => fetch(origin.url, options))(owned),
    ).rejects.toThrow();
    expect(authenticated).toBe(1);
    expect(forwarded).toBe(0);
  } finally {
    await origin.stop(true);
    await destination.stop(true);
  }
});

test("sandbox-info stops and cancels an oversized response before parsing", async () => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(32));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(e2bEnvdVersion(secret, async () => new Response(stream))(owned)).rejects.toThrow(
    "64 KiB diagnostic limit",
  );
  expect(cancelled).toBe(true);
});

for (const reconcileOnly of [false, true])
  test(`aborted late connection awaits and captures release failure (${reconcileOnly ? "reconcile" : "exercise"})`, async () => {
    const store = await ledger();
    const controller = new AbortController();
    let released = false;

    const adapter = defineAdapter({
      name: "late-connect-release-fixture",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect({ host }) {
        host.onClose(() => {
          released = true;
          throw new Error(`Late release failed ${secret}`);
        });
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 25));

        return {
          scope: { authority: { kind: "fixture", id: "scope" }, partition: {} },
          supports: { images: ["prepared"] as const, network: ["blocked"] as const },
          async create() {
            throw new Error("Must not create after aborted connect");
          },
          async destroy() {
            throw new Error("Must not destroy after aborted connect");
          },
        };
      },
    });

    const factory: import("./lifecycle").ConnectionFactory = (onReference, onDiagnostic) =>
      Sandbar.connect({ adapter, config: {}, credentials: {}, onReference, onDiagnostic });

    const steps = reconcileOnly
      ? await reconcileConnection(factory, store, 5, [secret])
      : await runPrepared(factory, store, "base", {
          network: "blocked",
          signal: controller.signal,
          redactions: [secret],
        });

    expect(released).toBe(true);
    expect(steps.find((entry) => entry.scenario === "connect")?.status).toBe("failed");
    expect(steps.find((entry) => entry.scenario === "close")).toMatchObject({
      status: "failed",
      diagnostic: { error: { message: "Late release failed [REDACTED]" } },
    });
    expect((await store.read()).diagnostics?.some((entry) => entry.scenario === "close")).toBe(
      true,
    );
  });
