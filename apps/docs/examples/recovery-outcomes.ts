import {
  Sandbar,
  SandbarError,
  type SandbarClient,
  type SandboxHandle,
  type ResourceReference,
  type SnapshotResult,
  type VolumeHandle,
} from "sandbar-sdk";
import { daytona } from "@sandbar-sdk/daytona";
import { e2b } from "@sandbar-sdk/e2b";

export type SaveReference = (json: string) => Promise<void>;

export function connectDaytona(config: Parameters<typeof daytona>[0]) {
  return Sandbar.connect(daytona(config));
}

/** A verified teamId gives E2B references a stable scope across credential rotation. */
export function connectE2B(config: Parameters<typeof e2b>[0]) {
  return Sandbar.connect(e2b(config));
}

/** Capture and save are separate so a failed application save cannot hide the handle. */
export async function captureSnapshot(box: SandboxHandle) {
  const captured = await box.snapshot();
  console.log(captured.snapshot.provider, captured.snapshot.id);

  return captured;
}

export async function saveSnapshot(captured: SnapshotResult, save: SaveReference) {
  await save(JSON.stringify(captured.snapshot.reference));
}

/** Configure matching provider/scope using current credentials before reopening. */
export async function reopenSnapshot(freshClient: SandbarClient, saved: ResourceReference) {
  const snapshot = await freshClient.snapshots.get(saved);

  return snapshot.restore({ networkPolicy: "blocked" });
}

/** A failed composite call may still contain a usable, confirmed capture. */
export async function captureWithPartialResult(box: SandboxHandle) {
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
export function createVolume(client: SandbarClient) {
  return client.volumes.create({ name: "workspace-data" });
}

export async function saveVolume(volume: VolumeHandle, save: SaveReference) {
  await save(JSON.stringify(volume.reference));
}

export async function reopenVolume(freshClient: SandbarClient, saved: ResourceReference) {
  const volume = await freshClient.volumes.get(saved);
  const info = await volume.inspect();

  if (info.state !== "ready") throw new Error("Volume is not ready");

  return volume;
}
