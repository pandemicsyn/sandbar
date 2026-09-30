import { z } from "zod";
import type { AdapterRecoveryReference } from "sandbar-sdk";
import type { ConnectionFactory } from "../../provider-qualification/connection";
import { LedgerStore } from "../../provider-qualification/ledger";
import { boundedRead } from "../../provider-qualification/bounds";
import { cleanupOwned } from "./cleanup";

/** Convert historical baseline custody only; never rewrite the original receipt fields. */
export async function legacyCustody(ledger: LedgerStore) {
  await ledger.update((value) => {
    if (value.stateMutations !== undefined) return value;
    const creator = value.createReference;

    return {
      ...value,
      stateMutations: creator
        ? [
            {
              role: "sandbox/source",
              reference: creator,
              creation: true,
              sandboxId: value.sandboxId,
              cleanup:
                value.cleanup === "confirmed"
                  ? "confirmed"
                  : value.cleanup === "not-required"
                    ? "not-required"
                    : "pending",
            },
            ...(value.destroyReference
              ? [
                  {
                    role: "sandbox/source/delete",
                    reference: value.destroyReference,
                    creation: false,
                    cleanup: "not-required" as const,
                  },
                ]
              : []),
          ]
        : [],
    };
  });
}

/** Observe existing receipts and delete verified-owned resources; creation is forbidden. */
export async function cleanupLedger(
  factory: ConnectionFactory,
  ledger: LedgerStore,
  budget = 60000,
) {
  return ledger.withAdmissionLock(() =>
    ledger.withLock(async () => {
      await legacyCustody(ledger);
      const state = await ledger.read();

      if (state.cleanup === "confirmed" || state.cleanup === "not-required") return;
      let role = "cleanup";

      const journal = async (reference: AdapterRecoveryReference) => {
        const current = await ledger.read();

        const known = current.stateMutations?.some(
          (entry) =>
            z.object({ submissionId: z.string() }).parse(entry.reference).submissionId ===
            reference.submissionId,
        );

        if (known) await ledger.saveStateReference(reference);
        else {
          if (
            reference.kind !== "destroy" &&
            reference.kind !== "snapshot_delete" &&
            reference.kind !== "volume_delete"
          )
            throw Error("Reconciliation forbids new creator attempts");
          await ledger.update((v) => ({
            ...v,
            stateMutations: [
              ...(v.stateMutations ?? []),
              { role, reference, creation: false, cleanup: "not-required" },
            ],
          }));
        }
      };

      const errors: unknown[] = [];
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public SDK release errors are retained as failed cleanup, never copied into support records.

      const opening = factory(journal, (error) => {
        errors.push(error);
      });

      let client: Awaited<ReturnType<ConnectionFactory>> | undefined;

      try {
        client = await boundedRead(opening, AbortSignal.timeout(30000));
        await cleanupOwned(client, ledger, budget, (value) => {
          role = value;
        });
      } catch (error) {
        errors.push(error);
      } finally {
        if (!client) {
          try {
            client = await boundedRead(opening, AbortSignal.timeout(5000));
          } catch {
            void opening.then((late) => late.close()).catch(() => {});
          }
        }

        if (client) {
          try {
            await boundedRead(client.close(), AbortSignal.timeout(5000));
          } catch (error) {
            errors.push(error);
          }
        }
      }

      if (errors.length)
        throw new AggregateError(errors, "Owned reconciliation or SDK release failed");
    }),
  );
}
