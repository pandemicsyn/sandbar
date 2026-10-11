import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Compile public recovery examples against the already installed packed SDK. */
export async function checkRecoveryTypes(directory, root, run) {
  const direct = await readFile(
    join(directory, "node_modules/sandbar-sdk/dist/adapter-direct.d.ts"),
    "utf8",
  );

  const resources = await readFile(
    join(directory, "node_modules/sandbar-sdk/dist/resources.d.ts"),
    "utf8",
  );

  for (const declaration of [
    "Promise<SandbarClient<true>>",
    "Promise<SandboxHandle<true>>",
    "recover(reference: RecoveryReference)",
    "OperationHandle<SandboxHandle<true>",
  ])
    if (!direct.includes(declaration))
      throw new Error(`Missing canonical SDK declaration: ${declaration}`);

  for (const declaration of [
    "snapshot: SnapshotHandle",
    "Promise<SnapshotHandle>",
    "Promise<VolumeHandle>",
    "Promise<SandboxHandle<true>>",
  ])
    if (!resources.includes(declaration))
      throw new Error(`Missing canonical resource declaration: ${declaration}`);
  await writeFile(
    join(directory, "recovery-outcomes.ts"),
    await readFile(join(root, "apps/docs/examples/recovery-outcomes.ts"), "utf8"),
  );
  await writeFile(
    join(directory, "sandbox-reopen.ts"),
    await readFile(join(root, "apps/docs/examples/sandbox-reopen.ts"), "utf8"),
  );
  await writeFile(
    join(directory, "recovery-types.ts"),
    `
import { Sandbar, type DirectConnectOptions, type AdapterDirectClient, type AdapterRecoveryReference, type SnapshotResult, type AdapterVolume, type ExecOutput } from "sandbar-sdk";
import { daytona } from "sandbar-daytona";
function cleanupConnection() {
  const options: DirectConnectOptions = { cleanup: { storage: "allow-unconfirmed" } };
  const connection = Sandbar.connect(daytona({ apiKey: "example", target: "us" }), options);
  // @ts-expect-error Cleanup accepts only the supported storage policies.
  Sandbar.connect(daytona({ apiKey: "example", target: "us" }), { cleanup: { storage: "flush" } });
  return connection;
}
void cleanupConnection;
async function narrow(client: AdapterDirectClient, reference: AdapterRecoveryReference) {
  const operation = await client.recover(reference);
  if (operation.kind === "snapshot_capture") {
    const result: SnapshotResult = await operation.wait();
    const preserve: "filesystem" | "filesystem+memory" = result.capture.preserve;
    void preserve;
    // @ts-expect-error A snapshot result is not an execution result.
    const execution: ExecOutput = await operation.wait();
    void execution;
  }
  if (operation.kind === "volume_create") {
    const volume: AdapterVolume = await operation.wait();
    await volume.inspect();
  }
  // @ts-expect-error Recovered result types are selected by validated kind, never caller generics.
  await client.recover<ExecOutput>(reference);
}
async function canonical(client: import("sandbar-sdk").SandbarClient<true>, reference: import("sandbar-sdk").RecoveryReference) {
  const legacyClient: import("sandbar-sdk").AdapterDirectClient = client;
  const box = await client.sandboxes.create();
  const legacyBox: import("sandbar-sdk").AdapterSandbox = box;
  const ordinaryBox: import("sandbar-sdk").SandboxHandle = box;
  const reopened: import("sandbar-sdk").SandboxHandle<true> = await client.sandboxes.get(box.reference!);
  const submitted = await client.sandboxes.submitCreate();
  const legacyOperation: import("sandbar-sdk").AdapterOperation<import("sandbar-sdk").AdapterSandbox> = submitted;
  const operation: import("sandbar-sdk").OperationHandle<import("sandbar-sdk").SandboxHandle<true>, typeof submitted.kind> = submitted;
  await operation.continue();
  const prepared = await client.operations.prepare("create", { image: { kind: "prepared", value: "base" }, networkPolicy: "blocked" });
  void prepared.submit;
  const volume: import("sandbar-sdk").VolumeHandle = await client.volumes.create({ name: "fixture" });
  const legacyVolume: import("sandbar-sdk").AdapterVolume = volume;
  const captured = await box.snapshot();
  const snapshot: import("sandbar-sdk").SnapshotHandle = captured.snapshot;
  const legacySnapshot: import("sandbar-sdk").AdapterSnapshot = snapshot;
  const restored: import("sandbar-sdk").SandboxHandle<true> = await snapshot.restore({ networkPolicy: "blocked" });
  const recovered = await client.recover(reference);
  if (recovered.kind === "volume_create") {
    const result: import("sandbar-sdk").VolumeHandle = await recovered.wait();
    await result.inspect();
    // @ts-expect-error Kind narrowing excludes sandbox methods.
    (await recovered.wait()).exec(["true"]);
  }
  void legacyClient; void legacyBox; void ordinaryBox; void reopened; void legacyOperation;
  void legacyVolume; void legacySnapshot; void restored;
}
// Existing applications may implement the minimal operation interface structurally.
function minimal(reference: import("sandbar-sdk").RecoveryReference): import("sandbar-sdk").OperationHandle<number> {
  return { reference, durability: "process", observe: async () => null, wait: async () => 1 };
}
function structural(client: import("sandbar-sdk").DirectSandbarClient, box: import("sandbar-sdk").DirectSandboxHandle) {
  const ordinary: import("sandbar-sdk").SandbarClient = client;
  const sandbox: import("sandbar-sdk").SandboxHandle = box;
  // @ts-expect-error Ordinary annotations omit implementation machinery.
  void ordinary.session;
  void sandbox.listFiles; void sandbox.readDirectory;
}
void canonical; void minimal; void structural;
void narrow;
`,
  );
  await writeFile(
    join(directory, "recovery-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      include: ["recovery-outcomes.ts", "recovery-types.ts", "sandbox-reopen.ts"],
    }),
  );
  run(join(root, "node_modules/.bin/tsc"), ["-p", "recovery-tsconfig.json"], directory);
}
