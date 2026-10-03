import {
  type AdapterDirectClient,
  type AdapterSnapshot,
  type AdapterVolume,
  type AdapterSandbox,
  type ResourceReference,
} from "sandbar-sdk";

/** Create data explicitly first and keep its handle if compute creation fails. */
export function createWriter(client: AdapterDirectClient, data: AdapterVolume) {
  return client.sandboxes.create({ networkPolicy: "daytona-default", mounts: [data.at("/data")] });
}

/** The caller owns writer before attempting a write. */
export function seedData(writer: AdapterSandbox) {
  return writer.writeTextFile("/data/report.json", '{"total":7}', { overwrite: true });
}

/** Capture a separate mount-free source whose handle is already retained by the caller. */
export async function capturePrivateState(base: AdapterSandbox) {
  await base.writeTextFile("/tmp/app-version.txt", "v1");

  return base.snapshot();
}

/** Save full references in a trusted store. Reopening allocates nothing. */
export async function reopenStorage(
  freshClient: AdapterDirectClient,
  saved: {
    snapshot: ResourceReference;
    data: ResourceReference;
  },
) {
  const snapshot = await freshClient.snapshots.get(saved.snapshot);
  const data = await freshClient.volumes.get(saved.data);

  return { snapshot, data };
}

/** Passing shared data selects current bytes; passing a separately created volume selects empty independent data. */
export function restoreWithData(snapshot: AdapterSnapshot, data: AdapterVolume) {
  return snapshot.restore({ networkPolicy: "daytona-default", mounts: [data.at("/data")] });
}

export function restorePrivateOnly(snapshot: AdapterSnapshot) {
  return snapshot.restore({ networkPolicy: "daytona-default" });
}
