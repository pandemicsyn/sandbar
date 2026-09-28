import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbar } from "sandbar-sdk";
import { defineAdapter } from "../../adapter/src/index";
import { z } from "zod";
import { LedgerStore, reportedCleanup } from "./ledger";
import { runNetworkPair } from "./network-profile";
import { parseReport, renderLiveMatrix } from "./report";
import {
  networkScript,
  networkSampleSchema,
  requireBlocked,
  requireInternet,
} from "./network-probe";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const outcomes = (connected: boolean, error = "timeout") => ({
  attempts: [
    connected ? { target: "hostname", connected } : { target: "hostname", connected, error },
    connected ? { target: "ipv4", connected } : { target: "ipv4", connected, error },
  ],
});

async function fixture(
  replies = [outcomes(true), outcomes(false), outcomes(true)],
  failDestroy = false,
  failCreate = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-network-offline-"));
  directories.push(directory);
  const internet = new LedgerStore(directory, crypto.randomUUID());
  const blocked = new LedgerStore(directory, crypto.randomUUID());

  for (const store of [internet, blocked])
    await store.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" });
  let next = 0;
  const created: string[] = [];
  const destroyed: string[] = [];
  const commands: string[] = [];
  let closes = 0;

  const adapter = defineAdapter({
    name: "network-offline-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        closes++;
      });
      const id = `owned-${++next}`;
      let stopped = false;

      return {
        scope: { authority: { kind: "fixture", id: "network" }, partition: {} },
        supports: {
          images: ["prepared"] as const,
          network: ["blocked", "internet"] as const,
          exec: { commands: ["argv"] as const, maxOutputBytes: 4096 },
        },
        async create(input) {
          created.push(input.networkPolicy);

          if (failCreate) throw new Error("offline create failure");

          return { id, state: "running" as const };
        },
        async exec(input) {
          expect(input.command.kind).toBe("argv");
          expect(input.deadlineSeconds).toBe(20);
          commands.push(id);

          return {
            exitCode: 0,
            stdout: new TextEncoder().encode(JSON.stringify(replies.shift())),
            stderr: new Uint8Array(),
            truncated: false,
          };
        },
        async destroy() {
          destroyed.push(id);

          if (failDestroy) throw new Error("offline cleanup failure");
          stopped = true;

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect() {
          return { id, state: stopped ? ("destroyed" as const) : ("running" as const) };
        },
      };
    },
  });

  const factory = (onReference: Parameters<typeof Sandbar.connect>[0]["onReference"]) =>
    Sandbar.connect({ adapter, config: {}, credentials: {}, onReference });

  return {
    internet,
    blocked,
    created,
    destroyed,
    commands,
    closes: () => closes,
    run: (imageId = "base") =>
      runNetworkPair(factory, internet, blocked, imageId, { cleanupWaitMs: 0 }),
  };
}

test("paired public SDK probes bracket blocked TCP with the same internet control and clean both", async () => {
  const native = await fixture();
  const runs = await native.run();
  expect(native.created).toEqual(["internet", "blocked"]);
  expect(native.commands).toEqual(["owned-1", "owned-2", "owned-1"]);
  expect(native.destroyed).toEqual(["owned-2", "owned-1"]);
  expect(native.closes()).toBe(2);

  for (const run of runs) {
    expect(run.steps.find((step) => step.scenario === `network-${run.policy}`)?.status).toBe(
      "passed",
    );
    expect((await run.ledger.read()).cleanup).toBe("confirmed");
    expect(
      (await run.ledger.read()).networkEvidence?.samples.map((sample) => sample.phase),
    ).toEqual(["before", "blocked", "after"]);
  }
});

test("an unavailable before control prevents the blocked allocation", async () => {
  const native = await fixture([outcomes(false)]);
  const runs = await native.run();
  expect(native.created).toEqual(["internet"]);
  expect(runs.find((run) => run.policy === "blocked")?.steps[0]?.status).toBe("blocked");
  expect((await native.blocked.read()).cleanup).toBe("not-required");
  expect(native.destroyed).toEqual(["owned-1"]);
});

test("failed after control cannot produce an isolation pass and both resources are cleaned", async () => {
  const native = await fixture([outcomes(true), outcomes(false), outcomes(false)]);
  const runs = await native.run();

  for (const run of runs)
    expect(run.steps.find((step) => step.scenario === `network-${run.policy}`)?.status).toBe(
      "failed",
    );
  expect(native.destroyed).toEqual(["owned-2", "owned-1"]);

  const failed = runs
    .find((run) => run.policy === "blocked")
    ?.steps.find((step) => step.scenario === "network-blocked");

  expect(failed?.networkEvidence?.samples.map((sample) => sample.phase)).toEqual([
    "before",
    "blocked",
    "after",
  ]);
  expect(failed?.networkEvidence?.samples[2]?.attempts[0]?.connected).toBe(false);
});

test("an outbound connection leak still runs the after control and fails blocked qualification", async () => {
  const native = await fixture([outcomes(true), outcomes(true), outcomes(true)]);
  const runs = await native.run();
  expect(native.commands).toHaveLength(3);
  expect(
    runs
      .find((run) => run.policy === "blocked")
      ?.steps.find((step) => step.scenario === "network-blocked")?.status,
  ).toBe("failed");
  expect(
    runs
      .find((run) => run.policy === "internet")
      ?.steps.find((step) => step.scenario === "network-internet")?.status,
  ).toBe("passed");
  expect(native.destroyed).toHaveLength(2);

  const failed = runs
    .find((run) => run.policy === "blocked")
    ?.steps.find((step) => step.scenario === "network-blocked");

  expect(failed?.networkEvidence?.samples[1]?.attempts[0]?.connected).toBe(true);
});

test("cleanup failure remains unresolved independently for both sandboxes", async () => {
  const native = await fixture(undefined, true);
  await native.run();
  expect((await native.internet.read()).cleanup).toBe("unresolved");
  expect((await native.blocked.read()).cleanup).toBe("unresolved");
  expect(native.destroyed).toHaveLength(2);
});

test("DNS failure, refusal and unknown errors are inconclusive rather than blocked passes", () => {
  for (const error of ["dns", "refused", "other"])
    expect(() =>
      requireBlocked(networkSampleSchema.parse({ ...outcomes(false, error), phase: "blocked" })),
    ).toThrow();
  expect(() =>
    requireInternet(networkSampleSchema.parse({ ...outcomes(false), phase: "before" })),
  ).toThrow();
});

test("either companion order contends on the same pair lock", async () => {
  const native = await fixture();
  await native.internet.withAdmissionLock(async () => {
    await expect(
      native.blocked.withAdmissionLock(async () => {}, native.internet),
    ).rejects.toMatchObject({ code: "EEXIST" });
  }, native.blocked);
  await native.blocked.withAdmissionLock(async () => {}, native.internet);
});

test("report rejects missing controls and an isolation pass with outbound connectivity", () => {
  const record = {
    schemaVersion: 1,
    provider: "e2b",
    scenario: "network-blocked",
    mode: "fixture",
    status: "passed",
    sdkCommit: "a".repeat(40),
    sdkVersion: "0.0.0",
    runtime: "Bun",
    platform: "fixture",
    timestamp: new Date().toISOString(),
    configuration: {
      imageClass: "prepared",
      network: "blocked-requested",
      regionClass: "provider-default",
    },
  };

  const sample = (phase: string, connected: boolean) => ({ ...outcomes(connected), phase });

  const report = (samples: ReturnType<typeof sample>[]) => ({
    schemaVersion: 1,
    records: [
      { ...record, networkEvidence: { probe: "cloudflare-tcp443-hostname-ipv4-v1", samples } },
    ],
  });

  expect(() => parseReport({ schemaVersion: 1, records: [record] })).toThrow();
  expect(() =>
    parseReport(report([sample("before", true), sample("blocked", true), sample("after", true)])),
  ).toThrow();
  expect(() =>
    parseReport(report([sample("before", true), sample("blocked", false), sample("after", false)])),
  ).toThrow();
  expect(
    parseReport(report([sample("before", true), sample("blocked", false), sample("after", true)]))
      .records[0]?.status,
  ).toBe("passed");
});

test("guest Python probe runs offline with bounded sockets and emits both target outcomes", () => {
  const driver = `import socket, sys
class Connection:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def settimeout(self, timeout): assert timeout == 3
    def connect(self, address):
        if address[0] == "1.1.1.1": raise TimeoutError()
socket.getaddrinfo = lambda host, port, family, kind: [(family, kind, 0, "", (host, port))]
socket.socket = lambda *args: Connection()
exec(sys.argv[1])
`;

  const result = Bun.spawnSync({ cmd: ["python3", "-c", driver, networkScript] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    attempts: [
      { target: "hostname", connected: true },
      { target: "ipv4", connected: false, error: "timeout" },
    ],
  });
});

test("failed control creation blocks both network scenarios without a second allocation", async () => {
  const native = await fixture(undefined, false, true);
  const runs = await native.run();
  expect(native.created).toEqual(["internet"]);
  expect(native.commands).toHaveLength(0);

  for (const run of runs) {
    const step = run.steps.find((step) => step.scenario === `network-${run.policy}`);
    expect(step?.status).toBe("blocked");
    expect(step?.issue).toBe("dependency-failed");
  }

  expect((await native.blocked.read()).cleanup).toBe("not-required");
});

test("custom template is rejected before any connection or native create", async () => {
  const native = await fixture();
  await expect(native.run("custom-template")).rejects.toThrow("public base template");
  expect(native.created).toHaveLength(0);
  expect(native.commands).toHaveLength(0);
});

test("admission lock protects new ledger publication before the first SDK request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-admission-offline-"));
  directories.push(directory);
  const first = new LedgerStore(directory, crypto.randomUUID());
  const second = new LedgerStore(directory, crypto.randomUUID());
  await first.withAdmissionLock(async () => {
    await first.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" });
    await second.initialize("e2b", { kind: "borrowed-prepared", class: "prepared" });
    await expect(second.withAdmissionLock(async () => {}, first)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await first.read()).createIntent).toBe(false);
  }, second);
  await second.withAdmissionLock(async () => {}, first);
});

test("snapshot pass cannot enter evidence without explicit workflow observations", () => {
  expect(() =>
    parseReport({
      schemaVersion: 1,
      records: [
        {
          schemaVersion: 1,
          provider: "e2b",
          scenario: "snapshot-roundtrip",
          mode: "fixture",
          status: "passed",
          sdkCommit: "a".repeat(40),
          sdkVersion: "0.0.0",
          runtime: "Bun",
          platform: "fixture",
          timestamp: new Date().toISOString(),
          configuration: {
            imageClass: "prepared",
            network: "blocked-requested",
            regionClass: "provider-default",
          },
        },
      ],
    }),
  ).toThrow("explicit workflow observations");
});

test("paired cleanup report is independent of which UUID reconciles the pair", () => {
  const confirmed = { cleanup: "confirmed" as const };
  const unused = { cleanup: "not-required" as const };
  expect(reportedCleanup([confirmed, unused])).toBe("confirmed");
  expect(reportedCleanup([unused, confirmed])).toBe("confirmed");
  expect(reportedCleanup([confirmed, { cleanup: "unresolved" }])).toBe("incomplete");
  expect(reportedCleanup([unused, unused])).toBe("not-required");
});

test("measured network proof cannot supersede an unrecorded probe scope", () => {
  const record = {
    schemaVersion: 1,
    provider: "e2b",
    scenario: "network-blocked",
    mode: "live",
    status: "failed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "b".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "e2b 2.51.0",
    runCleanup: "confirmed",
    runtime: "Bun",
    platform: "fixture",
    timestamp: "2026-09-27T00:00:00Z",
    configuration: {
      imageClass: "prepared",
      templateClass: "public-base",
      authorityClass: "api-key",
      network: "blocked-requested",
      regionClass: "provider-default",
    },
    evidenceRef: "specs/older-probe.md",
  };

  const measured = {
    ...record,
    timestamp: "2026-09-28T00:00:00Z",
    evidenceRef: "specs/measured-probe.md",
    networkEvidence: {
      probe: "cloudflare-tcp443-hostname-ipv4-v1",
      samples: [
        { ...outcomes(true), phase: "before" },
        { ...outcomes(true), phase: "blocked" },
        { ...outcomes(true), phase: "after" },
      ],
    },
  };

  const rendered = renderLiveMatrix([
    parseReport({ schemaVersion: 1, records: [record, measured] }),
  ]);

  expect(rendered).toContain("specs/older-probe.md");
  expect(rendered).toContain("specs/measured-probe.md");
  expect(rendered).toContain("blocked-requested / cloudflare-tcp443-hostname-ipv4-v1");
});

test("same intended probe failure supersedes an older pass even without captured samples", () => {
  const probe = "cloudflare-tcp443-hostname-ipv4-v1";

  const record = {
    schemaVersion: 1,
    provider: "e2b",
    scenario: "network-blocked",
    mode: "live",
    status: "passed",
    sdkCommit: "a".repeat(40),
    harnessCommit: "b".repeat(40),
    sdkVersion: "0.0.0",
    nativeVersion: "e2b 2.51.0",
    runCleanup: "confirmed",
    runtime: "Bun",
    platform: "fixture",
    timestamp: "2026-09-27T00:00:00Z",
    configuration: {
      imageClass: "prepared",
      templateClass: "public-base",
      authorityClass: "api-key",
      network: "blocked-requested",
      networkProbe: probe,
      regionClass: "provider-default",
    },
    evidenceRef: "specs/older-pass.md",
    networkEvidence: {
      probe,
      samples: [
        { ...outcomes(true), phase: "before" },
        { ...outcomes(false), phase: "blocked" },
        { ...outcomes(true), phase: "after" },
      ],
    },
  };

  const failed = {
    ...record,
    timestamp: "2026-09-28T00:00:00Z",
    status: "failed",
    networkEvidence: undefined,
    evidenceRef: "specs/latest-failure.md",
  };

  const rendered = renderLiveMatrix([parseReport({ schemaVersion: 1, records: [record, failed] })]);
  expect(rendered).toContain("specs/latest-failure.md");
  expect(rendered).not.toContain("specs/older-pass.md");
  expect(rendered).toContain("blocked-requested / cloudflare-tcp443-hostname-ipv4-v1");
});
