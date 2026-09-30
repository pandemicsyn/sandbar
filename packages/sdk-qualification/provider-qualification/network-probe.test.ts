import { expect, test } from "bun:test";
import {
  networkScript,
  networkSampleSchema,
  requireBlocked,
  requireInternet,
} from "./network-probe";
import { parseReport, renderLiveMatrix } from "./report";

const outcomes = (connected: boolean, error = "timeout") => ({
  attempts: [
    connected ? { target: "hostname", connected } : { target: "hostname", connected, error },
    connected ? { target: "ipv4", connected } : { target: "ipv4", connected, error },
  ],
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
