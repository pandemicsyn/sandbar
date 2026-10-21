import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import manifest from "../package.json" with { type: "json" };
import type { Flags } from "./commands";
import type { Env } from "./config";
import { CliError, usage, type Output } from "./output";
import {
  adaptersDir,
  descriptor,
  entryFor,
  isAdapter,
  PackageName,
  providers,
  type ProviderDescriptor,
} from "./providers";
import type { Session } from "./session";

export const adapterActions = ["add", "ls", "rm"] as const;

/** One adapter named on the command line: an official provider id or a package name. */
type Target = {
  input: string;
  package: string;
  official: ProviderDescriptor | null;
  /** What npm installs: an exact version, a range or a dist-tag; null lets npm pick the latest. */
  version: string | null;
};

const ExactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const VersionSpec = /^[0-9A-Za-z.^~<>=*+-]{1,64}$/;

/** Split `name@version`; a scoped name's own leading `@` is not a version separator. */
function splitVersion(text: string): { name: string; version: string | null } {
  const at = text.indexOf("@", 1);

  return at === -1
    ? { name: text, version: null }
    : { name: text.slice(0, at), version: text.slice(at + 1) };
}

/**
 * Official ids map to `@sandbar-sdk/<id>` at this CLI's version, since adapters are released in
 * lockstep with it. Other adapters receive credentials too, so a bare unknown name is refused rather
 * than sent to npm, where a typo could install someone else's package: third-party adapters are
 * named by their scoped package name or with an explicit `npm:` prefix.
 */
function parseTarget(input: string, versioned: boolean): Target {
  const explicit = input.startsWith("npm:");
  const { name, version } = splitVersion(explicit ? input.slice(4) : input);

  if (version !== null && (!versioned || !VersionSpec.test(version)))
    throw usage(
      versioned
        ? `Invalid version in ${input}`
        : `${input}: adapter rm takes names without versions`,
      versioned
        ? "use an exact version like 1.2.3, a range like ^1.2 or a tag like latest"
        : undefined,
    );

  const official =
    (explicit ? undefined : descriptor(name)) ??
    providers.find((provider) => provider.module === name);

  if (official)
    return { input, package: official.module, official, version: version ?? manifest.version };

  if (!PackageName.test(name)) throw usage(`${input} is not a provider id or a package name`);

  if (!explicit && !name.startsWith("@"))
    throw usage(
      `Unknown provider ${name}`,
      `official providers: ${providers.map((provider) => provider.id).join(", ")}; for another adapter pass its scoped package name (@scope/name) or npm:${name}`,
    );

  return { input, package: name, official: null, version };
}

function npmSpec(target: Target): string {
  return target.version ? `${target.package}@${target.version}` : target.package;
}

const InstalledManifest = z.looseObject({ version: z.string() });

const AdaptersManifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
});

async function readJson(path: string): Promise<z.infer<ReturnType<typeof z.json>> | null> {
  try {
    return z.json().parse(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;

    throw cause;
  }
}

async function installedVersion(dir: string, name: string): Promise<string | null> {
  const parsed = InstalledManifest.safeParse(
    await readJson(join(dir, "node_modules", name, "package.json")),
  );

  return parsed.success ? parsed.data.version : null;
}

async function dependencies(dir: string): Promise<Record<string, string>> {
  const parsed = AdaptersManifest.safeParse(await readJson(join(dir, "package.json")));

  return parsed.success ? (parsed.data.dependencies ?? {}) : {};
}

/** The folder is its own npm project, so installs never touch a project's package.json. */
async function ensureProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "package.json");

  if ((await readJson(path)) !== null) return;

  await writeFile(
    path,
    `${JSON.stringify(
      {
        name: "sandbar-adapters",
        private: true,
        description: "Adapters for the sandbar CLI; manage with `sandbar adapter add` and `rm`.",
      },
      null,
      2,
    )}\n`,
  );
}

/** Run npm in the adapters folder. Its output goes to stderr so stdout stays one document. */
function npm(args: string[], dir: string, env: Env, out: Output, signal: AbortSignal) {
  return new Promise<void>((done, fail) => {
    const child = spawn("npm", args, {
      cwd: dir,
      env: { ...env },
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";

    const forward = (chunk: Buffer) => {
      out.streams.stderr(chunk);
      tail = `${tail}${chunk.toString("utf8")}`.slice(-2000);
    };

    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (cause) => {
      if ("code" in cause && cause.code === "ENOENT")
        fail(
          new CliError(
            "ADAPTER_INSTALLER_MISSING",
            "Cannot run npm, which `sandbar adapter` uses to install adapters",
            "install Node.js with npm (https://nodejs.org), or put npm on PATH",
          ),
        );
      else fail(cause);
    });
    child.on("close", (code) => {
      if (code === 0) return done();

      const last = tail.trim().split("\n").slice(-3).join("; ");

      fail(
        new CliError(
          "ADAPTER_INSTALL_FAILED",
          `npm ${args[0]} failed in ${dir}${last ? `: ${last}` : ""}`,
          "npm's output is above; fix the cause (network, registry, version) and rerun",
        ),
      );
    });
  });
}

const npmFlags = ["--no-audit", "--no-fund"];

/** Import the installed package from the adapters folder and name its adapter exports. */
async function verify(dir: string, target: Target): Promise<string[]> {
  const entry = await entryFor(join(dir, "node_modules", target.package));

  if (!entry)
    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `npm finished but ${target.package} is not in ${join(dir, "node_modules")}`,
    );

  let namespace: object;

  try {
    namespace = await import(pathToFileURL(entry).href);
  } catch (cause) {
    throw new CliError(
      "ADAPTER_LOAD_FAILED",
      `${target.package} is installed but failed to load: ${cause instanceof Error ? cause.message : cause}`,
      `reinstall it with \`sandbar adapter add ${target.input}\`, or remove it with \`sandbar adapter rm ${target.input}\``,
    );
  }

  const found = Object.entries(namespace).flatMap(([name, value]) =>
    isAdapter(value) ? [name] : [],
  );

  const expected = target.official?.export;

  if (expected ? !found.includes(expected) : !found.length)
    throw new CliError(
      "ADAPTER_LOAD_FAILED",
      expected
        ? `${target.package} has no adapter export named ${expected}`
        : `${target.package} exports no Sandbar adapter`,
      `remove it with \`sandbar adapter rm ${target.input}\``,
    );

  return found;
}

type AddResult = {
  package: string;
  provider: string | null;
  version: string;
  previous: string | null;
  result: "installed" | "updated" | "unchanged";
  exports: string[];
};

async function addAdapters(session: Session, inputs: string[]): Promise<number> {
  const { env, out, signal } = session.ctx;

  if (!inputs.length) throw usage("Name the adapters to add, e.g. `sandbar adapter add e2b`");
  const targets = inputs.map((input) => parseTarget(input, true));
  const dir = adaptersDir(env);

  const before = await Promise.all(targets.map((target) => installedVersion(dir, target.package)));

  // An exact version that is already installed needs no npm call, so CI reruns are cheap.
  const pending = targets.filter(
    (target, index) =>
      !(target.version && ExactVersion.test(target.version) && before[index] === target.version),
  );

  if (pending.length) {
    await ensureProject(dir);
    await npm(
      ["install", "--prefix", dir, ...npmFlags, "--save-exact", ...pending.map(npmSpec)],
      dir,
      env,
      out,
      signal,
    );
  }

  const results: AddResult[] = [];

  for (const [index, target] of targets.entries()) {
    const version = await installedVersion(dir, target.package);
    const exports = await verify(dir, target);
    const previous = before[index] ?? null;

    if (target.official && version !== manifest.version)
      out.note(
        `warning: ${target.package}@${version} differs from this CLI (${manifest.version}); official adapters are released with the CLI`,
      );

    results.push({
      package: target.package,
      provider: target.official?.id ?? null,
      version: version ?? "",
      previous,
      result: previous === null ? "installed" : previous === version ? "unchanged" : "updated",
      exports,
    });
  }

  out.success(
    { dir, adapters: results },
    [
      ...results.map(
        (entry) =>
          `${entry.result.padEnd(9)} ${entry.package}@${entry.version}${entry.provider ? ` (${entry.provider})` : ` exports ${entry.exports.join(", ")}`}`,
      ),
      ...(results.some((entry) => !entry.provider)
        ? [
            'use a third-party adapter from a profile in sandbar.json: { "module": "<package>", "export": "<name>" }',
          ]
        : []),
    ].join("\n"),
  );

  return 0;
}

type ListedAdapter = {
  package: string;
  provider: string | null;
  /** The version range recorded in the folder's package.json, if it was installed with npm there. */
  requested: string | null;
  version: string | null;
  status: "ok" | "missing" | "version-mismatch";
};

async function listAdapters(session: Session): Promise<number> {
  const dir = adaptersDir(session.ctx.env);
  const recorded = await dependencies(dir);

  // Official adapters copied in by hand count too; that is where the CLI loads them from.
  const names = [
    ...new Set([
      ...Object.keys(recorded),
      ...(
        await Promise.all(
          providers.map(async (provider) =>
            (await installedVersion(dir, provider.module)) ? [provider.module] : [],
          ),
        )
      ).flat(),
    ]),
  ].sort();

  const rows: ListedAdapter[] = await Promise.all(
    names.map(async (name) => {
      const official = providers.find((provider) => provider.module === name);
      const version = await installedVersion(dir, name);

      return {
        package: name,
        provider: official?.id ?? null,
        requested: recorded[name] ?? null,
        version,
        status:
          version === null
            ? "missing"
            : official && version !== manifest.version
              ? "version-mismatch"
              : "ok",
      };
    }),
  );

  session.ctx.out.success(
    { dir, cliVersion: manifest.version, adapters: rows },
    rows.length
      ? rows
          .map(
            (row) =>
              `${(row.provider ?? "-").padEnd(8)} ${`${row.package}@${row.version ?? row.requested ?? "?"}`.padEnd(36)} ${row.status}`,
          )
          .join("\n")
      : `no adapters in ${dir}; add one with \`sandbar adapter add <provider>\``,
  );

  return 0;
}

async function removeAdapters(session: Session, inputs: string[]): Promise<number> {
  const { env, out, signal } = session.ctx;

  if (!inputs.length) throw usage("Name the adapters to remove, e.g. `sandbar adapter rm e2b`");
  const targets = inputs.map((input) => parseTarget(input, false));
  const dir = adaptersDir(env);
  const recorded = await dependencies(dir);

  const present = await Promise.all(
    targets.map(
      async (target) =>
        target.package in recorded || (await installedVersion(dir, target.package)) !== null,
    ),
  );

  const removing = targets.filter((_, index) => present[index]);

  if (removing.length) {
    await ensureProject(dir);
    await npm(
      ["uninstall", "--prefix", dir, ...npmFlags, ...removing.map((target) => target.package)],
      dir,
      env,
      out,
      signal,
    );
  }

  const results = targets.map((target, index) => ({
    package: target.package,
    provider: target.official?.id ?? null,
    result: present[index] ? "removed" : "absent",
  }));

  out.success(
    { dir, adapters: results },
    results.map((entry) => `${entry.result.padEnd(7)} ${entry.package}`).join("\n"),
  );

  return 0;
}

export async function adapterCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  switch (action) {
    case "add":
      return addAdapters(session, args);
    case "ls":
      if (args.length) throw usage("adapter ls takes no arguments");

      return listAdapters(session);
    case "rm":
      return removeAdapters(session, args);
    default:
      throw usage(
        action ? `Unknown adapter command ${action}` : "Expected an adapter command",
        `use one of: ${adapterActions.join(", ")}`,
      );
  }
}
