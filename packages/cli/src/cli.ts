import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import {
  catCommand,
  cpCommand,
  createCommand,
  doctorCommand,
  execCommand,
  Flags,
  adoptCommand,
  inspectCommand,
  lsCommand,
  providersCommand,
  rmCommand,
  runCommand,
  shCommand,
} from "./commands";
import {
  commandExitCode,
  describeError,
  managementExitCode,
  Output,
  usage,
  type Streams,
} from "./output";
import { Session, type Context } from "./session";
import { imageCommand } from "./images";
import { skillCommand } from "./skill";
import { complete, completionCommand, formatCompletion } from "./completion";
import type { Env } from "./config";

type FlagSpec = {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  value?: string;
  description: string;
};

type CommandSpec = {
  name: string;
  summary: string;
  usage: string;
  flags: Readonly<Record<string, FlagSpec>>;
  /** Accepts a command after `--`. */
  passthrough: boolean;
  /** exec-style commands pass the remote exit code through and use 125 for CLI failures. */
  remoteExit: boolean;
  examples: readonly string[];
  run: (session: Session, flags: Flags) => Promise<number>;
};

const globalFlags = {
  json: { type: "boolean", description: "Print one JSON document on stdout (also SANDBAR_JSON=1)" },
  profile: {
    type: "string",
    value: "name",
    description: "Profile from sandbar.json (also SANDBAR_PROFILE)",
  },
  provider: {
    type: "string",
    value: "id",
    description: "Official provider from environment credentials (also SANDBAR_PROVIDER)",
  },
  config: {
    type: "string",
    value: "path",
    description: "Config file (default ~/.config/sandbar/sandbar.json, also SANDBAR_CONFIG)",
  },
  "state-dir": {
    type: "string",
    value: "dir",
    description: "State store folder (default ~/.config/sandbar/state, also SANDBAR_STATE_DIR)",
  },
  help: { type: "boolean", short: "h", description: "Show help" },
  version: { type: "boolean", short: "V", description: "Print the CLI version" },
} satisfies Record<string, FlagSpec>;

const createFlags = {
  name: {
    type: "string",
    value: "name",
    description: "Store name (default: generated, like sb-1a2b3)",
  },
  image: {
    type: "string",
    value: "oci-ref",
    description: "OCI image, e.g. python:3.12; default is the profile's image",
  },
  prepared: {
    type: "string",
    value: "id",
    description: "Provider-prepared image id (template, snapshot name)",
  },
  network: {
    type: "string",
    value: "policy",
    description: "blocked or internet; default is the profile's policy",
  },
  label: { type: "string", multiple: true, value: "k=v", description: "Label to set (repeatable)" },
  build: {
    type: "boolean",
    description: "Build --image now if this provider needs a build and none is recorded",
  },
} satisfies Record<string, FlagSpec>;

const execFlags = {
  cwd: { type: "string", value: "dir", description: "Working directory in the sandbox" },
  env: {
    type: "string",
    multiple: true,
    value: "K=V",
    description: "Environment variable (repeatable)",
  },
  stdin: { type: "boolean", description: "Send this process's stdin to the command" },
  "stdin-file": {
    type: "string",
    value: "path",
    description: "Send a local file as the command's stdin",
  },
  timeout: {
    type: "string",
    value: "duration",
    description: "Execution deadline, e.g. 90s or 10m (default 300s)",
  },
  "max-output": { type: "string", value: "size", description: "Captured output limit, e.g. 1m" },
} satisfies Record<string, FlagSpec>;

export const commands: readonly CommandSpec[] = [
  {
    name: "create",
    summary: "Create a sandbox and print its name",
    usage:
      "sandbar create [--name <name>] [--image <oci-ref> | --prepared <id>] [--network <policy>]",
    flags: {
      ...createFlags,
      "if-not-exists": {
        type: "boolean",
        description: "Return the named sandbox if it is still alive instead of failing",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "sandbar create --name web --network internet",
      "sandbar create --name job-42 --if-not-exists --json",
    ],
    run: createCommand,
  },
  {
    name: "ls",
    summary: "List sandboxes in the store with their current state",
    usage: "sandbar ls [--offline | --remote]",
    flags: {
      offline: { type: "boolean", description: "Show stored records without asking providers" },
      remote: {
        type: "boolean",
        description: "List the profile's sandboxes from the provider instead of the store",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar ls", "sandbar ls --json", "sandbar ls --remote --provider daytona"],
    run: lsCommand,
  },
  {
    name: "adopt",
    summary: "Add a sandbox from the provider's listing to the store so other commands reach it",
    usage: "sandbar adopt <id> [--name <name>]",
    flags: {
      name: {
        type: "string",
        value: "name",
        description: "Store name (default: generated, like sb-1a2b3)",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar ls --remote", "sandbar adopt 4f1c2a --name worker"],
    run: adoptCommand,
  },
  {
    name: "inspect",
    summary: "Show a sandbox's state, expiry and reference",
    usage: "sandbar inspect <sandbox>",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar inspect web --json"],
    run: inspectCommand,
  },
  {
    name: "rm",
    summary: "Destroy sandboxes and remove their records",
    usage: "sandbar rm <sandbox>... | --all [--force]",
    flags: {
      all: { type: "boolean", description: "Every sandbox in this store" },
      force: {
        type: "boolean",
        description: "Also destroy sandboxes this CLI did not create, or drop unreachable records",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar rm web", "sandbar rm --all"],
    run: rmCommand,
  },
  {
    name: "exec",
    summary: "Run a command in a sandbox; exits with the command's exit code",
    usage: "sandbar exec <sandbox> [--cwd <dir>] [--env K=V]... [--stdin] -- <command> [args...]",
    flags: execFlags,
    passthrough: true,
    remoteExit: true,
    examples: [
      "sandbar exec web -- ls -la /",
      "sandbar exec web --cwd /work --env CI=1 -- npm test",
    ],
    run: execCommand,
  },
  {
    name: "sh",
    summary: "Run a shell script in a sandbox; exits with its exit code",
    usage: "sandbar sh <sandbox> '<script>' | sandbar sh <sandbox> -- '<script>'",
    flags: execFlags,
    passthrough: true,
    remoteExit: true,
    examples: ["sandbar sh web 'cd /work && make test'", "sandbar sh web -- '-n is fine here'"],
    run: shCommand,
  },
  {
    name: "run",
    summary: "Create a sandbox, run one command, and always destroy it",
    usage: "sandbar run [create flags] [exec flags] [--keep] -- <command> [args...]",
    flags: {
      ...createFlags,
      ...execFlags,
      keep: { type: "boolean", description: "Keep the sandbox and print its name on stderr" },
    },
    passthrough: true,
    remoteExit: true,
    examples: [
      "sandbar run -- python3 -c 'print(2 + 2)'",
      "sandbar run --network internet -- curl -sI https://example.com",
    ],
    run: runCommand,
  },
  {
    name: "image",
    summary: "Build OCI images for providers that need it, and list or forget the builds",
    usage:
      "sandbar image build <oci-ref> [--name <name>] [--refresh] | ls | inspect <name> | forget <name>",
    flags: {
      name: {
        type: "string",
        value: "name",
        description: "Record name for a build (default: from the reference, like python-3-12)",
      },
      refresh: { type: "boolean", description: "Build again even if this reference is recorded" },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "sandbar image build python:3.12 --provider e2b",
      "sandbar create --image python:3.12 --provider e2b",
      "sandbar image ls",
      "sandbar image forget python-3-12",
    ],
    run: imageCommand,
  },
  {
    name: "cp",
    summary: "Copy one file to or from a sandbox",
    usage: "sandbar cp <src> <dst>   (one side is <sandbox>:/path)",
    flags: {
      "no-clobber": {
        type: "boolean",
        description: "Fail instead of overwriting a file in the sandbox",
      },
      recursive: {
        type: "boolean",
        short: "r",
        description: "Copy directories (not available yet)",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar cp ./app.py web:/work/app.py", "sandbar cp web:/work/out.json ./out.json"],
    run: cpCommand,
  },
  {
    name: "cat",
    summary: "Print a file from a sandbox",
    usage: "sandbar cat <sandbox>:/path",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar cat web:/etc/os-release"],
    run: catCommand,
  },
  {
    name: "doctor",
    summary: "Check config, credentials and the provider connection without creating anything",
    usage: "sandbar doctor",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar doctor --provider e2b"],
    run: doctorCommand,
  },
  {
    name: "providers",
    summary:
      "List official providers, whether their adapter is installed and their credentials set",
    usage: "sandbar providers",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar providers --json"],
    run: providersCommand,
  },
  {
    name: "skill",
    summary: "Print the agent skill for this CLI, or install it for your coding agents",
    usage: "sandbar skill [install [--project]]",
    flags: {
      project: {
        type: "boolean",
        description:
          "Install into this folder's .agents/skills (and .claude/skills) instead of your home",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["sandbar skill", "sandbar skill install", "sandbar skill install --project"],
    run: skillCommand,
  },
  {
    name: "completion",
    summary: "Print a shell completion script for zsh, bash or fish",
    usage: "sandbar completion <zsh|bash|fish>",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: [
      "source <(sandbar completion zsh)   # in ~/.zshrc",
      "source <(sandbar completion bash)  # in ~/.bashrc",
      "sandbar completion fish > ~/.config/fish/completions/sandbar.fish",
    ],
    run: completionCommand,
  },
];

export const exitCodes = [
  { code: 0, meaning: "success" },
  { code: 1, meaning: "other failure" },
  { code: 2, meaning: "usage error; fix the command" },
  { code: 3, meaning: "not found" },
  {
    code: 4,
    meaning:
      "unsupported by this provider or profile, adapter missing or broken, password-manager CLI not installed, or store limit reached",
  },
  {
    code: 5,
    meaning: "authentication or permission failure, or an unreadable password-manager secret",
  },
  { code: 6, meaning: "outcome unknown: an effect may have happened, inspect before retrying" },
  { code: 7, meaning: "retryable: rate limit, capacity or unavailable before any effect" },
  { code: 8, meaning: "partial: some steps were confirmed; read error.known" },
  { code: 125, meaning: "exec/run: the CLI or provider failed; details in the error" },
  {
    code: 130,
    meaning:
      "interrupted by SIGINT (129 for SIGHUP, 143 for SIGTERM); an interrupted run still destroys its sandbox",
  },
];

function schema() {
  return {
    version: 1,
    cliVersion: manifest.version,
    globalFlags,
    commands: commands.map(({ run: _run, ...spec }) => spec),
    exitCodes,
    output: {
      json: "With --json, stdout holds exactly one document: {ok:true,data} or {ok:false,error:{code,message,retryable,outcome,hint?,known?,details?}}",
      exec: "exec, sh and run exit with the remote command's exit code; their JSON data is {exitCode,stdout,stderr,truncated}, and run adds sandbox {name,id,kept}",
    },
  };
}

function flagLines(flags: Readonly<Record<string, FlagSpec>>): string[] {
  return Object.entries(flags).map(([name, spec]) => {
    const label = `${spec.short ? `-${spec.short}, ` : ""}--${name}${spec.value ? ` <${spec.value}>` : ""}`;

    return `  ${label.padEnd(26)} ${spec.description}`;
  });
}

function topHelp(): string {
  return [
    "sandbar: create and manage sandboxes on any Sandbar provider",
    "",
    "Usage: sandbar <command> [flags]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(10)} ${command.summary}`),
    "  schema     Print a machine-readable description of every command",
    "",
    "Global flags:",
    ...flagLines(globalFlags),
    "",
    "Quick start:",
    "  export SANDBAR_PROVIDER=e2b E2B_API_KEY=...",
    "  sandbar create --name web",
    "  sandbar exec web -- uname -a",
    "  sandbar rm web",
    "  sandbar run -- python3 -c 'print(2 + 2)'   # create, run, destroy",
    "",
    "Run `sandbar <command> --help` for details, `sandbar schema` for JSON.",
  ].join("\n");
}

function commandHelp(command: CommandSpec): string {
  return [
    command.summary,
    "",
    `Usage: ${command.usage}`,
    ...(Object.keys(command.flags).length ? ["", "Flags:", ...flagLines(command.flags)] : []),
    "",
    "Examples:",
    ...command.examples.map((example) => `  ${example}`),
  ].join("\n");
}

/** One node:util parseArgs option; optional keys stay absent rather than undefined. */
type ParseOption = { type: "string" | "boolean"; multiple?: boolean; short?: string };

function parseOption(spec: FlagSpec): ParseOption {
  const option: ParseOption = { type: spec.type };

  if (spec.multiple) option.multiple = true;

  if (spec.short) option.short = spec.short;

  return option;
}

/** The command is the first argument that is neither a flag nor a global flag's value. */
function commandIndex(head: readonly string[]): number {
  for (let index = 0; index < head.length; index++) {
    const arg = head[index]!;

    if (!arg.startsWith("-")) return index;

    const spec = Object.entries(globalFlags).find(([flag]) => flag === arg.slice(2))?.[1];

    if (spec?.type === "string" && !arg.includes("=")) index++;
  }

  return -1;
}

export type Io = {
  env: Env;
  cwd: string;
  streams: Streams;
  signal: AbortSignal;
  readStdin: () => Promise<Uint8Array>;
};

/** The shell scripts from `sandbar completion` call `sandbar __complete -- <words>`. */
async function completeWords(words: readonly string[], io: Io): Promise<number> {
  const flagValue = (name: string) => {
    const index = words.indexOf(`--${name}`);

    return index === -1 ? undefined : words[index + 1];
  };

  const session = new Session({
    env: io.env,
    cwd: io.cwd,
    out: new Output(false, io.streams),
    signal: io.signal,
    readStdin: io.readStdin,
    flags: { json: false, config: flagValue("config"), stateDir: flagValue("state-dir") },
  });

  try {
    io.streams.stdout(formatCompletion(await complete(words, commands, globalFlags, session)));
  } catch {
    io.streams.stdout(":0\n");
  }

  return 0;
}

/** Run one CLI invocation and return its exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] === "__complete") return completeWords(argv.slice(argv[1] === "--" ? 2 : 1), io);

  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? null : argv.slice(separator + 1);
  const nameIndex = commandIndex(head);
  const name = nameIndex === -1 ? undefined : head[nameIndex];
  const jsonFromEnv = io.env.SANDBAR_JSON === "1" || io.env.SANDBAR_JSON === "true";
  const out = new Output(jsonFromEnv || head.includes("--json"), io.streams);
  const command = commands.find((candidate) => candidate.name === name);

  try {
    if (!name && (head.includes("--version") || head.includes("-V"))) {
      out.success({ version: manifest.version }, manifest.version);

      return 0;
    }

    if (!name) {
      out.streams.stdout(`${topHelp()}\n`);

      return head.includes("--help") || head.includes("-h") ? 0 : 2;
    }

    if (name === "schema") {
      out.streams.stdout(`${JSON.stringify(schema(), null, 2)}\n`);

      return 0;
    }

    if (name === "help") {
      const topic = commands.find((candidate) => candidate.name === head[1]);
      out.streams.stdout(`${topic ? commandHelp(topic) : topHelp()}\n`);

      return 0;
    }

    if (!command) {
      const close = commands.find((candidate) => candidate.name.startsWith(name.slice(0, 2)));

      throw usage(
        `Unknown command ${name}`,
        close ? `did you mean \`sandbar ${close.name}\`?` : "run `sandbar --help`",
      );
    }

    if (rest && !command.passthrough)
      throw usage(`${command.name} does not take a command after --`);
    const options = { ...globalFlags, ...command.flags };
    let parsed: ReturnType<typeof parseArgs>;

    try {
      parsed = parseArgs({
        args: head.filter((_, index) => index !== nameIndex),
        options: Object.fromEntries(
          Object.entries(options).map(([flag, spec]) => [flag, parseOption(spec)]),
        ),
        allowPositionals: true,
        strict: true,
      });
    } catch (cause) {
      const known = Object.keys(options).map((flag) => `--${flag}`);

      throw usage(
        cause instanceof Error ? cause.message.split("\n")[0]! : String(cause),
        `${command.name} accepts: ${known.join(" ")}`,
      );
    }

    const flags = new Flags(parsed.values, parsed.positionals, rest);

    if (flags.bool("help")) {
      out.streams.stdout(`${commandHelp(command)}\n`);

      return 0;
    }

    const context: Context = {
      env: io.env,
      cwd: io.cwd,
      out,
      signal: io.signal,
      readStdin: io.readStdin,
      flags: {
        json: out.json,
        profile: flags.string("profile"),
        provider: flags.string("provider"),
        config: flags.string("config"),
        stateDir: flags.string("state-dir"),
      },
    };

    const session = new Session(context);

    try {
      return await command.run(session, flags);
    } finally {
      await session.close();
    }
  } catch (cause) {
    const report = describeError(cause);
    out.failure(report);

    return command?.remoteExit ? commandExitCode() : managementExitCode(report);
  }
}
