import { type AdapterDirectClient, type SandboxReference, type SandboxInfo } from "sandbar-sdk";

/** Applications store the reference in their own trusted persistence. */
export async function saveSandbox(
  client: AdapterDirectClient,
  template: string,
  save: (reference: SandboxReference) => Promise<void>,
) {
  const sandbox = await client.sandboxes.create({
    environment: { kind: "prepared", value: template },
  });

  const reference = sandbox.reference ?? (await sandbox.inspect()).reference;

  if (!reference) throw new Error("Verified sandbox identity is unavailable");
  await save(reference);

  return sandbox;
}

/** Configure a new connection using the saved provider and original native scope. */
export async function reopenSandbox(freshClient: AdapterDirectClient, saved: SandboxReference) {
  const sandbox = await freshClient.sandboxes.get(saved);
  const info: SandboxInfo = await sandbox.inspect();

  if (info.expires.status === "known") console.log(info.expires.at, info.expires.scope);

  if (info.state !== "running") return { sandbox, info };
  const bytes = await sandbox.readFile("/tmp/work.txt");
  const result = await sandbox.exec(["/bin/sh", "-c", "printf reopened"]);

  return { sandbox, info, bytes, result };
}
