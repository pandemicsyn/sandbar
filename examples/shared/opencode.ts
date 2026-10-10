import {
  NonzeroExitError,
  NoExitCodeError,
  type ExecOutput,
  type SandboxHandle,
} from "sandbar-sdk";

export const WORKDIR = "/tmp/sandbar-agent-example";

export const OPENCODE_VERSION = "1.18.35";

const INSTALL = `${WORKDIR}/opencode`;

export const OPENCODE = `${INSTALL}/node_modules/.bin/opencode`;

interface AgentEnvironment {
  OPENCODE_CONFIG_CONTENT: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
  XDG_CACHE_HOME: string;
  XDG_STATE_HOME: string;
  NO_COLOR: string;
  [key: string]: string;
}

export function agentEnvironment(): AgentEnvironment {
  const model = process.env.OPENCODE_MODEL?.trim() || "opencode/nemotron-3.5-lightning-free";

  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/.test(model)) {
    throw new Error("OPENCODE_MODEL must be provider/model-id");
  }

  const env: AgentEnvironment = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model,
      permission: "allow",
      share: "disabled",
      autoupdate: false,
    }),
    XDG_CONFIG_HOME: `${WORKDIR}/config`,
    XDG_DATA_HOME: `${WORKDIR}/data`,
    XDG_CACHE_HOME: `${WORKDIR}/cache`,
    XDG_STATE_HOME: `${WORKDIR}/state`,
    NO_COLOR: "1",
  };

  const keyName = process.env.OPENCODE_API_KEY_ENV?.trim();

  if (keyName) {
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(keyName) || /^(DAYTONA|E2B)_/.test(keyName)) {
      throw new Error("OPENCODE_API_KEY_ENV must name a model API key, never a sandbox credential");
    }

    const key = process.env[keyName]?.trim();

    if (!key) throw new Error(`Set the selected model credential ${keyName}`);
    env[keyName] = key;
  }

  return env;
}

export async function installOpenCode(
  box: Pick<SandboxHandle, "makeDirectory" | "exec">,
  signal: AbortSignal,
) {
  await box.makeDirectory(WORKDIR, { signal });

  const result = await box.exec(
    {
      command: {
        kind: "argv",
        argv: [
          "npm",
          "install",
          "--prefix",
          INSTALL,
          "--no-audit",
          "--no-fund",
          "--save-exact",
          `opencode-ai@${OPENCODE_VERSION}`,
        ],
      },
      cwd: WORKDIR,
      deadlineSeconds: 120,
      maxOutputBytes: 16_384,
    },
    { signal },
  );

  if (result.truncated) throw new Error("OpenCode installation output exceeded its bound");
}

export function printOutput(result: ExecOutput) {
  if (result.stdout.length) process.stdout.write(result.stdoutText({ full: true }));

  if (result.stderr.length) process.stderr.write(result.stderrText({ full: true }));

  if (result.truncated)
    throw new Error("Agent output exceeded its bound; captured output is incomplete");
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught JavaScript exception may be any value; narrow SDK process errors before reading their captured output.
export function printFailedOutput(error: unknown) {
  if (error instanceof NonzeroExitError || error instanceof NoExitCodeError) {
    if (error.result.stdout.length) process.stdout.write(error.result.stdoutText({ full: true }));

    if (error.result.stderr.length) process.stderr.write(error.result.stderrText({ full: true }));
  }
}
