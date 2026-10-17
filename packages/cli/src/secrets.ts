import { execFile } from "node:child_process";
import type { Json } from "@sandbar-sdk/adapter";
import { z } from "zod";
import type { Env } from "./config";
import { CliError } from "./output";

/** A password manager whose CLI can read one secret by reference. */
type SecretBackend = {
  name: string;
  /** Matches the whole reference string. */
  pattern: RegExp;
  command: string;
  args: (reference: string) => string[];
  value: (stdout: string) => string;
  install: string;
  check: string;
};

const BwsSecret = z.object({ value: z.string() });

const backends: SecretBackend[] = [
  {
    // op://vault/item/field or op://vault/item/section/field
    name: "1Password",
    pattern: /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}(\?\S*)?$/,
    command: "op",
    args: (reference) => ["read", "--no-newline", reference],
    value: (stdout) => stdout,
    install: "install the 1Password CLI (https://developer.1password.com/docs/cli) and sign in",
    check: "check `op whoami` and that the vault, item and field exist",
  },
  {
    // bws://<secret-id>, read with BWS_ACCESS_TOKEN
    name: "Bitwarden Secrets Manager",
    pattern: /^bws:\/\/[0-9a-fA-F-]{36}$/,
    command: "bws",
    args: (reference) => ["secret", "get", reference.slice("bws://".length), "--output", "json"],
    value: (stdout) => BwsSecret.parse(JSON.parse(stdout)).value,
    install:
      "install the Bitwarden Secrets Manager CLI (https://bitwarden.com/help/secrets-manager-cli/) and set BWS_ACCESS_TOKEN",
    check: "check BWS_ACCESS_TOKEN and that the machine account can read the secret",
  },
  {
    // pass://path/in/store; the first line of the entry, as `pass -c` would copy
    name: "pass",
    pattern: /^pass:\/\/(?!.*(^|\/)\.\.(\/|$))[\w@+.-]+(\/[\w@+.-]+)*$/,
    command: "pass",
    args: (reference) => ["show", reference.slice("pass://".length)],
    value: (stdout) => stdout.split("\n")[0] ?? "",
    install: "install pass (https://www.passwordstore.org) and initialise your store",
    check: "check that `pass show <path>` works, including the GPG agent",
  },
];

function backendFor(value: string): SecretBackend | undefined {
  return backends.find((backend) => backend.pattern.test(value));
}

type RunResult = { code: number | string; stdout: string; stderr: string };

function run(command: string, args: string[], env: Env, signal: AbortSignal): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { env: { ...env }, signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? "FAILED") : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/**
 * Reads password-manager references (`op://...`, `bws://...`, `pass://...`) through the manager's own CLI
 * when a profile connects, so secrets never need to be written into sandbar.json. The CLI uses
 * its own sign-in. Each reference is read at most once per invocation and never stored.
 */
export class SecretReader {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly env: Env,
    private readonly signal: AbortSignal,
  ) {}

  private read(backend: SecretBackend, reference: string, where: string): Promise<string> {
    let pending = this.cache.get(reference);

    if (!pending) {
      pending = this.fetch(backend, reference, where);
      this.cache.set(reference, pending);
    }

    return pending;
  }

  private async fetch(backend: SecretBackend, reference: string, where: string): Promise<string> {
    const result = await run(backend.command, backend.args(reference), this.env, this.signal);

    if (result.code === "ENOENT")
      throw new CliError(
        "SECRET_TOOL_MISSING",
        `${where} is a ${backend.name} reference, but \`${backend.command}\` is not installed`,
        backend.install,
      );

    // Only the manager's own diagnostics are shown; stdout may hold the secret.
    if (result.code !== 0)
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `Cannot read ${where} from ${backend.name} (${reference}): ${result.stderr.trim() || `${backend.command} exited with ${result.code}`}`,
        backend.check,
      );

    try {
      return backend.value(result.stdout);
    } catch {
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `${backend.name} returned an unreadable answer for ${where} (${reference})`,
        backend.check,
      );
    }
  }

  /** Replace every password-manager reference inside a config or credentials value. */
  async resolve(value: Json, where: string): Promise<Json> {
    const text = z.string().safeParse(value);

    if (text.success) {
      const backend = backendFor(text.data);

      return backend ? this.read(backend, text.data, where) : value;
    }

    if (Array.isArray(value))
      return Promise.all(value.map((item, index) => this.resolve(item, `${where}[${index}]`)));

    const record = z.record(z.string(), z.json()).safeParse(value);

    if (record.success)
      return Object.fromEntries(
        await Promise.all(
          Object.entries(record.data).map(
            async ([key, item]) => [key, await this.resolve(item, `${where}.${key}`)] as const,
          ),
        ),
      );

    return value;
  }
}
