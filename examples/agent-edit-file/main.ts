import { Sandbar, type SandboxHandle } from "sandbar-sdk";
import {
  agentEnvironment,
  installOpenCode,
  OPENCODE,
  printFailedOutput,
  printOutput,
  WORKDIR,
} from "../shared/opencode";
import { cancellation, cleanup, providerSetup, reportFailure } from "../shared/provider";

export async function edit(
  box: Pick<SandboxHandle, "exec" | "writeFile" | "readTextFile">,
  env: Record<string, string>,
  signal: AbortSignal,
  message: Uint8Array,
) {
  const path = `${WORKDIR}/message.txt`;
  await box.writeFile(path, message, { signal, maxBytes: 1024 });

  const result = await box.exec(
    {
      command: {
        kind: "argv",
        argv: [
          OPENCODE,
          "run",
          "--pure",
          "Edit message.txt: replace NAME with Sandbar. Leave the rest of the file unchanged.",
        ],
      },
      cwd: WORKDIR,
      env,
      deadlineSeconds: 180,
      maxOutputBytes: 65_536,
    },
    { signal },
  );

  printOutput(result);
  const changed = await box.readTextFile(path, { signal, maxBytes: 1024 });
  process.stdout.write(changed);

  if (changed !== "Hello, Sandbar!\n")
    throw new Error("Agent did not produce the expected message.txt contents");

  return changed;
}

async function main() {
  const setup = providerSetup();
  const env = agentEnvironment();

  const message = new Uint8Array(
    await Bun.file(new URL("./message.txt", import.meta.url)).arrayBuffer(),
  );

  const client = await Sandbar.connect(setup.adapter);
  const run = cancellation();
  let box: SandboxHandle | undefined;
  let failed = false;

  try {
    box = await client.sandboxes.create(setup.create, { signal: run.signal });
    console.error(`Created sandbox ${box.id}`);
    await installOpenCode(box, run.signal);
    await edit(box, env, run.signal, message);
  } catch (error) {
    failed = true;
    printFailedOutput(error);
    throw error;
  } finally {
    try {
      await cleanup(client, box, failed);
    } finally {
      run.dispose();
    }
  }
}

if (import.meta.main) await main().catch(reportFailure);
