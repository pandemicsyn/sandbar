import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Compile public recovery examples against the already installed packed SDK. */
export async function checkRecoveryTypes(directory, root, run) {
  await writeFile(
    join(directory, "recovery-outcomes.ts"),
    await readFile(join(root, "apps/docs/examples/recovery-outcomes.ts"), "utf8"),
  );
  await writeFile(
    join(directory, "recovery-types.ts"),
    `
import { Sandbar, type DirectConnectOptions, type AdapterDirectClient, type AdapterRecoveryReference, type SnapshotResult, type AdapterVolume, type ExecOutput } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
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
      include: ["recovery-outcomes.ts", "recovery-types.ts"],
    }),
  );
  run(join(root, "node_modules/.bin/tsc"), ["-p", "recovery-tsconfig.json"], directory);
}
