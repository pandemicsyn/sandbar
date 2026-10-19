import { AdapterError, type Command } from "@sandbar-sdk/adapter";

/**
 * Runloop runs one shell string and returns stdout/stderr as text, with an undocumented
 * size limit. To keep argv as arguments and output as bytes, the adapter sends a small
 * POSIX sh wrapper: the user's command writes stdout/stderr to private files in the
 * guest, and the wrapper prints one header line. Small results follow inline as base64;
 * larger ones stay in the guest for a binary download. User output is never read as a
 * control record.
 */
export const EXEC_RECORD = "SANDBAR-EXEC-1";

/** Combined bound for results returned inline instead of downloaded. */
export const INLINE_BYTES = 32 * 1024;

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
  /** Per-stream byte bound applied in the guest. */
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
  const removeStdin = input.stdinPath === undefined ? "" : ` ${stdin}`;
  const bound = Math.max(0, Math.floor(input.maxBytes));

  return [
    "sandbar_d=$(mktemp -d /tmp/sandbar-exec.XXXXXXXX) || exit 97",
    `(${body}) <${stdin} >"$sandbar_d/stdout.raw" 2>"$sandbar_d/stderr.raw"`,
    "sandbar_c=$?",
    `sandbar_ol=$(($(wc -c <"$sandbar_d/stdout.raw"))); sandbar_el=$(($(wc -c <"$sandbar_d/stderr.raw")))`,
    `head -c ${bound} "$sandbar_d/stdout.raw" >"$sandbar_d/stdout"; head -c ${bound} "$sandbar_d/stderr.raw" >"$sandbar_d/stderr"`,
    `rm -f "$sandbar_d/stdout.raw" "$sandbar_d/stderr.raw"${removeStdin}`,
    `if [ $(($(wc -c <"$sandbar_d/stdout") + $(wc -c <"$sandbar_d/stderr"))) -le ${INLINE_BYTES} ]; then`,
    `printf '${EXEC_RECORD} inline %s %s %s\\n' "$sandbar_c" "$sandbar_ol" "$sandbar_el"`,
    `base64 <"$sandbar_d/stdout" | tr -d '\\n'; printf '\\n'`,
    `base64 <"$sandbar_d/stderr" | tr -d '\\n'; printf '\\n'`,
    `rm -rf "$sandbar_d"`,
    "else",
    `printf '${EXEC_RECORD} files %s %s %s %s\\n' "$sandbar_c" "$sandbar_ol" "$sandbar_el" "$sandbar_d"`,
    "fi",
  ].join("\n");
}

export type WrapperResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
};

/** Output left in the guest: download `${directory}/stdout` and `${directory}/stderr`, then remove it. */
export type WrapperFiles = {
  exitCode: number;
  stdoutLength: number;
  stderrLength: number;
  directory: string;
};

const Inline = new RegExp(
  `^${EXEC_RECORD} inline (\\d{1,3}) (\\d{1,15}) (\\d{1,15})\\n([A-Za-z0-9+/]*={0,2})\\n([A-Za-z0-9+/]*={0,2})\\n$`,
);

const Files = new RegExp(
  `^${EXEC_RECORD} files (\\d{1,3}) (\\d{1,15}) (\\d{1,15}) (/tmp/sandbar-exec\\.[A-Za-z0-9]{8})\\n$`,
);

/** Decode the wrapper record, or null when it is missing or malformed. */
export function parseWrapper(stdout: string): WrapperResult | WrapperFiles | null {
  const files = Files.exec(stdout);

  if (files) {
    const [, code, outLength, errLength, directory = ""] = files;

    return {
      exitCode: Number(code),
      stdoutLength: Number(outLength),
      stderrLength: Number(errLength),
      directory,
    };
  }

  const match = Inline.exec(stdout);

  if (!match) return null;
  const [, code, outLength, errLength, out = "", err = ""] = match;
  const stdoutBytes = Buffer.from(out, "base64");
  const stderrBytes = Buffer.from(err, "base64");
  const lengths = [Number(outLength), Number(errLength)] as const;

  if (
    stdoutBytes.length > lengths[0] ||
    stderrBytes.length > lengths[1] ||
    stdoutBytes.toString("base64") !== out ||
    stderrBytes.toString("base64") !== err
  )
    return null;

  return {
    exitCode: Number(code),
    stdout: new Uint8Array(stdoutBytes),
    stderr: new Uint8Array(stderrBytes),
    truncated: stdoutBytes.length < lengths[0] || stderrBytes.length < lengths[1],
  };
}

/** Assemble a downloaded result, or null when a stream is longer than the guest reported. */
export function filesResult(
  files: WrapperFiles,
  stdout: Uint8Array,
  stderr: Uint8Array,
  maxBytes: number,
): WrapperResult | null {
  const expected = (length: number) => Math.min(length, Math.max(0, Math.floor(maxBytes)));

  if (
    stdout.byteLength !== expected(files.stdoutLength) ||
    stderr.byteLength !== expected(files.stderrLength)
  )
    return null;

  return {
    exitCode: files.exitCode,
    stdout,
    stderr,
    truncated: stdout.byteLength < files.stdoutLength || stderr.byteLength < files.stderrLength,
  };
}
