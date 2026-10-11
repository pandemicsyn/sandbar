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
  let failed = false;

  try {
    await client.sandboxes.with(
      setup.create,
      async (box) => {
        console.error(`Created sandbox ${box.id}`);
        await installOpenCode(box, run.signal);
        await hello(box, env, run.signal);
      },
      { signal: run.signal },
    );
  } catch (error) {
    failed = true;
    printFailedOutput(error);
    throw error;
  } finally {
    try {
      await cleanup(client, undefined, failed);
    } finally {
      run.dispose();
    }
  }
}

if (import.meta.main) await main().catch(reportFailure);
