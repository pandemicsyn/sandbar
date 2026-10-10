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

export async function hello(
  box: Pick<SandboxHandle, "exec">,
  env: Record<string, string>,
  signal: AbortSignal,
) {
  const result = await box.exec(
    {
      command: { kind: "argv", argv: [OPENCODE, "run", "--pure", "What is 2 + 2?"] },
      cwd: WORKDIR,
      env,
      deadlineSeconds: 180,
      maxOutputBytes: 65_536,
    },
    { signal },
  );

  printOutput(result);

  return result;
}

async function main() {
  const setup = providerSetup();
  const env = agentEnvironment();
  const client = await Sandbar.connect(setup.adapter);
  const run = cancellation();
  let box: SandboxHandle | undefined;
  let failed = false;

  try {
    box = await client.sandboxes.create(setup.create, { signal: run.signal });
    console.error(`Created sandbox ${box.id}`);
    await installOpenCode(box, run.signal);
    await hello(box, env, run.signal);
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
