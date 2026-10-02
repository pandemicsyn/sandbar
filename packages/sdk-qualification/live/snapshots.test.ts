import type { SnapshotProfile } from "sandbar-adapter";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ResourceReference, SandbarError, OutcomeUnknownError } from "sandbar-sdk";
import { z } from "zod";
import { TestResources } from "./fixtures/resources";
import { liveEnabled, setupLive, finishLive, featureSupported, reopenSnapshot } from "./providers";

import {
  processAbsent,
  memoryProgram,
  memoryRead,
  quote,
  memorySample,
} from "./fixtures/memory-probe";

const bytes = new Uint8Array([0, 255, 10, 83, 97, 110, 100, 98, 97, 114]);

const sourceChanged = new Uint8Array([1, 2, 3]);

const restoredChanged = new Uint8Array([4, 5, 6]);

/** Shared assertion body; fixtures exercise it offline and Bun runs it natively live. */
export async function snapshotRoundtrip(
  t: TestResources,
  reopen: (reference: ResourceReference) => Promise<void>,
  path = "/tmp/sandbar-captured.bin",
  selectedProfile: (profile: SnapshotProfile) => void = () => {},
) {
  const restore = (await t.client.capabilities()).snapshots.restore;

  if (restore.status !== "supported")
    throw new SandbarError(
      restore.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
      restore.reason,
    );
  const source = await t.create("snapshot/source");
  const plan = await source.checkSnapshot();

  if (plan.status !== "supported")
    throw new SandbarError(
      plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
      plan.reason,
    );
  selectedProfile(plan.value.profile);

  expect(plan.value.profile.sourceAfter).toBe("unchanged");
  expect(plan.value.sourceState).toBe("running");
  t.at("snapshot/write");
  await source.writeFile(path, bytes, { overwrite: true, signal: t.signal });
  await t.exec(source, `python3 -c ${quote(memoryProgram)} >/tmp/sandbar-memory-error 2>&1 &`);
  let before: ReturnType<typeof memorySample> | undefined;

  for (let index = 0; index < 10 && !before; index++) {
    try {
      before = memorySample(await t.exec(source, memoryRead));
    } catch {
      if (index === 9) throw Error("Memory process did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  t.at("snapshot/capture");
  const operation = await source.submitSnapshot(undefined, { signal: t.signal });

  const result = await (async () => {
    try {
      return await t.wait(operation);
    } catch (error) {
      const restart = z
        .object({ captureState: z.literal("completed"), restartState: z.literal("not-submitted") })
        .safeParse(operation.reference.token);

      if (!(error instanceof OutcomeUnknownError) || !restart.success || t.signal.aborted)
        throw error;
      await operation.continue({ signal: t.signal });

      return t.wait(operation);
    }
  })();

  expect(result.source.state).toBe("running");
  expect((await source.inspect({ signal: t.signal })).state).toBe("running");
  const info = await result.snapshot.inspect({ signal: t.signal });
  expect(info.preserve).toBe(plan.value.profile.preserve);
  expect(info.restoreExecution).toBe(plan.value.profile.restoreExecution);
  expect(result.capture.preserve).toBe(plan.value.profile.preserve);
  expect(result.capture.restoreExecution).toBe(plan.value.profile.restoreExecution);
  expect(result.capture.interruption).toBe(plan.value.profile.interruption);
  expect(info.mountHandling).toBe("none");
  expect(info.state).toBe("ready");
  t.at("snapshot/restore");

  const restored = await t.wait(
    await result.snapshot.submitRestore(
      { networkPolicy: t.network, requireIndependentLifecycle: true },
      { signal: t.signal },
    ),
  );

  expect(restored.id).not.toBe(source.id);
  expect(await t.read(restored, path)).toEqual(bytes);
  await source.writeFile(path, sourceChanged, { overwrite: true, signal: t.signal });
  expect(await t.read(source, path)).toEqual(sourceChanged);
  expect(await t.read(restored, path)).toEqual(bytes);

  if (plan.value.profile.restoreExecution === "resume" && before) {
    const first = memorySample(await t.exec(restored, memoryRead));
    const second = memorySample(await t.exec(restored, memoryRead));
    const original = memorySample(await t.exec(source, memoryRead));
    expect([first.nonce, second.nonce, original.nonce]).toEqual([
      before.nonce,
      before.nonce,
      before.nonce,
    ]);
    expect([first.count, second.count, original.count]).toEqual([
      before.count + 1,
      before.count + 2,
      before.count + 1,
    ]);
  }

  if (plan.value.profile.restoreExecution === "fresh") {
    expect(await t.exec(restored, processAbsent)).toBe("PROCESS_ABSENT\n");
    expect(await t.exec(source, processAbsent)).toBe("PROCESS_ABSENT\n");
  }

  await restored.writeFile(path, restoredChanged, { overwrite: true, signal: t.signal });
  expect(await t.read(restored, path)).toEqual(restoredChanged);
  expect(await t.read(source, path)).toEqual(sourceChanged);
  await t.destroy("snapshot/source");
  await t.destroy("snapshot/restore");
  const saved = ResourceReference.parse(JSON.parse(JSON.stringify(result.snapshot.reference)));
  await reopen(saved);
  await t.reconnect();
  const reopened = await t.client.snapshots.get(saved);
  const metadata = await reopened.inspect({ signal: t.signal });
  expect(metadata.reference.nativeId).toBe(saved.nativeId);
  expect(metadata.reference.generation).toBe(saved.generation);
  expect(metadata.mountHandling).toBe("none");
  t.at("snapshot/restore-second");

  const again = await t.wait(
    await reopened.submitRestore(
      { networkPolicy: t.network, requireIndependentLifecycle: true },
      { signal: t.signal },
    ),
  );

  expect(again.id).not.toBe(source.id);
  expect(again.id).not.toBe(restored.id);
  expect(await t.read(again, path)).toEqual(bytes);

  return plan.value.profile;
}

const enabled = liveEnabled && featureSupported("snapshots");

describe("Sandbar snapshots", () => {
  let fixture: Awaited<ReturnType<typeof setupLive>> | undefined;
  beforeAll(async () => {
    if (enabled) {
      fixture = await setupLive(["snapshot-roundtrip"], { compute: 3, snapshots: 1, volumes: 0 });
      await fixture.resources.setup(() => fixture!.resources.open());
    }
  }, 96000);
  afterAll(async () => {
    if (fixture) await finishLive(fixture);
  }, 76000);
  (enabled ? test : test.skip)(
    "snapshot-roundtrip",
    async () => {
      const configured = fixture!;

      Object.assign(configured.context.configuration, {
        stateProbe: "snapshot-roundtrip-v3",
        freshProcess: true,
      });
      await snapshotRoundtrip(
        configured.resources,
        (reference) => reopenSnapshot(configured, reference),
        configured.fileRoot + "/sandbar-captured.bin",
        (profile) => {
          Object.assign(configured.context.configuration, {
            preserve: profile.preserve,
            restoreExecution: profile.restoreExecution,
            sourceAfter: "running",
          });
        },
      );
    },
    241000,
  );
});
