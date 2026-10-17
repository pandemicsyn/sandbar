import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  Image,
  NonzeroExitError,
  ResourceReference,
  SandbarError,
  type CreateInput,
  type ExecInput,
  type ExecOutput,
  type SandbarClient,
  type SandboxHandle,
} from "sandbar-sdk";
import { z } from "zod";
import { CliError, describeError, usage } from "./output";
import { missingEnv, providers, resolveAdapterModule, type ResolvedProfile } from "./providers";
import type { Session } from "./session";
import {
  checkName,
  generatedName,
  listAll,
  RecordName,
  type SandboxRecord,
  type StateStore,
  type Versioned,
} from "./store";
import { parseDuration, parsePairs, parseSize } from "./units";

/** Parsed command-line values for one command. */
export class Flags {
  constructor(
    private readonly values: Readonly<
      Record<string, string | boolean | (string | boolean)[] | undefined>
    >,
    readonly positionals: readonly string[],
    /** Everything after `--`. */
    readonly rest: readonly string[] | null,
  ) {}

  string(name: string): string | undefined {
    return z.string().optional().parse(this.values[name]);
  }

  strings(name: string): string[] {
    return z.array(z.string()).optional().parse(this.values[name]) ?? [];
  }

  bool(name: string): boolean {
    return z.boolean().optional().parse(this.values[name]) ?? false;
  }
}

type CreateRequest = {
  name?: string;
  ifNotExists: boolean;
  image?: string;
  prepared?: string;
  network?: string;
  labels: Record<string, string>;
};

function createRequest(flags: Flags): CreateRequest {
  if (flags.string("image") && flags.string("prepared"))
    throw usage("Pass either --image or --prepared, not both");

  if (flags.bool("build"))
    throw usage(
      "--build is not available yet",
      "build images in a later CLI release; for now use a prepared image or a provider that boots OCI images directly",
    );

  return {
    name: flags.string("name"),
    ifNotExists: flags.bool("if-not-exists"),
    image: flags.string("image"),
    prepared: flags.string("prepared"),
    network: flags.string("network"),
    labels: parsePairs(flags.strings("label"), "label"),
  };
}

function createInput(request: CreateRequest): CreateInput {
  return {
    environment: request.image
      ? Image.oci(request.image)
      : request.prepared
        ? Image.prepared(request.prepared)
        : undefined,
    network: request.network,
    labels: Object.keys(request.labels).length ? request.labels : undefined,
  };
}

type Created = {
  client: SandbarClient<true>;
  box: SandboxHandle<true>;
  record: SandboxRecord;
  version: string;
  existing: boolean;
};

async function claimName(
  store: StateStore,
  record: Omit<SandboxRecord, "name">,
  requested?: string,
): Promise<Versioned> {
  for (let attempt = 0; ; attempt++) {
    const name = requested ? checkName(requested) : generatedName();
    const full = { ...record, name };

    try {
      const { version } = await store.create("sandbox", name, full);

      return { record: full, version };
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT" || attempt >= 8) throw cause;

      if (requested)
        throw new CliError(
          "CONFLICT",
          cause.message,
          "pass --if-not-exists to reuse it, or choose another --name",
        );
    }
  }
}

async function liveCount(store: StateStore): Promise<number> {
  return (await listAll(store, "sandbox")).length;
}

/** Shared by create and run: claim the name, create, then record the reference. */
async function createSandbox(session: Session, request: CreateRequest): Promise<Created> {
  const store = await session.store();
  const profile = await session.profile();

  if (request.name && request.ifNotExists) {
    const current = await store.get("sandbox", checkName(request.name));

    if (current?.record.status === "created" && current.record.reference) {
      const client = await session.connect(await session.profileNamed(current.record.profile));

      try {
        const box = await session.reopen(current.record, client);

        return { client, box, ...current, existing: true };
      } catch (cause) {
        if (!(cause instanceof SandbarError) || cause.code !== "NOT_FOUND") throw cause;
        await store.remove("sandbox", current.record.name, current.version);
      }
    }
  }

  const limit = await session.limit();

  if (limit !== null && (await liveCount(store)) >= limit)
    throw new CliError(
      "LIMIT_REACHED",
      `The store already holds ${limit} sandboxes (limits.maxSandboxes)`,
      "remove some with `sandbar rm`, or raise limits.maxSandboxes in sandbar.json",
    );

  const claimed = await claimName(
    store,
    {
      format: 1,
      kind: "sandbox",
      status: "creating",
      profile: profile.name,
      provider: profile.provider,
      createdAt: new Date().toISOString(),
      labels: request.labels,
      image: request.image ?? request.prepared,
      reference: null,
    },
    request.name,
  );

  let client: SandbarClient<true>;
  const input = createInput(request);

  try {
    client = await session.connect(profile);

    if (input.environment) {
      const plan = await client.sandboxes.checkCreate(input);

      if (plan.status === "unsupported" || plan.status === "unavailable")
        throw new CliError(
          "UNSUPPORTED",
          `${profile.provider} cannot create this sandbox: ${plan.reason}`,
          request.image
            ? "this provider may need the image built first (sandbar image build arrives in a later release), or use --prepared with a provider image"
            : undefined,
        );
    }
  } catch (cause) {
    await store.remove("sandbox", claimed.record.name, claimed.version);
    throw cause;
  }

  let box: SandboxHandle<true>;

  try {
    box = await client.sandboxes.create(input, { signal: session.ctx.signal });
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected") {
      await store.remove("sandbox", claimed.record.name, claimed.version);
      throw cause;
    }

    await store.update(
      "sandbox",
      claimed.record.name,
      { ...claimed.record, status: "unknown", reference: report.known?.reference ?? null },
      claimed.version,
    );

    throw new CliError(
      report.code === "PARTIAL" ? "PARTIAL" : "OUTCOME_UNKNOWN",
      report.message,
      `the store keeps ${claimed.record.name} so it can be inspected or removed`,
      {
        sandbox: claimed.record.name,
        reference: report.known?.reference ?? null,
      },
    );
  }

  const record: SandboxRecord = { ...claimed.record, status: "created", reference: box.reference };
  const { version } = await store.update("sandbox", record.name, record, claimed.version);

  if (!box.reference)
    session.ctx.out.note(
      `warning: ${profile.provider} returned no reopenable reference; later commands cannot reach ${record.name}`,
    );

  return { client, box, record, version, existing: false };
}

function sandboxSummary(record: SandboxRecord) {
  return {
    name: record.name,
    id: record.reference?.nativeId ?? null,
    provider: record.provider,
    profile: record.profile,
    status: record.status,
    createdAt: record.createdAt,
    labels: record.labels,
    image: record.image ?? null,
  };
}

/** A store name, a native id held in the store, or `@file.json` with a saved reference. */
async function findTarget(session: Session, target: string): Promise<Versioned> {
  const store = await session.store();

  if (target.startsWith("@")) {
    const path = resolve(session.ctx.cwd, target.slice(1));
    const parsed = ResourceReference.safeParse(JSON.parse(await readFile(path, "utf8")));

    if (!parsed.success || parsed.data.kind !== "sandbox")
      throw usage(`${path} does not hold a sandbox reference`);
    const profile = await session.profile();

    return {
      record: {
        format: 1,
        kind: "sandbox",
        name: "from-file",
        status: "created",
        profile: profile.name,
        provider: parsed.data.provider,
        createdAt: new Date().toISOString(),
        labels: {},
        reference: { ...parsed.data, kind: "sandbox" },
      },
      version: "",
    };
  }

  if (RecordName.safeParse(target).success) {
    const entry = await store.get("sandbox", target);

    if (entry) return entry;
  }

  const byId = (await listAll(store, "sandbox")).find(
    (entry) => entry.record.reference?.nativeId === target,
  );

  if (byId) return byId;

  throw new CliError(
    "NOT_FOUND",
    `No sandbox named ${target} in the store`,
    "list known sandboxes with `sandbar ls`",
  );
}

export async function createCommand(session: Session, flags: Flags): Promise<number> {
  const created = await createSandbox(session, createRequest(flags));

  session.ctx.out.success(
    {
      ...sandboxSummary(created.record),
      existing: created.existing,
      reference: created.record.reference,
    },
    created.record.name,
  );

  return 0;
}

async function stateOf(
  session: Session,
  record: SandboxRecord,
  client: SandbarClient<true> | null,
) {
  if (!record.reference || !client)
    return record.status === "created" ? "unreachable" : record.status;

  try {
    const box = await session.reopen(record, client);

    return (await box.inspect({ signal: session.ctx.signal })).state;
  } catch (cause) {
    if (cause instanceof SandbarError && cause.code === "NOT_FOUND") return "gone";

    if (cause instanceof SandbarError && cause.code === "UNSUPPORTED") return "unknown";

    return "unreachable";
  }
}

export async function lsCommand(session: Session, flags: Flags): Promise<number> {
  const entries = await listAll(await session.store(), "sandbox");
  const offline = flags.bool("offline");
  const clients = new Map<string, SandbarClient<true> | null>();

  if (!offline)
    for (const profile of new Set(entries.map((entry) => entry.record.profile))) {
      try {
        clients.set(profile, await session.connect(await session.profileNamed(profile)));
      } catch {
        clients.set(profile, null);
      }
    }

  const rows = await Promise.all(
    entries.map(async ({ record }) => ({
      ...sandboxSummary(record),
      state: offline ? null : await stateOf(session, record, clients.get(record.profile) ?? null),
    })),
  );

  const table = [
    ["NAME", "STATE", "PROVIDER", "PROFILE", "ID", "CREATED"],
    ...rows.map((row) => [
      row.name,
      row.state ?? row.status,
      row.provider,
      row.profile,
      row.id ?? "-",
      row.createdAt,
    ]),
  ];

  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));

  session.ctx.out.success(
    { sandboxes: rows },
    rows.length
      ? table
          .map((row) =>
            row
              .map((cell, column) => cell.padEnd(widths[column]!))
              .join("  ")
              .trimEnd(),
          )
          .join("\n")
      : "",
  );

  return 0;
}

function onePositional(flags: Flags, what: string): string {
  if (flags.positionals.length !== 1) throw usage(`Expected exactly one ${what}`);

  return flags.positionals[0]!;
}

export async function inspectCommand(session: Session, flags: Flags): Promise<number> {
  const { record } = await findTarget(session, onePositional(flags, "sandbox"));
  const box = await session.reopen(record);
  const info = await box.inspect({ signal: session.ctx.signal });

  const lines = [
    `name      ${record.name}`,
    `id        ${box.id}`,
    `provider  ${record.provider} (profile ${record.profile})`,
    `state     ${info.state}${info.nativeState ? ` (${info.nativeState})` : ""}`,
    `expires   ${info.expires.status === "known" ? `${info.expires.at} (${info.expires.action})` : info.expires.status}`,
    `observed  ${info.observedAt}`,
  ];

  session.ctx.out.success(
    { ...sandboxSummary(record), info, reference: record.reference },
    lines.join("\n"),
  );

  return 0;
}

export async function rmCommand(session: Session, flags: Flags): Promise<number> {
  const store = await session.store();
  const all = flags.bool("all");
  const force = flags.bool("force");

  if (all === Boolean(flags.positionals.length))
    throw usage("Name sandboxes to remove, or pass --all");

  const targets = all
    ? await listAll(store, "sandbox")
    : await Promise.all(flags.positionals.map((target) => findTarget(session, target)));

  const removed: {
    name: string;
    result: "destroyed" | "gone" | "forgotten";
    retainedResources: string[];
  }[] = [];

  for (const { record, version } of targets) {
    if (!record.reference) {
      if (!force)
        throw new CliError(
          "UNSUPPORTED",
          `${record.name} has no reopenable reference (status ${record.status}); it cannot be destroyed from here`,
          "check the provider for it, then `sandbar rm --force` to drop the record",
          { sandbox: record.name },
        );
      await store.remove("sandbox", record.name, version);
      removed.push({ name: record.name, result: "forgotten", retainedResources: [] });
      continue;
    }

    if (record.reference.ownership !== "verified-created" && !force)
      throw new CliError(
        "FORBIDDEN",
        `${record.name} was not created by this CLI (ownership ${record.reference.ownership})`,
        "pass --force to destroy it anyway",
        { sandbox: record.name },
      );

    let box: SandboxHandle<true>;

    try {
      box = await session.reopen(record);
    } catch (cause) {
      if (!(cause instanceof SandbarError) || cause.code !== "NOT_FOUND") throw cause;

      if (record.name !== "from-file") await store.remove("sandbox", record.name, version);
      removed.push({ name: record.name, result: "gone", retainedResources: [] });
      session.ctx.out.note(`${record.name}: already gone`);
      continue;
    }

    const destroyed = await box.destroy({ signal: session.ctx.signal });

    if (record.name !== "from-file") await store.remove("sandbox", record.name, version);
    removed.push({
      name: record.name,
      result: "destroyed",
      retainedResources: destroyed.retainedResources,
    });

    if (destroyed.retainedResources.length)
      session.ctx.out.note(`${record.name}: retained ${destroyed.retainedResources.join(", ")}`);
  }

  session.ctx.out.success({ removed }, removed.map((entry) => entry.name).join("\n"));

  return 0;
}

async function execInput(
  session: Session,
  flags: Flags,
  command: ExecInput["command"],
): Promise<ExecInput> {
  if (flags.bool("stdin") && flags.string("stdin-file"))
    throw usage("Pass either --stdin or --stdin-file");
  const stdinFile = flags.string("stdin-file");

  const stdin = flags.bool("stdin")
    ? await session.ctx.readStdin()
    : stdinFile
      ? new Uint8Array(await readFile(resolve(session.ctx.cwd, stdinFile)))
      : undefined;

  const timeout = flags.string("timeout");
  const maxOutput = flags.string("max-output");
  const env = parsePairs(flags.strings("env"), "env");

  return {
    command,
    cwd: flags.string("cwd"),
    env: Object.keys(env).length ? env : undefined,
    stdin,
    deadlineSeconds: timeout ? parseDuration(timeout, "timeout") : undefined,
    maxOutputBytes: maxOutput ? parseSize(maxOutput, "max-output") : undefined,
  };
}

function argvCommand(flags: Flags): ExecInput["command"] {
  if (!flags.rest?.length)
    throw usage("Give the command after --, e.g. sandbar exec web -- ls -la");

  return { kind: "argv", argv: [...flags.rest] };
}

async function runExec(
  session: Session,
  box: SandboxHandle<true>,
  input: ExecInput,
): Promise<number> {
  let result: ExecOutput;

  try {
    result = await box.exec(input, { signal: session.ctx.signal });
  } catch (cause) {
    if (!(cause instanceof NonzeroExitError)) throw cause;
    result = cause.result;
  }

  const { out } = session.ctx;

  if (result.exitCode === null)
    throw new CliError(
      "OUTCOME_UNKNOWN",
      "The command ran but the provider reported no exit status",
    );

  if (out.json)
    out.success(
      {
        exitCode: result.exitCode,
        stdout: result.stdoutText({ full: true }),
        stderr: result.stderrText({ full: true }),
        truncated: result.truncated,
      },
      "",
    );
  else {
    if (result.stdout.byteLength) out.streams.stdout(result.stdout);

    if (result.stderr.byteLength) out.streams.stderr(result.stderr);

    if (result.truncated)
      out.note("sandbar: output was truncated; raise --max-output to capture more");
  }

  return result.exitCode;
}

export async function execCommand(session: Session, flags: Flags): Promise<number> {
  const { record } = await findTarget(session, onePositional(flags, "sandbox"));
  const input = await execInput(session, flags, argvCommand(flags));

  return runExec(session, await session.reopen(record), input);
}

export async function shCommand(session: Session, flags: Flags): Promise<number> {
  if (flags.positionals.length !== 2 || flags.rest)
    throw usage("Usage: sandbar sh <sandbox> '<script>'");
  const { record } = await findTarget(session, flags.positionals[0]!);
  const input = await execInput(session, flags, { kind: "shell", script: flags.positionals[1]! });

  return runExec(session, await session.reopen(record), input);
}

export async function runCommand(session: Session, flags: Flags): Promise<number> {
  if (flags.positionals.length)
    throw usage("run takes no positional arguments; put the command after --");
  const command = argvCommand(flags);
  const request = createRequest(flags);
  const input = await execInput(session, flags, command);
  const keep = flags.bool("keep");
  const created = await createSandbox(session, { ...request, ifNotExists: false });
  const store = await session.store();
  let exitCode: number;

  try {
    exitCode = await runExec(session, created.box, input);
  } finally {
    if (keep) session.ctx.out.note(`kept sandbox ${created.record.name}`);
    else {
      // A fresh signal: cleanup must still run after an interrupt aborted the command.
      try {
        await created.box.destroy();
        await store.remove("sandbox", created.record.name, created.version);
      } catch (cause) {
        const report = describeError(cause);

        session.ctx.out.note(
          `sandbar: cleanup of ${created.record.name} failed (${report.code}: ${report.message}); remove it with \`sandbar rm ${created.record.name}\``,
        );

        // oxlint-disable-next-line no-unsafe-finally -- A failed cleanup must replace the command's result.
        throw new CliError(
          "CLEANUP_FAILED",
          `Cleanup of ${created.record.name} failed: ${report.message}`,
          undefined,
          {
            sandbox: created.record.name,
            reference: created.record.reference,
          },
        );
      }
    }
  }

  return exitCode;
}

const RemotePath = /^([a-z0-9][a-z0-9-]{0,62}):(\/.*)$/;

function remote(spec: string): { target: string; path: string } | null {
  const match = RemotePath.exec(spec);

  return match ? { target: match[1]!, path: match[2]! } : null;
}

export async function cpCommand(session: Session, flags: Flags): Promise<number> {
  if (flags.positionals.length !== 2)
    throw usage("Usage: sandbar cp <src> <dst> (one side is <sandbox>:/path)");

  if (flags.bool("recursive"))
    throw usage("Recursive copy is not available yet; copy files one at a time");
  const [source, destination] = [flags.positionals[0]!, flags.positionals[1]!];
  const from = remote(source);
  const to = remote(destination);

  if (Boolean(from) === Boolean(to)) throw usage("Exactly one side of cp must be <sandbox>:/path");

  if (to) {
    const local = resolve(session.ctx.cwd, source);

    if ((await stat(local)).isDirectory())
      throw usage(`${source} is a directory; recursive copy is not available yet`);
    const bytes = new Uint8Array(await readFile(local));
    const { record } = await findTarget(session, to.target);
    const box = await session.reopen(record);
    await box.writeFile(to.path, bytes, {
      overwrite: !flags.bool("no-clobber"),
      signal: session.ctx.signal,
    });
    session.ctx.out.success({ sandbox: record.name, path: to.path, bytes: bytes.byteLength }, "");

    return 0;
  }

  const { record } = await findTarget(session, from!.target);
  const box = await session.reopen(record);
  const bytes = await box.readFile(from!.path, { signal: session.ctx.signal });
  let local = resolve(session.ctx.cwd, destination);

  try {
    if ((await stat(local)).isDirectory()) local = join(local, basename(from!.path));
  } catch {
    // A missing destination is the file to create.
  }

  await writeFile(local, bytes);
  session.ctx.out.success({ sandbox: record.name, path: local, bytes: bytes.byteLength }, "");

  return 0;
}

export async function catCommand(session: Session, flags: Flags): Promise<number> {
  const location = remote(onePositional(flags, "<sandbox>:/path"));

  if (!location) throw usage("Usage: sandbar cat <sandbox>:/path");
  const { record } = await findTarget(session, location.target);
  const box = await session.reopen(record);
  const bytes = await box.readFile(location.path, { signal: session.ctx.signal });
  const { out } = session.ctx;

  if (!out.json) {
    out.streams.stdout(bytes);

    return 0;
  }

  let text: string | null = null;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Binary content is returned as base64.
  }

  out.success(
    text === null
      ? {
          path: location.path,
          bytes: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
        }
      : { path: location.path, bytes: bytes.byteLength, text },
    "",
  );

  return 0;
}

export async function doctorCommand(session: Session): Promise<number> {
  const loaded = await session.config();
  const profile: ResolvedProfile = await session.profile();
  const client = await session.connect(profile);
  const capabilities = await client.capabilities();
  let plan: Awaited<ReturnType<typeof client.sandboxes.checkCreate>>;

  try {
    plan = await client.sandboxes.checkCreate();
  } catch (cause) {
    // A profile without a default image cannot plan an argument-free create.
    plan = { status: "unavailable", reason: describeError(cause).message };
  }

  const store = await session.store();
  const count = (await listAll(store, "sandbox")).length;

  session.ctx.out.success(
    {
      config: { path: loaded.path, exists: loaded.exists },
      profile: profile.name,
      provider: profile.provider,
      connected: true,
      create: plan,
      sandboxesInStore: count,
      capabilities,
    },
    [
      `config    ${loaded.path}${loaded.exists ? "" : " (not found, using defaults)"}`,
      `profile   ${profile.name} (${profile.provider})`,
      "connect   ok",
      `create    ${plan.status}${plan.status === "supported" ? "" : `: ${plan.reason}`}`,
      `store     ${count} sandbox record(s)`,
    ].join("\n"),
  );

  return plan.status === "supported" ? 0 : 4;
}

export async function providersCommand(session: Session): Promise<number> {
  const { env, cwd } = session.ctx;

  const rows = await Promise.all(
    providers.map(async (provider) => {
      const resolved = await resolveAdapterModule(
        {
          name: provider.id,
          provider: provider.id,
          module: provider.module,
          export: provider.export,
          baseDir: cwd,
          config: {},
          credentials: {},
        },
        cwd,
        env,
      );

      let installed = resolved !== provider.module;

      if (!installed)
        try {
          import.meta.resolve(provider.module);
          installed = true;
        } catch {
          installed = false;
        }

      return {
        id: provider.id,
        module: provider.module,
        experimental: provider.experimental,
        installed,
        missingEnv: missingEnv(provider, env),
      };
    }),
  );

  session.ctx.out.success(
    { providers: rows },
    rows
      .map(
        (row) =>
          `${row.id.padEnd(8)} ${row.installed ? "installed" : "not installed"}  ${
            row.missingEnv.length ? `needs ${row.missingEnv.join(", ")}` : "credentials set"
          }${row.experimental ? "  (experimental)" : ""}`,
      )
      .join("\n"),
  );

  return 0;
}
