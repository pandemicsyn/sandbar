import {
  OutcomeUnknownError,
  Sandbar,
  SandbarError,
  WaitAbortedError,
  type AdapterRecoveryReference,
  type DirectClient,
  type DirectSandboxHandle,
  type RecoveryOutcome,
} from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

/** The application implements an awaited durable write; JSON has no provider credentials. */
export type SaveReference = (json: string) => Promise<void>;

export function connectDaytona(
  config: Parameters<typeof daytona>[0],
  save: SaveReference,
): Promise<DirectClient> {
  return Sandbar.connect(daytona(config), {
    async onReference(reference) {
      await save(JSON.stringify(reference));
    },
  });
}

/** Configure a verified teamId when references must survive E2B API-key rotation. */
export function connectE2B(
  config: Parameters<typeof e2b>[0],
  save: SaveReference,
): Promise<DirectClient> {
  return Sandbar.connect(e2b(config), {
    async onReference(reference) {
      await save(JSON.stringify(reference));
    },
  });
}

export async function inspectRetainedSnapshots(client: DirectClient, outcome: RecoveryOutcome) {
  const references = outcome.retainedResources.filter((reference) => reference.kind === "snapshot");

  return Promise.all(
    references.map(async (reference) => (await client.snapshots.get(reference)).inspect()),
  );
}

/** A completed capture can survive a later source-restart failure. */
export async function captureWithRecovery(
  client: DirectClient,
  box: DirectSandboxHandle,
  save: SaveReference,
) {
  try {
    const result = await box.snapshot();

    return { capture: result.capture, snapshot: result.snapshot.reference };
  } catch (error) {
    if (
      (error instanceof OutcomeUnknownError ||
        error instanceof WaitAbortedError ||
        error instanceof SandbarError) &&
      error.outcome
    ) {
      const outcome = error.outcome;
      await save(JSON.stringify(outcome.reference));
      const snapshots = await inspectRetainedSnapshots(client, outcome);

      return { outcome, snapshots };
    }

    throw error;
  }
}

/** Call under the application's cross-process lease or compare-and-swap. */
export async function recoverCapture(
  freshClient: DirectClient,
  savedReference: AdapterRecoveryReference,
) {
  const operation = await freshClient.recover(savedReference);

  if (operation.kind !== "snapshot_capture") throw new Error("Expected a snapshot capture");

  // Recovery and observation use current credentials and perform no mutation replay.
  const observed = await operation.observe().catch((error) => {
    if (error instanceof SandbarError && error.outcome) return null;

    throw error;
  });

  if (observed) return { snapshot: observed.snapshot.reference, capture: observed.capture };

  const outcome = operation.outcome;
  const snapshots = await inspectRetainedSnapshots(freshClient, outcome);

  if (outcome.continuation.status !== "eligible") {
    // Pending/uncertain work stays observable; unknown is never completed capture.
    return { outcome, snapshots };
  }

  // The provider rechecks native state and dispatch authority before the next stage.
  await operation.continue();
  const result = await operation.wait();

  return { snapshot: result.snapshot.reference, capture: result.capture };
}

/** Explicit submission exposes partial evidence before any convenience wait ends. */
export async function submitCapture(box: DirectSandboxHandle, save: SaveReference) {
  const operation = await box.submitSnapshot();
  await save(JSON.stringify(operation.reference));

  return { operation, outcome: operation.outcome };
}
