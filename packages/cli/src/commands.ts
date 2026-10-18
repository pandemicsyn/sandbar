import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  AdapterSandbox,
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
import { searchProjectAdapters, valueAvailable, type Env, type LoadedConfig } from "./config";
import {
  CliError,
  describeError,
  usage,
  type BatchDetails,
  type BatchItem,
  type ExecSummary,
  type Output,
} from "./output";
import { imageEnvironment } from "./images";
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
  /** Build --image now when the provider needs a build and none is recorded. */
  build: boolean;
};

function createRequest(flags: Flags): CreateRequest {
  if (flags.string("image") && flags.string("prepared"))
    throw usage("Pass either --image or --prepared, not both");

  if (flags.bool("build") && !flags.string("image")) throw usage("--build needs --image");

  return {
    build: flags.bool("build"),
    name: flags.string("name"),
    ifNotExists: flags.bool("if-not-exists"),
    image: flags.string("image"),
    prepared: flags.string("prepared"),
    network: flags.string("network"),
    labels: parsePairs(flags.strings("label"), "label"),
  };
}

/** The create input; `--image` is resolved after connecting, because it depends on the provider. */
function createInput(request: CreateRequest): CreateInput {
  return {
    environment: request.prepared ? Image.prepared(request.prepared) : undefined,
    network: request.network,
    labels: Object.keys(request.labels).length ? request.labels : undefined,
  };
}

type Created = {
  client: SandbarClient<true>;
  box: SandboxHandle<true>;
  record: SandboxRecord;
  existing: boolean;
  /** Set when the sandbox exists but its store record could not be written. */
  unrecorded?: Error;
};

async function claimName(
  store: StateStore,
  record: Omit<SandboxRecord, "name">,
  requested?: string,
  ifNotExists = false,
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
          ifNotExists
            ? "its record is not a confirmed sandbox (still creating, or outcome unknown); check `sandbar inspect`, or drop it with `sandbar rm --force`"
            : "pass --if-not-exists to reuse it, or choose another --name",
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
    request.ifNotExists,
  );

  let client: SandbarClient<true>;
  const input = createInput(request);

  try {
    client = await session.connect(profile);

    if (request.image)
      input.environment = await imageEnvironment(
        session,
        client,
        profile,
        request.image,
        request.build,
      );

    if (input.environment) {
      const plan = await client.sandboxes.checkCreate(input);

      if (plan.status === "unsupported" || plan.status === "unavailable")
        throw new CliError(
          "UNSUPPORTED",
          `${profile.provider} cannot create this sandbox: ${plan.reason}`,
          request.image ? "use --prepared with a provider image instead" : undefined,
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

      // Adapters without a default image reject an argument-free create in SDK terms.
      if (report.code === "INVALID_ARGUMENT" && !input.environment)
        throw new CliError(
          "INVALID_ARGUMENT",
          `${profile.provider} needs an image for this sandbox: ${report.message}`,
          "pass --prepared <id> (a provider template or snapshot) or --image <oci-ref>",
        );
      throw cause;
    }

    const reference = report.known?.reference ?? null;
    const recovery = report.known?.recovery;
    let kept = `the store keeps ${claimed.record.name} so it can be inspected or removed`;

    try {
      await store.update(
        "sandbox",
        claimed.record.name,
        { ...claimed.record, status: "unknown", reference, recovery },
        claimed.version,
      );
    } catch (storeCause) {
      kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
    }

    throw new CliError(
      report.outcome === "partial" ? "PARTIAL" : "OUTCOME_UNKNOWN",
      report.message,
      kept,
      { sandbox: claimed.record.name, reference, recovery },
      report.outcome,
    );
  }

  const record: SandboxRecord = { ...claimed.record, status: "created", reference: box.reference };

  if (!box.reference)
    session.ctx.out.note(
      `warning: ${profile.provider} returned no reopenable reference; later commands cannot reach ${record.name}`,
    );

  try {
    await store.update("sandbox", record.name, record, claimed.version);
  } catch (cause) {
    const unrecorded = cause instanceof Error ? cause : new Error(String(cause));

    return { client, box, record, existing: false, unrecorded };
  }

  return { client, box, record, existing: false };
}

/** The sandbox exists but the store does not know it: report it, never hide it. */
function unrecordedError(created: Created): CliError {
  return new CliError(
    "STORE_WRITE_FAILED",
    `Created ${created.record.name} but could not record it in the store: ${created.unrecorded?.message}`,
    "save the reference below to a file and use `sandbar rm @<file>` to destroy it",
    { sandbox: created.record.name, reference: created.record.reference },
    "partial",
  );
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

/** A store entry, or a reference read from `@file.json` that has no store record. */
export type Target = Versioned & { fromFile?: true };

/** A store name, a native id held in the store, or `@file.json` with a saved reference. */
async function findTarget(session: Session, target: string): Promise<Target> {
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
      fromFile: true,
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

  if (created.unrecorded) throw unrecordedError(created);

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
  const entries = await listAll(await session.store(), "sandbox", (warning) =>
    session.ctx.out.note(warning),
  );

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
  const { record } = await recoverCreate(
    session,
    await session.store(),
    await findTarget(session, onePositional(flags, "sandbox")),
  );

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
    {
      ...sandboxSummary(record),
      info: { ...info, reference: undefined },
      reference: record.reference,
    },
    lines.join("\n"),
  );

  return 0;
}

type RemoveResult =
  | { kind: "removed"; item: BatchItem & { retainedResources: string[] } }
  | { kind: "skipped"; item: BatchItem };

/** Why a record may not be destroyed without --force, or null when it may. */
function refusal(record: SandboxRecord): CliError | null {
  if (!record.reference)
    return new CliError(
      "UNSUPPORTED",
      `${record.name} has no reopenable reference (status ${record.status}); it cannot be destroyed from here`,
      "check the provider for it, then `sandbar rm --force` to drop the record",
      { sandbox: record.name },
    );

  if (record.reference.ownership !== "verified-created")
    return new CliError(
      "FORBIDDEN",
      `${record.name} was not created by this CLI (ownership ${record.reference.ownership})`,
      "pass --force to destroy it anyway",
      { sandbox: record.name },
    );

  return null;
}

/** Whether two records describe the same sandbox, so a replacement under the name is left alone. */
function sameSandbox(a: SandboxRecord, b: SandboxRecord): boolean {
  if (a.createdAt !== b.createdAt || a.provider !== b.provider || a.profile !== b.profile)
    return false;

  return !a.reference || !b.reference || a.reference.nativeId === b.reference.nativeId;
}

/**
 * Drop a record after its provider effect is confirmed. A concurrent edit of the same sandbox
 * must not report failure, but a replacement created under the name since must keep its record.
 */
export async function forget(store: StateStore, target: Target): Promise<void> {
  if (target.fromFile) return;

  for (let attempt = 0; ; attempt++) {
    const current = await store.get("sandbox", target.record.name);

    if (!current || !sameSandbox(current.record, target.record)) return;

    try {
      await store.remove("sandbox", target.record.name, current.version);

      return;
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT" || attempt === 2) throw cause;
    }
  }
}

/**
 * An uncertain create saved the SDK's operation reference: observe the original operation
 * (never resubmitting it) and record the sandbox when the provider confirms one.
 */
async function recoverCreate(session: Session, store: StateStore, target: Target): Promise<Target> {
  const { record } = target;

  if (target.fromFile || record.status !== "unknown" || record.reference || !record.recovery)
    return target;

  if (record.recovery.kind !== "create") return target;

  const client = await session.connect(await session.profileNamed(record.profile));
  let value: unknown;

  try {
    value = await (await client.recover(record.recovery)).observe();
  } catch (cause) {
    if (cause instanceof SandbarError && cause.effect !== "none") return target;
    throw cause;
  }

  if (!(value instanceof AdapterSandbox)) return target;

  const { recovery: _recovery, ...rest } = record;
  const recovered: SandboxRecord = { ...rest, status: "created", reference: value.reference };
  const { version } = await store.update("sandbox", record.name, recovered, target.version);
  session.ctx.out.note(`${record.name}: recovered the uncertain create as ${value.id}`);

  return { record: recovered, version };
}

async function removeOne(
  session: Session,
  store: StateStore,
  found: Target,
  force: boolean,
  all: boolean,
): Promise<RemoveResult> {
  // --force must still drop a record whose recovery cannot run (for example a removed profile).
  const target = await recoverCreate(session, store, found).catch((cause: unknown) => {
    if (force) return found;
    throw cause;
  });

  const { record } = target;
  const refused = refusal(record);

  if (refused && !force) {
    // --all only touches what this CLI owns; a named sandbox that cannot be removed is an error.
    if (all)
      return {
        kind: "skipped",
        item: { name: record.name, result: "skipped", reason: refused.message },
      };
    throw refused;
  }

  if (!record.reference) {
    await forget(store, target);

    return {
      kind: "removed",
      item: { name: record.name, result: "forgotten", retainedResources: [] },
    };
  }

  let box: SandboxHandle<true>;

  try {
    box = await session.reopen(record);
  } catch (cause) {
    if (!(cause instanceof SandbarError) || cause.code !== "NOT_FOUND") throw cause;
    await forget(store, target);

    return { kind: "removed", item: { name: record.name, result: "gone", retainedResources: [] } };
  }

  const destroyed = await box.destroy({ signal: session.ctx.signal });
  await forget(store, target);

  return {
    kind: "removed",
    item: {
      name: record.name,
      result: "destroyed",
      retainedResources: destroyed.retainedResources,
    },
  };
}

export async function rmCommand(session: Session, flags: Flags): Promise<number> {
  const store = await session.store();
  const all = flags.bool("all");
  const force = flags.bool("force");
  const { out } = session.ctx;

  if (all === Boolean(flags.positionals.length))
    throw usage("Name sandboxes to remove, or pass --all");

  const targets: { name: string; find: () => Promise<Target> }[] = all
    ? (await listAll(store, "sandbox", (warning) => out.note(warning))).map((entry) => ({
        name: entry.record.name,
        find: async () => entry,
      }))
    : flags.positionals.map((target) => ({
        name: target,
        find: () => findTarget(session, target),
      }));

  const details: BatchDetails & { removed: (BatchItem & { retainedResources: string[] })[] } = {
    removed: [],
    skipped: [],
    failed: [],
  };

  let lastCause: unknown;

  // Keep going after a failure so every confirmed effect is reported.
  for (const target of targets) {
    try {
      const result = await removeOne(session, store, await target.find(), force, all);

      if (result.kind === "skipped") {
        details.skipped.push(result.item);
        continue;
      }

      details.removed.push(result.item);

      if (result.item.result === "gone") out.note(`${result.item.name}: already gone`);

      if (result.item.retainedResources.length)
        out.note(`${result.item.name}: retained ${result.item.retainedResources.join(", ")}`);
    } catch (cause) {
      const report = describeError(cause);
      lastCause = cause;
      details.failed.push({
        name: target.name,
        result: "failed",
        code: report.code,
        reason: report.message,
      });
    }
  }

  if (details.failed.length === 1 && targets.length === 1) throw lastCause;

  if (details.failed.length)
    throw new CliError(
      "PARTIAL",
      `Removed ${details.removed.length} of ${targets.length} sandboxes; ${details.failed.length} failed`,
      "see error.details; retry the failed names once the cause is fixed",
      undefined,
      "partial",
      details,
    );

  for (const item of details.skipped) out.note(`skipped ${item.name}: ${item.reason}`);

  out.success(
    { removed: details.removed, skipped: details.skipped },
    details.removed.map((entry) => entry.name).join("\n"),
  );

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

async function execute(
  session: Session,
  box: SandboxHandle<true>,
  input: ExecInput,
): Promise<ExecOutput> {
  try {
    return await box.exec(input, { signal: session.ctx.signal });
  } catch (cause) {
    if (!(cause instanceof NonzeroExitError)) throw cause;

    return cause.result;
  }
}

function execSummary(result: ExecOutput): ExecSummary {
  return {
    exitCode: result.exitCode,
    stdout: result.stdoutText({ full: true }),
    stderr: result.stderrText({ full: true }),
    truncated: result.truncated,
  };
}

/** Human mode streams the command's own output; JSON mode carries it in the one envelope. */
function printStreams(out: Output, result: ExecOutput): void {
  if (out.json) return;

  if (result.stdout.byteLength) out.streams.stdout(result.stdout);

  if (result.stderr.byteLength) out.streams.stderr(result.stderr);

  if (result.truncated)
    out.note("sandbar: output was truncated; raise --max-output to capture more");
}

type RunSandbox = { name: string; id: string | null; kept: boolean };

/** Print a finished command and return its exit code; a missing exit status is never success. */
function finishExec(out: Output, result: ExecOutput, sandbox?: RunSandbox): number {
  printStreams(out, result);

  if (result.exitCode === null)
    throw new CliError(
      "OUTCOME_UNKNOWN",
      "The command ran but the provider reported no exit status",
      "the captured output is in error.known.exec",
      { exec: execSummary(result) },
    );

  if (out.json) out.success({ ...execSummary(result), sandbox }, "");

  return result.exitCode;
}

export async function execCommand(session: Session, flags: Flags): Promise<number> {
  const { record } = await findTarget(session, onePositional(flags, "sandbox"));
  const input = await execInput(session, flags, argvCommand(flags));
  const box = await session.reopen(record);

  return finishExec(session.ctx.out, await execute(session, box, input));
}

type ShScript = { target: string; script: string };

function shScript(flags: Flags): ShScript {
  const [target, inline] = flags.positionals;

  if (flags.rest && flags.positionals.length === 1 && flags.rest.length === 1)
    return { target: target!, script: flags.rest[0]! };

  if (!flags.rest && flags.positionals.length === 2) return { target: target!, script: inline! };

  throw usage(
    "Usage: sandbar sh <sandbox> '<script>' (or put the script after --, as one argument)",
  );
}

export async function shCommand(session: Session, flags: Flags): Promise<number> {
  const { target, script } = shScript(flags);
  const { record } = await findTarget(session, target);
  const input = await execInput(session, flags, { kind: "shell", script });
  const box = await session.reopen(record);

  return finishExec(session.ctx.out, await execute(session, box, input));
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
  const { out, signal } = session.ctx;
  let result: ExecOutput | undefined;
  let failure: unknown;

  const sandbox = (kept: boolean): RunSandbox => ({
    name: created.record.name,
    id: created.record.reference?.nativeId ?? null,
    kept,
  });

  // An unrecorded sandbox still runs nothing and is still destroyed below.
  if (created.unrecorded) failure = unrecordedError(created);
  else
    try {
      result = await execute(session, created.box, input);
    } catch (cause) {
      failure = cause;
    }

  if (keep) {
    out.note(`kept sandbox ${created.record.name}`);

    if (failure) throw failure;

    return finishExec(out, result!, sandbox(true));
  }

  try {
    // A fresh signal: cleanup must still run after an interrupt aborted the command.
    await created.box.destroy();
    await store.remove("sandbox", created.record.name);
  } catch (cause) {
    const report = describeError(cause);

    if (result) printStreams(out, result);

    // One document: the command's result travels inside the cleanup error.
    throw new CliError(
      "CLEANUP_FAILED",
      `Cleanup of ${created.record.name} failed: ${report.message}${
        failure ? `; the command also failed: ${describeError(failure).message}` : ""
      }`,
      `remove it with \`sandbar rm ${created.record.name}\``,
      {
        sandbox: created.record.name,
        reference: created.record.reference,
        exec: result ? execSummary(result) : undefined,
      },
      "partial",
    );
  }

  if (failure && signal.aborted)
    // The interrupt only stopped local waiting; cleanup is confirmed, so say so instead of
    // passing on the SDK's "outcome unknown" wait error.
    throw new CliError(
      "INTERRUPTED",
      `Interrupted; sandbox ${created.record.name} was destroyed`,
      "the command may have partly run before the sandbox was destroyed",
      { sandbox: created.record.name, reference: created.record.reference },
      "partial",
    );

  if (failure) {
    if (failure instanceof CliError && failure.code === "STORE_WRITE_FAILED")
      throw new CliError(
        "STORE_WRITE_FAILED",
        `${failure.message}; the sandbox was destroyed, so nothing was run`,
      );
    throw failure;
  }

  return finishExec(out, result!, sandbox(false));
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

  try {
    await writeFile(local, bytes, { flag: flags.bool("no-clobber") ? "wx" : "w" });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      throw new CliError(
        "CONFLICT",
        `${local} already exists`,
        "drop --no-clobber to overwrite it",
      );
    throw cause;
  }

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

  // doctor itself succeeded; whether create would work is reported in its data.
  return 0;
}

/** Settings a profile for this provider supplies, so `providers` does not ask for their variables. */
function profileKeys(loaded: LoadedConfig, provider: string, env: Env): Set<string> {
  return new Set(
    Object.values(loaded.value.profiles ?? {})
      .filter((profile) => profile.provider === provider)
      .flatMap((profile) =>
        [
          ...Object.entries(profile.config ?? {}),
          ...Object.entries(profile.credentials ?? {}),
        ].flatMap(([key, value]) => (valueAvailable(value, env) ? [key] : [])),
      ),
  );
}

export async function providersCommand(session: Session): Promise<number> {
  const { env, cwd } = session.ctx;
  const loaded = await session.config();

  const rows = await Promise.all(
    providers.map(async (provider) => {
      const resolved = await resolveAdapterModule(
        {
          name: provider.id,
          provider: provider.id,
          module: provider.module,
          export: provider.export,
          baseDir: cwd,
          searchProject: searchProjectAdapters(loaded, env),
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
        // A profile that sets a value itself doesn't need the environment variable.
        missingEnv: missingEnv(provider, env, profileKeys(loaded, provider.id, env)),
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
