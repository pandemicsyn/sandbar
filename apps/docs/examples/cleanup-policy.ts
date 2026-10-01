import { Sandbar, type DirectConnectOptions, type AdapterSandbox } from "sandbar-sdk";
import { daytona } from "sandbar-sdk/daytona";
import { acme } from "./acme-adapter";

const options: DirectConnectOptions = { cleanup: { storage: "allow-unconfirmed" } };

export function connectDaytona(config: Parameters<typeof daytona>[0]) {
  return Sandbar.connect(daytona(config), options);
}

export function connectExplicit() {
  return Sandbar.connect({
    adapter: acme,
    config: { region: "us" },
    credentials: { token: "example" },
    ...options,
  });
}

export async function cleanup(box: AdapterSandbox) {
  const result = await box.destroy();
  console.log(result.mountDurability, result.retainedResources);
}

export async function strictCleanup(box: AdapterSandbox) {
  return (await box.submitDestroy({ storage: "require-durable" })).wait();
}
