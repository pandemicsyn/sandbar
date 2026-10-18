import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forget } from "../src/commands";
import { FsStateStore, type SandboxRecord } from "../src/store";

let dir: string;

let store: FsStateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sandbar-store-"));
  store = new FsStateStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(nativeId: string, createdAt: string): SandboxRecord {
  return {
    format: 1,
    kind: "sandbox",
    name: "web",
    status: "created",
    profile: "fake",
    provider: "fake",
    createdAt,
    labels: {},
    reference: {
      version: 1,
      kind: "sandbox",
      provider: "fake",
      scope: { authority: { kind: "account", id: "one" }, partition: {} },
      nativeId,
      ownership: "verified-created",
    },
  };
}

test("forget leaves a replacement created under the same name", async () => {
  const original = record("one", "2026-10-18T10:00:00.000Z");
  const { version } = await store.create("sandbox", "web", original);

  // Another rm removed the record and a create reused the name before this rm finished.
  await store.remove("sandbox", "web", version);
  await store.create("sandbox", "web", record("two", "2026-10-18T10:00:05.000Z"));
  await forget(store, { record: original, version });

  expect((await store.get("sandbox", "web"))?.record.reference?.nativeId).toBe("two");
});

test("forget still drops the same sandbox after a concurrent edit", async () => {
  const original = record("one", "2026-10-18T10:00:00.000Z");
  const { version } = await store.create("sandbox", "web", original);

  await store.update("sandbox", "web", { ...original, labels: { team: "a" } }, version);
  await forget(store, { record: original, version });

  expect(await store.get("sandbox", "web")).toBeNull();
});

test("forget never touches the store for a reference read from a file", async () => {
  const stored = record("one", "2026-10-18T10:00:00.000Z");
  await store.create("sandbox", "web", stored);
  await forget(store, { record: stored, version: "", fromFile: true });

  expect(await store.get("sandbox", "web")).not.toBeNull();
});
