import { afterEach, expect, test } from "bun:test";
import { Image } from "sandbar-sdk";
import { fixture, disposeFixtures } from "./offline";
import { cleanupLedger } from "./reconcile";
import { recordLegacyReference } from "../../provider-qualification/ledger";

afterEach(disposeFixtures);

async function legacy(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await f.connect((ref) => recordLegacyReference(f.ledger, ref));

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared("base"),
      networkPolicy: "blocked",
    });

    await f.ledger.update((v) => ({
      ...v,
      createIntent: true,
      sandboxId: box.id,
      cleanup: "unresolved",
    }));
  } finally {
    await client.close();
  }

  return (await f.ledger.read()).createReference!;
}

test("legacy creator binding is verified before any known-ID deletion", async () => {
  const f = await fixture();
  const ref = await legacy(f);
  await f.ledger.update((v) => ({
    ...v,
    createReference: {
      ...ref,
      scope: { ...ref.scope, authority: { kind: "fixture", id: "foreign" } },
    },
  }));
  await expect(cleanupLedger(f.connect, f.ledger, 1000)).rejects.toThrow();
  expect(f.boxes.size).toBe(1);
  expect(f.calls.destroy).toBe(0);
  await f.ledger.update((v) => ({
    ...v,
    stateMutations: v.stateMutations?.map((e) => (e.creation ? { ...e, reference: ref } : e)),
  }));
  await cleanupLedger(f.connect, f.ledger, 1000);
  expect(f.boxes.size).toBe(0);
});

test("saved delete must target the verified-owned compute identity", async () => {
  const f = await fixture();
  const ref = await legacy(f);
  await f.ledger.update((v) => ({
    ...v,
    destroyReference: {
      ...ref,
      kind: "destroy",
      sandboxId: "other",
      submissionId: "delete",
      operationId: "delete",
    },
  }));
  await expect(cleanupLedger(f.connect, f.ledger, 1000)).rejects.toThrow();
  expect(f.calls.destroy).toBe(0);
  expect(f.boxes.size).toBe(1);
});

test("SDK release failure makes standalone reconciliation unsuccessful even after resource deletion", async () => {
  const f = await fixture({ failClose: true });
  await legacy(f);
  await expect(cleanupLedger(f.connect, f.ledger, 1000)).rejects.toThrow("release failed");
  expect(f.boxes.size).toBe(0);
  expect((await f.ledger.read()).cleanup).toBe("confirmed");
  await f.ledger.withAdmissionLock(async () => {});
});
