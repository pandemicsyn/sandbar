import {
  Sandbar,
  SandbarError,
  type AdapterDirectClient,
  type AdapterSandbox,
  type ResourceReference,
} from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { e2b } from "sandbar-sdk/e2b";

export type SaveReference = (json: string) => Promise<void>;

export function connectDaytona(config: Parameters<typeof daytona>[0]) {
  return Sandbar.connect(daytona(config));
}

/** A verified teamId gives E2B references a stable scope across credential rotation. */
export function connectE2B(config: Parameters<typeof e2b>[0]) {
  return Sandbar.connect(e2b(config));
}

/** Saving happens in application code after a successful provider operation. */
export async function captureAndSave(box: AdapterSandbox, save: SaveReference) {
  const captured = await box.snapshot();
  console.log(captured.snapshot.provider, captured.snapshot.id);
  await save(JSON.stringify(captured.snapshot.reference));

  return captured;
}

/** Configure matching provider/scope using current credentials before reopening. */
export async function reopenSnapshot(freshClient: AdapterDirectClient, saved: ResourceReference) {
  const snapshot = await freshClient.snapshots.get(saved);

  return snapshot.restore({ networkPolicy: "blocked" });
}

/** A failed composite call may still contain a usable, confirmed capture. */
export async function captureWithPartialResult(box: AdapterSandbox) {
  try {
    return await box.snapshot();
  } catch (error) {
    if (error instanceof SandbarError && error.outcome?.kind === "snapshot_capture") {
      const partial = error.outcome;

      if (partial.status === "partial" && partial.snapshot && partial.capture) {
        return { snapshot: partial.snapshot, capture: partial.capture, restart: partial.restart };
      }
    }

    // Unknown response without an ID requires application policy; never blindly retry.
    throw error;
  }
}
