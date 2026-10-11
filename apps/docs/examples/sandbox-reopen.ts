import { type SandbarClient, type SandboxReference, type SandboxInfo } from "sandbar-sdk";

/** Applications store the reference in their own trusted persistence. */
export async function saveSandbox(
  client: SandbarClient,
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
export async function reopenSandbox(freshClient: SandbarClient, saved: SandboxReference) {
  const sandbox = await freshClient.sandboxes.get(saved);
  const info: SandboxInfo = await sandbox.inspect();

  if (info.expires.status === "known") console.log(info.expires.at, info.expires.scope);

  if (info.state !== "running") return { sandbox, info };
  const bytes = await sandbox.readFile("/tmp/work.txt");
  const result = await sandbox.exec(["/bin/sh", "-c", "printf reopened"]);

  return { sandbox, info, bytes, result };
}
