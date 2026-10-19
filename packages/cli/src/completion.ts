import type { Flags } from "./commands";
import { usage } from "./output";
import { imageActions } from "./images";
import { providers } from "./providers";
import type { Session } from "./session";
import { listAll } from "./store";

/** What completion needs to know about a command; the CLI's command table provides it. */
export type CompletionCommand = {
  name: string;
  summary: string;
  flags: Readonly<Record<string, { type: "string" | "boolean"; description: string }>>;
  passthrough: boolean;
};

/** Bit flags on the last output line, read by the shell scripts below. */
const NoSpace = 1;

const Files = 2;

type Candidate = { value: string; description?: string };

type Completion = { candidates: Candidate[]; directive: number };

const fileFlags = new Set(["config", "state-dir", "stdin-file", "env-file"]);

/** Commands whose positional arguments name sandboxes, and how many. */
const sandboxArguments = new Map([
  ["inspect", 1],
  ["exec", 1],
  ["sh", 1],
  ["rm", Infinity],
]);

/** Sandbox names come from the local store only: pressing tab never calls a provider. */
async function sandboxNames(session: Session): Promise<Candidate[]> {
  const entries = await listAll(await session.store(), "sandbox");

  return entries.map(({ record }) => ({
    value: record.name,
    description: `${record.provider}, ${record.status}`,
  }));
}

async function profileNames(session: Session): Promise<Candidate[]> {
  const loaded = await session.config();

  return Object.keys(loaded.value.profiles ?? {}).map((name) => ({ value: name }));
}

function flagCandidates(
  flags: CompletionCommand["flags"],
  globals: CompletionCommand["flags"],
): Candidate[] {
  return Object.entries({ ...globals, ...flags })
    .filter(([name]) => name !== "help")
    .map(([name, spec]) => ({ value: `--${name}`, description: spec.description }));
}

/**
 * Candidates for the last word of `words` (the word being typed, possibly empty), given the
 * words before it. Errors yield no candidates, so a broken config never breaks the shell.
 */
export async function complete(
  words: readonly string[],
  commands: readonly CompletionCommand[],
  globals: CompletionCommand["flags"],
  session: Session,
): Promise<Completion> {
  const current = words.at(-1) ?? "";
  const before = words.slice(0, -1);
  const none: Completion = { candidates: [], directive: 0 };

  if (before.includes("--")) return { candidates: [], directive: Files };

  let command: CompletionCommand | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < before.length; index++) {
    const word = before[index]!;

    if (word.startsWith("--")) {
      const spec = { ...globals, ...command?.flags }[word.slice(2)];

      if (spec?.type === "string" && !word.includes("=")) index++;
      continue;
    }

    if (!command) command = commands.find((candidate) => candidate.name === word);
    else positionals.push(word);
  }

  const previous = before.at(-1);

  const valueOf = previous?.startsWith("--")
    ? { ...globals, ...command?.flags }[previous.slice(2)]
    : undefined;

  if (previous && valueOf?.type === "string") {
    const flag = previous.slice(2);

    if (fileFlags.has(flag)) return { candidates: [], directive: Files };

    if (flag === "profile") return { candidates: await profileNames(session), directive: 0 };

    if (flag === "provider")
      return {
        candidates: providers.map((provider) => ({ value: provider.id })),
        directive: 0,
      };

    return none;
  }

  if (current.startsWith("-"))
    return { candidates: flagCandidates(command?.flags ?? {}, globals), directive: 0 };

  if (!command)
    return {
      candidates: commands.map((candidate) => ({
        value: candidate.name,
        description: candidate.summary,
      })),
      directive: 0,
    };

  const limit = sandboxArguments.get(command.name);

  if (limit !== undefined)
    return positionals.length < limit
      ? { candidates: await sandboxNames(session), directive: 0 }
      : none;

  if (command.name === "cp" || command.name === "cat") {
    // A remote path is typed by hand after `name:`; offer the names, then local files for cp.
    if (current.includes(":")) return none;

    const remote = (await sandboxNames(session)).map((entry) => ({
      ...entry,
      value: `${entry.value}:`,
    }));

    return { candidates: remote, directive: NoSpace | (command.name === "cp" ? Files : 0) };
  }

  if (command.name === "skill" && positionals.length === 0)
    return {
      candidates: [{ value: "install", description: "Install the skill for your agents" }],
      directive: 0,
    };

  if (command.name === "image") {
    if (positionals.length === 0)
      return { candidates: imageActions.map((action) => ({ value: action })), directive: 0 };

    if (positionals.length === 1 && ["inspect", "forget", "rm"].includes(positionals[0]!)) {
      const entries = await listAll(await session.store(), "image");

      return {
        candidates: entries.map(({ record }) => ({
          value: record.name,
          description: `${record.source} on ${record.profile}`,
        })),
        directive: 0,
      };
    }

    return none;
  }

  if (command.name === "completion" && positionals.length === 0)
    return { candidates: shells.map((shell) => ({ value: shell })), directive: 0 };

  return none;
}

export function formatCompletion(completion: Completion): string {
  const lines = completion.candidates.map((candidate) =>
    candidate.description
      ? `${candidate.value}\t${candidate.description.replaceAll(/\s+/g, " ")}`
      : candidate.value,
  );

  return `${[...lines, `:${completion.directive}`].join("\n")}\n`;
}

const zsh = `#compdef sandbar
# sandbar completion for zsh. Enable with: source <(sandbar completion zsh)

_sandbar() {
  local -a lines described plain
  local line value description directive
  lines=("\${(@f)$(command sandbar __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  directive=\${lines[-1]#:}
  lines=("\${(@)lines[1,-2]}")

  for line in "\${lines[@]}"; do
    [[ -z $line ]] && continue
    value=\${line%%$'\\t'*}
    if [[ $line == *$'\\t'* ]]; then
      description=\${line#*$'\\t'}
      described+=("\${value//:/\\\\:}:$description")
    else
      plain+=("$value")
    fi
  done

  local -a suffix
  (( directive & 1 )) && suffix=(-S '')
  (( \${#described} )) && _describe -t sandbar sandbar described "\${suffix[@]}"
  (( \${#plain} )) && compadd "\${suffix[@]}" -a plain
  (( directive & 2 )) && _files
  return 0
}

if [[ $zsh_eval_context[-1] == loadautofunc ]]; then
  _sandbar "$@"
else
  compdef _sandbar sandbar
fi
`;

const bash = `# sandbar completion for bash. Enable with: source <(sandbar completion bash)

_sandbar() {
  local line current output directive
  local -a words candidates
  # Split the line ourselves so "name:/path" stays one word whatever COMP_WORDBREAKS says.
  line=\${COMP_LINE:0:COMP_POINT}
  read -ra words <<< "$line"
  [[ $line == *" " ]] && words+=("")
  current=\${words[-1]}
  output=$(command sandbar __complete -- "\${words[@]:1}" 2>/dev/null) || return 0
  directive=\${output##*:}
  output=\${output%:*}

  while IFS= read -r candidate; do
    [[ -z $candidate ]] && continue
    candidate=\${candidate%%$'\\t'*}
    [[ $candidate == "$current"* ]] && candidates+=("$candidate")
  done <<< "$output"

  if (( directive & 2 )); then
    local file
    while IFS= read -r file; do candidates+=("$file"); done < <(compgen -f -- "$current")
  fi

  # bash replaces only the text after the last ':' when ':' is a word break.
  if [[ $current == *:* && $COMP_WORDBREAKS == *:* ]]; then
    local prefix=\${current%:*}:
    candidates=("\${candidates[@]#"$prefix"}")
  fi

  COMPREPLY=("\${candidates[@]}")
  (( directive & 1 )) && compopt -o nospace 2>/dev/null
  return 0
}

complete -F _sandbar sandbar
`;

const fish = `# sandbar completion for fish. Enable with: sandbar completion fish | source

function __sandbar_complete
    set -l words (commandline -opc)[2..-1] (commandline -ct)
    set -l output (command sandbar __complete -- $words 2>/dev/null)
    set -l directive (string replace ':' '' -- $output[-1])
    string join \\n -- $output[1..-2]
    if test (math "bitand($directive, 2)") -ne 0
        __fish_complete_path (commandline -ct)
    end
end

complete -c sandbar -f -a '(__sandbar_complete)'
`;

const scripts = { zsh, bash, fish };

const shells = Object.keys(scripts);

export async function completionCommand(session: Session, flags: Flags): Promise<number> {
  const shell = flags.positionals[0];
  const script = Object.entries(scripts).find(([name]) => name === shell)?.[1];

  if (flags.positionals.length !== 1 || !script)
    throw usage(
      `Usage: sandbar completion <${shells.join("|")}>`,
      "e.g. source <(sandbar completion zsh)",
    );

  session.ctx.out.streams.stdout(script);

  return 0;
}
