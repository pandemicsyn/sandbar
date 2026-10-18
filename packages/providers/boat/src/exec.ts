import { AdapterError, type Command } from "@sandbar-sdk/adapter";

/**
 * Boat runs one command string and returns UTF-8 text. To keep argv as arguments
 * and output as bytes, the adapter sends a small POSIX sh wrapper: the user's
 * command writes stdout/stderr to private files in the guest, and the wrapper
 * prints only a header line plus base64 of each (bounded) stream. User output
 * is never interpreted as a control record.
 */
export const EXEC_RECORD = "SANDBAR-EXEC-1";

const EnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote one word for POSIX sh; the only special character inside quotes is `'`. */
export function quote(word: string): string {
  if (word.includes("\0"))
    throw new AdapterError("INVALID_ARGUMENT", "Arguments cannot contain NUL");

  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export type WrapperInput = {
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
  /** Guest path holding finite stdin bytes; the wrapper removes it. */
  stdinPath?: string;
  /** Per-stream byte bound applied in the guest before encoding. */
  maxBytes: number;
};

export function wrapperScript(input: WrapperInput): string {
  if (input.command.kind === "argv" && input.command.argv.length === 0)
    throw new AdapterError("INVALID_ARGUMENT", "argv must name a program");

  const env = Object.entries(input.env ?? {}).map(([key, value]) => {
    if (!EnvKey.test(key))
      throw new AdapterError("INVALID_ARGUMENT", "Environment variable names must be POSIX names");

    return quote(`${key}=${value}`);
  });

  const program =
    input.command.kind === "argv"
      ? input.command.argv.map(quote).join(" ")
      : `/bin/sh -c ${quote(input.command.script)}`;

  const run = `exec env -- ${[...env, program].join(" ")}`;
  const body = input.cwd === undefined ? run : `cd -- ${quote(input.cwd)} && ${run}`;
  const stdin = input.stdinPath === undefined ? "/dev/null" : quote(input.stdinPath);
  const bound = Math.max(0, Math.floor(input.maxBytes));

  return [
    "sandbar_d=$(mktemp -d /tmp/sandbar-exec.XXXXXXXX) || exit 97",
    `(${body}) <${stdin} >"$sandbar_d/o" 2>"$sandbar_d/e"`,
    "sandbar_c=$?",
    `printf '${EXEC_RECORD} %s %s %s\\n' "$sandbar_c" "$(($(wc -c <"$sandbar_d/o")))" "$(($(wc -c <"$sandbar_d/e")))"`,
    `head -c ${bound} "$sandbar_d/o" | base64 | tr -d '\\n'; printf '\\n'`,
    `head -c ${bound} "$sandbar_d/e" | base64 | tr -d '\\n'; printf '\\n'`,
    `rm -rf "$sandbar_d"${input.stdinPath === undefined ? "" : ` ${stdin}`}`,
  ].join("\n");
}

export type WrapperResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
};

const RecordPattern = new RegExp(
  `^${EXEC_RECORD} (\\d{1,3}) (\\d{1,15}) (\\d{1,15})\\n([A-Za-z0-9+/]*={0,2})\\n([A-Za-z0-9+/]*={0,2})\\n$`,
);

/** Decode the wrapper record, or null when it is missing or malformed. */
export function parseWrapper(stdout: string): WrapperResult | null {
  const match = RecordPattern.exec(stdout);

  if (!match) return null;
  const [, code, outLength, errLength, out, err] = match;
  const decoded = [out, err].map((value) => Buffer.from(value ?? "", "base64"));
  const [stdoutBytes, stderrBytes] = decoded;

  if (!stdoutBytes || !stderrBytes) return null;
  const lengths = [Number(outLength), Number(errLength)];

  if (
    stdoutBytes.length > (lengths[0] ?? 0) ||
    stderrBytes.length > (lengths[1] ?? 0) ||
    Buffer.from(stdoutBytes).toString("base64") !== out ||
    Buffer.from(stderrBytes).toString("base64") !== err
  )
    return null;

  return {
    exitCode: Number(code),
    stdout: new Uint8Array(stdoutBytes),
    stderr: new Uint8Array(stderrBytes),
    truncated: stdoutBytes.length < (lengths[0] ?? 0) || stderrBytes.length < (lengths[1] ?? 0),
  };
}
