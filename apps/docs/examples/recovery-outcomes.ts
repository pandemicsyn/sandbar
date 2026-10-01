import {
  Sandbar,
  SandbarError,
  type AdapterDirectClient,
  type AdapterSandbox,
  type ResourceReference,
  type SnapshotResult,
  type AdapterVolume,
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

/** Capture and save are separate so a failed application save cannot hide the handle. */
export async function captureSnapshot(box: AdapterSandbox) {
  const captured = await box.snapshot();
  console.log(captured.snapshot.provider, captured.snapshot.id);

  return captured;
}

export async function saveSnapshot(captured: SnapshotResult, save: SaveReference) {
  await save(JSON.stringify(captured.snapshot.reference));
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

/** Keep retained storage across connections; compute cleanup does not delete it. */
export function createVolume(client: AdapterDirectClient) {
  return client.volumes.create({ name: "workspace-data" });
}

export async function saveVolume(volume: AdapterVolume, save: SaveReference) {
  await save(JSON.stringify(volume.reference));
}

export async function reopenVolume(freshClient: AdapterDirectClient, saved: ResourceReference) {
  const volume = await freshClient.volumes.get(saved);
  const info = await volume.inspect();

  if (info.state !== "ready") throw new Error("Volume is not ready");

  return volume;
}
