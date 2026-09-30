import { z } from "zod";
import {
  AdapterSandbox,
  AdapterSnapshot,
  AdapterVolume,
  OutcomeUnknownError,
  WaitAbortedError,
  ResourceReference,
  type AdapterDirectClient,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { SnapshotInfo, assertResourceScope } from "sandbar-adapter";
import { LedgerStore } from "../../provider-qualification/ledger";

const SavedResource = z.union([
  ResourceReference,
  ResourceReference.omit({ scope: true }).extend({ provider: z.literal("daytona") }),
]);

export function partialResource(reference: AdapterRecoveryReference) {
  if (reference.kind === "volume_create") {
    const parsed = z
      .object({ state: z.literal("accepted"), volume: SavedResource })
      .safeParse(reference.token);

    if (
      !parsed.success ||
      parsed.data.volume.kind !== "volume" ||
      parsed.data.volume.ownership !== "verified-created"
    )
      return undefined;

    const volume = ResourceReference.parse(
      "scope" in parsed.data.volume
        ? parsed.data.volume
        : { ...parsed.data.volume, scope: reference.scope },
    );

    assertResourceScope(volume, {
      provider: reference.provider,
      scope: reference.scope,
    });

    return volume;
  }

  if (reference.kind !== "snapshot_capture") return undefined;

  const token = z
    .union([
      z.object({
        captureState: z.enum(["accepted", "completed", "failed"]),
        snapshot: SnapshotInfo.extend({ reference: SavedResource }),
        snapshotId: z.string().optional(),
      }),
      z.object({ snapshot: ResourceReference }),
    ])
    .safeParse(reference.token);

  if (!token.success) return undefined;

  const saved =
    "reference" in token.data.snapshot ? token.data.snapshot.reference : token.data.snapshot;

  if (
    !("scope" in saved) &&
    (!("snapshotId" in token.data) || token.data.snapshotId !== saved.nativeId)
  )
    return undefined;

  const resource = ResourceReference.parse(
    "scope" in saved ? saved : { ...saved, scope: reference.scope },
  );

  if (resource.kind !== "snapshot" || resource.ownership !== "verified-created") return undefined;
  assertResourceScope(resource, {
    provider: reference.provider,
    scope: reference.scope,
  });

  return resource;
}

export function captureInProgress(reference: AdapterRecoveryReference) {
  const parsed = z
    .object({
      provider: z.literal("daytona"),
      kind: z.literal("snapshot_capture"),
      token: z.object({ captureState: z.string() }),
    })
    .safeParse(reference);

  return parsed.success && !["completed", "failed"].includes(parsed.data.token.captureState);
}

export async function cleanupCompute(
  client: AdapterDirectClient,
  ledger: LedgerStore,
  name: string,
  setRole: () => void | Promise<void>,
  budget: number,
  callerSignal?: AbortSignal,
) {
  const entry = (await ledger.read()).stateMutations?.find(
    (entry) => entry.role === name && entry.creation,
  );

  if (!entry || entry.cleanup === "confirmed") return;

  if (!entry.sandboxId) throw new Error("Compute identity is unconfirmed");
  // SAFETY: recover parses the creator receipt and verifies current public connection scope before any deletion.
  const creator = await client.recover(entry.reference as AdapterRecoveryReference);

  if (!["create", "snapshot_restore"].includes(creator.reference.kind))
    throw Error("Compute creator receipt has an incompatible kind");
  await setRole();

  const existing = (await ledger.read()).stateMutations?.find(
    (value) => value.role === `${name}/delete`,
  );

  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(budget)])
    : AbortSignal.timeout(budget);

  if (existing) {
    const saved = z
      .object({ kind: z.literal("destroy"), sandboxId: z.literal(entry.sandboxId) })
      .safeParse(existing.reference);

    if (!saved.success) throw Error("Saved deletion does not match the owned compute identity");
  }

  // SAFETY: recover parses the persisted direct reference and verifies its full connection binding before provider access.
  const operation = existing
    ? await client.recover(existing.reference as AdapterRecoveryReference)
    : await new AdapterSandbox(client, entry.sandboxId).submitDestroy({
        signal,
        storage: "allow-unconfirmed",
      });

  const save = async (reference: AdapterRecoveryReference) =>
    ledger.update((value) => ({
      ...value,
      stateMutations: value.stateMutations?.map((item) =>
        z.object({ submissionId: z.string() }).parse(item.reference).submissionId ===
        reference.submissionId
          ? { ...item, reference }
          : item,
      ),
    }));

  try {
    const value = await operation.wait({ signal });
    await save(operation.reference);

    if (!z.object({ computeStopped: z.literal(true) }).safeParse(value).success)
      throw new Error("Recovered compute cleanup unconfirmed");
  } catch (error) {
    await save(
      (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError) &&
        error.reference.mode === "direct"
        ? error.reference
        : operation.reference,
    );
    throw error;
  }

  await ledger.update((value) => ({
    ...value,
    stateMutations: value.stateMutations?.map((item) =>
      item.role === name ? { ...item, cleanup: "confirmed" } : item,
    ),
  }));
}

/** Reconcile every creator before teardown; never submit a creator from interruption recovery. */
export async function cleanupOwned(
  client: AdapterDirectClient,
  ledger: LedgerStore,
  budget = 60000,
  setRole: (name: string) => void | Promise<void> = () => {},
): Promise<void> {
  const deadline = Date.now() + budget;
  const signal = AbortSignal.timeout(budget);
  let failed = false;
  let cleanupError: unknown;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The diagnostic boundary extracts and redacts bounded Error fields.
  const failure = async (error: unknown) => {
    failed = true;
    cleanupError ??= error;
  };

  const persistReference = async (reference: AdapterRecoveryReference) =>
    ledger.update((value) => ({
      ...value,
      stateMutations: value.stateMutations?.map((entry) =>
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        (entry.reference as AdapterRecoveryReference).submissionId === reference.submissionId
          ? { ...entry, reference, resource: entry.resource ?? partialResource(reference) }
          : entry,
      ),
    }));

  // Capture observation needs the original source alive. Missing identity remains durable.
  const pending =
    (await ledger.read()).stateMutations?.filter(
      (entry) =>
        entry.creation &&
        entry.cleanup === "pending" &&
        ((!entry.resource && !entry.sandboxId) ||
          // SAFETY: This SDK-produced custody reference is schema-parsed by captureInProgress before examining its stage.
          captureInProgress(entry.reference as AdapterRecoveryReference)),
    ) ?? [];

  for (const entry of pending) {
    try {
      // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
      const operation = await client.recover(entry.reference as AdapterRecoveryReference);
      const result = await operation.wait({ signal });
      await persistReference(operation.reference);
      await ledger.update((value) => ({
        ...value,
        stateMutations: value.stateMutations?.map((item) =>
          item.role === entry.role
            ? result instanceof AdapterSandbox
              ? { ...item, sandboxId: result.id }
              : result instanceof AdapterVolume
                ? { ...item, resource: result.reference }
                : z.object({ snapshot: z.instanceof(AdapterSnapshot) }).safeParse(result).success
                  ? {
                      ...item,
                      resource: z.object({ snapshot: z.instanceof(AdapterSnapshot) }).parse(result)
                        .snapshot.reference,
                    }
                  : item
            : item,
        ),
      }));
    } catch (error) {
      if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        await persistReference(error.reference as AdapterRecoveryReference);
      await failure(error);
    }
  }

  // Keep unresolved capture source evidence alive until an operator can inspect it; native TTL remains fallback.
  const unresolved = (await ledger.read()).stateMutations?.some(
    (entry) =>
      entry.creation &&
      entry.cleanup === "pending" &&
      ((!entry.resource && !entry.sandboxId) ||
        // SAFETY: This SDK-produced custody reference is schema-parsed by captureInProgress before examining its stage.
        captureInProgress(entry.reference as AdapterRecoveryReference)),
  );

  for (const entry of (await ledger.read()).stateMutations ?? []) {
    if (!entry.creation || entry.cleanup !== "pending" || !entry.sandboxId) continue;

    if (unresolved && entry.role === "snapshot/source") {
      failed = true;
      continue;
    }

    try {
      await cleanupCompute(
        client,
        ledger,
        entry.role,
        () => setRole(`${entry.role}/delete`),
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        await persistReference(error.reference as AdapterRecoveryReference);
      await failure(error);
    }
  }

  // Delete independently owned retained storage only after all compute dependencies are confirmed gone.
  const computePending = (await ledger.read()).stateMutations?.some(
    (entry) => entry.creation && entry.sandboxId && entry.cleanup === "pending",
  );

  if (!computePending && !unresolved)
    for (const entry of (await ledger.read()).stateMutations ?? []) {
      if (!entry.creation || entry.cleanup !== "pending" || !entry.resource) continue;

      try {
        const resource = ResourceReference.parse(entry.resource);

        if (resource.ownership !== "verified-created")
          throw new Error("Artifact ownership is unverified");
        const deleteRole = `${entry.role}/delete`;
        await setRole(deleteRole);

        const existing = (await ledger.read()).stateMutations?.find(
          (value) => value.role === deleteRole,
        );

        const operation = existing
          ? // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
            await client.recover(existing.reference as AdapterRecoveryReference)
          : resource.kind === "snapshot"
            ? await new AdapterSnapshot(client, resource).submitDelete({ signal })
            : await new AdapterVolume(client, resource).submitDelete({ signal });

        const result = await operation.wait({ signal });
        await persistReference(operation.reference);

        if (!z.object({ deleted: z.literal(true) }).safeParse(result).success)
          throw new Error("Retained artifact deletion unconfirmed");
        await ledger.update((value) => ({
          ...value,
          stateMutations: value.stateMutations?.map((item) =>
            item.role === entry.role ? { ...item, cleanup: "confirmed" } : item,
          ),
        }));
      } catch (error) {
        if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
          // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
          await persistReference(error.reference as AdapterRecoveryReference);
        await failure(error);
      }
    }

  const remaining = (await ledger.read()).stateMutations?.some(
    (entry) => entry.creation && entry.cleanup === "pending",
  );

  await ledger.update((value) => ({
    ...value,
    cleanup:
      failed || remaining
        ? "unresolved"
        : (value.stateMutations ?? []).some(
              (entry) => entry.creation && entry.cleanup !== "not-required",
            )
          ? "confirmed"
          : "not-required",
  }));

  if (failed || remaining)
    throw new Error("Owned cleanup remains unresolved; reconcile the preserved private ledger", {
      cause: cleanupError,
    });
}
