import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { SandbarError } from "sandbar-sdk";
import { liveEnabled, setupLive, finishLive, configuredProvider } from "./providers";
import type { TestResources } from "./fixtures/resources";

/** Operator confirms the existing image's first-action protocol; this test never builds it. */
export const storageFixture = z.strictObject({
  imageId: z.string().min(1).max(128),
  firstActionSentinel: z.literal(true),
  vcpu: z.number().positive().max(2),
  memoryMiB: z.number().positive().max(4096),
  diskMiB: z.number().positive().max(10240),
});

export const startupReport = z.strictObject({
  sandboxId: z.string().min(1),
  nonce: z.uuid(),
  runId: z.uuid(),
  marker: z.string().min(1),
  dataHash: z.string().nullable(),
  privateState: z.literal("v1"),
  policy: z.literal("daytona-default"),
  firstAttempt: z.literal(true),
  applicationStarted: z.literal(true),
});

export function checkStartup(
  report: z.infer<typeof startupReport>,
  expected: {
    sandboxId: string;
    runId: string;
    marker: string;
    dataHash: string | null;
    priorNonces: string[];
  },
) {
  expect(report.sandboxId).toBe(expected.sandboxId);
  expect(report.runId).toBe(expected.runId);
  expect(report.marker).toBe(expected.marker);
  expect(report.dataHash).toBe(expected.dataHash);
  expect(expected.priorNonces).not.toContain(report.nonce);
}

const configPath = "/tmp/sandbar-storage-config.json";

const reportPath = "/tmp/sandbar-storage-report.json";

const startedPath = "/tmp/sandbar-storage-started.json";

/** Wait only for atomic publication; the first available report is final evidence. */
export async function readPublishedReport(
  read: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
) {
  const publicationSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);

  for (let attempt = 0; attempt < 20; attempt++) {
    publicationSignal.throwIfAborted();

    try {
      return await read(publicationSignal);
    } catch (error) {
      if (!(error instanceof SandbarError) || error.code !== "NOT_FOUND") throw error;
    }

    await delay(250, undefined, { signal: publicationSignal });
  }

  throw new Error("First-action report was not published within five seconds");
}

/** Daytona may report a snapshot name; resolve it without weakening exact-ID checks. */
const nativeSnapshotIdentity = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  general: z.boolean(),
});

type NativeSnapshotIdentity = z.infer<typeof nativeSnapshotIdentity>;

export async function resolveSnapshotId(
  selector: string,
  organizationId: string,
  read: (selector: string) => Promise<NativeSnapshotIdentity>,
) {
  const detail = z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      organizationId: z.literal(organizationId),
      general: z.literal(false),
    })
    .parse(await read(selector));

  if (detail.id !== selector && detail.name !== selector)
    throw new Error("Native snapshot selector differs from resolved identity");

  return detail.id;
}

const data = '{"total":7}';

const dataHash = new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** First-action reports are read only; executing a sentinel after restore cannot qualify startup. */
export async function storageComposition(
  t: TestResources,
  fixture: z.infer<typeof storageFixture>,
  nativeRead: (id: string) => Promise<{
    id: string;
    snapshot: string;
    networkBlockAll: boolean;
    public: boolean;
    volumes: { volumeId: string; mountPath: string; subpath?: string }[];
  }>,
) {
  const a = await t.volume("a");
  const b = await t.volume("b");

  for (const volume of [a, b]) {
    for (
      let reads = 0;
      reads < 40 && (await volume.inspect({ signal: t.signal })).state === "creating";
      reads++
    )
      await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await volume.inspect({ signal: t.signal })).state).toBe("ready");
  }

  const markerA = `${t.ledger.runId}-a`;
  const markerB = `${t.ledger.runId}-b`;
  const seeder = await t.create("storage/seeder", [a.at("/seed/a"), b.at("/seed/b")]);

  for (const [path, marker] of [
    ["/seed/a", markerA],
    ["/seed/b", markerB],
  ]) {
    await seeder.writeTextFile(`${path}/.sentinel-id`, marker!, {
      overwrite: true,
      signal: t.signal,
    });
    expect(await seeder.readTextFile(`${path}/.sentinel-id`, { signal: t.signal })).toBe(marker!);
  }

  await seeder.writeTextFile("/seed/a/report.json", data, { overwrite: true, signal: t.signal });
  expect(await seeder.readTextFile("/seed/a/report.json", { signal: t.signal })).toBe(data);
  expect(
    await t.exec(seeder, `python3 -c 'import os;print(os.path.exists("/seed/b/report.json"))'`),
  ).toBe("False\n");
  await t.destroy("storage/seeder");
  const source = await t.create("snapshot/source");
  await source.writeTextFile("/tmp/app-version.txt", "v1", { signal: t.signal });
  await source.writeTextFile(
    configPath,
    JSON.stringify({
      runId: t.ledger.runId,
      policy: "daytona-default",
      profiles: [
        { marker: markerA, dataHash },
        { marker: markerB, dataHash: null },
      ],
    }),
    { signal: t.signal },
  );
  t.at("snapshot/capture");
  const captured = await t.wait(await source.submitSnapshot(undefined, { signal: t.signal }));
  expect(captured.source.state).toBe("stopped");
  expect(captured.capture).toMatchObject({ preserve: "filesystem", restoreExecution: "fresh" });

  const saved = JSON.parse(
    JSON.stringify({ snapshot: captured.snapshot.reference, a: a.reference, b: b.reference }),
  );

  await t.destroy("snapshot/source");
  await t.reconnect();
  let snapshot = await t.client.snapshots.get(saved.snapshot);
  expect((await snapshot.inspect({ signal: t.signal })).mountHandling).toBe("none");
  const nonces: string[] = [];

  for (const [ref, marker, hash, role] of [
    [saved.a, markerA, dataHash, "storage/restore-a"],
    [saved.b, markerB, null, "storage/restore-b"],
  ] as const) {
    snapshot = await t.client.snapshots.get(saved.snapshot);
    const volume = await t.client.volumes.get(ref);
    const mounts = [volume.at("/data")];
    t.at(role);

    const box = await t.wait(
      await snapshot.submitRestore(
        { networkPolicy: "daytona-default", mounts },
        { signal: t.signal },
      ),
    );

    const rawReport = await readPublishedReport(
      (signal) => box.readTextFile(reportPath, { signal }),
      t.signal,
    );

    await writeFile(
      join(process.env.SANDBAR_LIVE_REPORT_DIR!, `${role.split("/")[1]}.startup.json`),
      rawReport,
      { mode: 0o600, flag: "wx" },
    );
    const report = startupReport.parse(JSON.parse(rawReport));

    checkStartup(report, {
      sandboxId: box.id,
      runId: t.ledger.runId,
      marker,
      dataHash: hash,
      priorNonces: nonces,
    });
    expect(JSON.parse(await box.readTextFile(startedPath, { signal: t.signal }))).toEqual({
      sandboxId: box.id,
      nonce: report.nonce,
    });
    nonces.push(report.nonce);
    expect(await box.readTextFile("/tmp/app-version.txt", { signal: t.signal })).toBe("v1");
    expect(await nativeRead(box.id)).toMatchObject({
      id: box.id,
      snapshot: snapshot.id,
      networkBlockAll: false,
      public: false,
      volumes: [{ volumeId: volume.id, mountPath: "/data" }],
    });
    expect((await nativeRead(box.id)).volumes).toHaveLength(1);
    const reference = JSON.parse(JSON.stringify(box.reference));
    expect(reference).not.toHaveProperty("mounts");
    await t.reconnect();
    const reopened = await t.client.sandboxes.get(reference);
    expect(reopened.reference).toEqual(reference);
    expect((await nativeRead(reopened.id)).volumes).toEqual([
      { volumeId: volume.id, mountPath: "/data" },
    ]);
    await t.destroy(role);
  }
  // Existing teardown deletes the captured snapshot and both owned volumes after compute.
}

const enabled = liveEnabled && process.env.SANDBAR_STORAGE_COMPOSITION === "1";

describe("Sandbar storage composition", () => {
  let live: Awaited<ReturnType<typeof setupLive>> | undefined;
  let fixture: z.infer<typeof storageFixture>;
  beforeAll(async () => {
    if (!enabled) return;
    fixture = storageFixture.parse(JSON.parse(process.env.SANDBAR_STORAGE_FIXTURE ?? "null"));

    if (
      process.env.SANDBAR_QUAL_PROVIDER !== "daytona" ||
      process.env.SANDBAR_DAYTONA_TARGET !== "us" ||
      process.env.SANDBAR_DAYTONA_NETWORK_POLICY !== "daytona-default" ||
      fixture.imageId !== process.env.SANDBAR_DAYTONA_SNAPSHOT_ID
    )
      throw new Error(
        "Storage acceptance requires the confirmed existing Daytona sentinel image and explicit daytona-default",
      );
    await configuredProvider(); // Loads existing credentials; does not allocate.

    const response = await fetch(
      `https://app.daytona.io/api/snapshots/${encodeURIComponent(fixture.imageId)}`,
      {
        headers: { Authorization: `Bearer ${process.env.SANDBAR_DAYTONA_API_KEY}` },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );

    if (!response.ok) throw new Error("Prepared fixture metadata is unavailable");

    const native = z
      .object({
        id: z.string(),
        name: z.string(),
        state: z.literal("active"),
        cpu: z.number(),
        mem: z.number(),
        disk: z.number(),
        sandboxClass: z.literal("container"),
        regionIds: z.array(z.string()),
      })
      .parse(await response.json());

    if (native.id !== fixture.imageId && native.name !== fixture.imageId)
      throw new Error("Prepared fixture identity differs");

    if (
      native.cpu !== fixture.vcpu ||
      native.mem * 1024 !== fixture.memoryMiB ||
      native.disk * 1024 !== fixture.diskMiB ||
      !native.regionIds.includes("us")
    )
      throw new Error("Prepared fixture native defaults/region differ from confirmed limits");
    live = await setupLive(["storage-composition"], { compute: 4, volumes: 2, snapshots: 1 });
    await live.resources.setup(() => live!.resources.open());
  }, 96000);
  afterAll(async () => {
    if (live) await finishLive(live);
  }, 76000);
  (enabled ? test : test.skip)(
    "storage-composition",
    async () => {
      const nativeRead = async (id: string) => {
        const response = await fetch(
          `https://app.daytona.io/api/sandbox/${encodeURIComponent(id)}`,
          {
            headers: { Authorization: `Bearer ${process.env.SANDBAR_DAYTONA_API_KEY}` },
            signal: live!.resources.signal,
          },
        );

        if (!response.ok) throw new Error("Native storage detail unavailable");

        const detail = z
          .object({
            id: z.literal(id),
            organizationId: z.literal(live!.resources.client.scope.authority.id),
            snapshot: z.string(),
            networkBlockAll: z.boolean(),
            public: z.boolean(),
            volumes: z.array(
              z.object({
                volumeId: z.string(),
                mountPath: z.string(),
                subpath: z.string().optional(),
              }),
            ),
          })
          .parse(await response.json());

        detail.snapshot = await resolveSnapshotId(
          detail.snapshot,
          live!.resources.client.scope.authority.id,
          async (selector) => {
            const snapshot = await fetch(
              `https://app.daytona.io/api/snapshots/${encodeURIComponent(selector)}`,
              {
                headers: { Authorization: `Bearer ${process.env.SANDBAR_DAYTONA_API_KEY}` },
                redirect: "error",
                signal: live!.resources.signal,
              },
            );

            if (!snapshot.ok) throw new Error("Native snapshot identity unavailable");

            return nativeSnapshotIdentity.parse(await snapshot.json());
          },
        );

        return detail;
      };

      await storageComposition(live!.resources, fixture, nativeRead);
    },
    241000,
  );
});
