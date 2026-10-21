import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ResourceReference,
  SandbarError,
  type SandbarClient,
  type CreateInput,
  type SandboxHandle,
  type SnapshotInfo,
  type SnapshotResult,
} from "sandbar-sdk";
import { findTarget, type Flags } from "./commands";
import { CliError, describeError, usage } from "./output";
import type { Session } from "./session";
import {
  checkName,
  listAll,
  RecordName,
  SnapshotRecord,
  type StateStore,
  type Versioned,
} from "./store";

type Entry = Versioned<SnapshotRecord>;

const SnapshotReference = ResourceReference.extend({ kind: z.literal("snapshot") });

/** An observed capture: the SDK's result holds the snapshot handle with its reference. */
const CaptureResult = z.looseObject({
  snapshot: z.looseObject({ reference: SnapshotReference }),
  capture: z.looseObject({ preserve: z.string().min(1) }),
});

const DeleteResult = z.looseObject({ deleted: z.literal(true) });

async function findSnapshot(store: StateStore, name: string): Promise<Entry> {
  const found = await store.get("snapshot", checkName(name));

  if (!found)
    throw new CliError(
      "NOT_FOUND",
      `No snapshot named ${name}`,
      "list them with `sandbar snapshot ls`",
    );

  return found;
}

/** `<sandbox>-snap`, or with a random suffix when that name is taken. */
async function claim(store: StateStore, record: Omit<SnapshotRecord, "name">, requested?: string) {
  const base = requested
    ? checkName(requested)
    : RecordName.safeParse(`${record.sandbox}-snap`).success
      ? `${record.sandbox}-snap`
      : "snapshot";

  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const full = { ...record, name };

    try {
      const { version } = await store.create("snapshot", name, full);

      return { record: full, version };
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT" || attempt >= 8) throw cause;

      if (requested)
        throw new CliError(
          "CONFLICT",
          `Snapshot name ${name} is already in use`,
          "pass --replace to capture it again, choose another --name, or `sandbar snapshot forget` the old record",
        );
    }
  }
}

function summary(record: SnapshotRecord) {
  return {
    name: record.name,
    sandbox: record.sandbox,
    profile: record.profile,
    provider: record.provider,
    status: record.status,
    preserve: record.preserve,
    createdAt: record.createdAt,
    id: record.reference?.nativeId ?? null,
  };
}

/** Observe an uncertain capture again and record it once the provider confirms it. */
async function recoverCapture(session: Session, store: StateStore, entry: Entry): Promise<Entry> {
  const { record } = entry;

  if (record.status !== "unknown" || record.recovery?.kind !== "snapshot_capture") return entry;

  const client = await session.connect(await session.profileNamed(record.profile));
  let value: unknown;

  try {
    value = await (await client.recover(record.recovery)).observe();
  } catch (cause) {
    if (cause instanceof SandbarError && cause.effect !== "none") return entry;
    throw cause;
  }

  const parsed = CaptureResult.safeParse(value);

  if (!parsed.success) return entry;

  const { recovery: _recovery, ...rest } = record;

  const recovered: SnapshotRecord = {
    ...rest,
    status: "captured",
    preserve: parsed.data.capture.preserve,
    reference: parsed.data.snapshot.reference,
  };

  const { version } = await store.update("snapshot", record.name, recovered, entry.version);
  session.ctx.out.note(
    `${record.name}: recovered the uncertain capture as ${parsed.data.snapshot.reference.nativeId}`,
  );

  return { record: recovered, version };
}

/** Delete a snapshot on the provider; null when it is confirmed gone, else why it may remain. */
async function deleteRemote(
  client: SandbarClient<true>,
  reference: z.infer<typeof SnapshotReference>,
  signal: AbortSignal,
): Promise<{ gone: boolean } | { error: unknown }> {
  try {
    await client.snapshots.delete(reference, { signal });

    return { gone: false };
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected" && report.code === "NOT_FOUND") return { gone: true };

    return { error: cause };
  }
}

/**
 * Capture a stored sandbox. `--replace` re-captures an existing name: the record keeps the old
 * snapshot until the new one is confirmed, then the old one is deleted if this CLI created it.
 */
async function createCommand(session: Session, flags: Flags, args: readonly string[]) {
  if (args.length !== 1)
    throw usage("Expected exactly one sandbox", "e.g. sandbar snapshot create web --name base");
  const store = await session.store();
  const target = await findTarget(session, args[0]!);

  if (target.fromFile) throw usage("Snapshot a sandbox from the store, not a reference file");
  const source = target.record;
  const requested = flags.string("name");
  const replace = flags.bool("replace");

  if (replace && !requested) throw usage("--replace needs --name");
  const existing = requested ? await store.get("snapshot", checkName(requested)) : null;

  if (existing && !replace)
    throw new CliError(
      "CONFLICT",
      `Snapshot name ${existing.record.name} is already in use`,
      "pass --replace to capture it again, or choose another --name",
    );

  if (existing && existing.record.status !== "captured")
    throw new CliError(
      "CONFLICT",
      `${existing.record.name} is ${existing.record.status}, not captured`,
      "`sandbar snapshot inspect` checks it; `sandbar snapshot forget` drops the record",
    );

  if (existing && existing.record.profile !== source.profile)
    throw new CliError(
      "CONFLICT",
      `${existing.record.name} belongs to profile ${existing.record.profile}, not ${source.profile}`,
      "choose another --name",
    );

  const client = await session.connect(await session.profileNamed(source.profile));
  const box = await session.reopen(source, client);
  const plan = await box.checkSnapshot();

  if (plan.status !== "supported")
    throw new CliError(
      plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
      `${source.provider} cannot snapshot ${source.name}: ${plan.reason}`,
    );

  const claimed =
    existing ??
    (await claim(
      store,
      {
        format: 1,
        kind: "snapshot",
        status: "capturing",
        profile: source.profile,
        provider: source.provider,
        createdAt: new Date().toISOString(),
        sandbox: source.name,
        preserve: null,
        reference: null,
      },
      requested,
    ));

  session.ctx.out.note(
    `capturing ${source.name} (${plan.value.profile.preserve}, source ${plan.value.profile.interruption === "none" ? "keeps running" : `may ${plan.value.profile.interruption}`})`,
  );
  let result: SnapshotResult;

  try {
    result = await box.snapshot({}, { signal: session.ctx.signal });
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected") {
      if (!existing) await store.remove("snapshot", claimed.record.name, claimed.version);
      throw cause;
    }

    const recovery = report.known?.recovery;
    let kept = `the store keeps ${claimed.record.name}; \`sandbar snapshot inspect ${claimed.record.name}\` checks the capture again`;

    if (existing)
      kept = `${existing.record.name} still holds the previous snapshot; the new one may exist on the provider`;
    else
      try {
        await store.update(
          "snapshot",
          claimed.record.name,
          { ...claimed.record, status: "unknown", recovery },
          claimed.version,
        );
      } catch (storeCause) {
        kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
      }

    throw new CliError("OUTCOME_UNKNOWN", report.message, kept, {
      snapshot: claimed.record.name,
      recovery,
    });
  }

  const reference = SnapshotReference.parse(result.snapshot.reference);
  const { recovery: _recovery, ...rest } = claimed.record;

  const record: SnapshotRecord = {
    ...rest,
    status: "captured",
    createdAt: new Date().toISOString(),
    sandbox: source.name,
    preserve: result.capture.preserve,
    reference,
  };

  try {
    await store.update("snapshot", record.name, record, claimed.version);
  } catch (cause) {
    throw new CliError(
      "STORE_WRITE_FAILED",
      `Captured ${source.name} as ${reference.nativeId} but could not record it: ${describeError(cause).message}`,
      "the provider keeps the snapshot; capture again once the store is writable",
      { snapshot: record.name, snapshotReference: reference },
      "partial",
    );
  }

  const previous = existing?.record.reference;
  let replaced: { id: string; result: "deleted" | "kept" } | null = null;

  if (previous && previous.nativeId !== reference.nativeId) {
    const outcome =
      previous.ownership === "verified-created"
        ? await deleteRemote(client, previous, session.ctx.signal)
        : null;

    replaced = {
      id: previous.nativeId,
      result: outcome && !("error" in outcome) ? "deleted" : "kept",
    };

    if (replaced.result === "kept")
      session.ctx.out.note(
        `the previous snapshot ${previous.nativeId} is still on ${source.provider}${
          outcome && "error" in outcome ? ` (${describeError(outcome.error).message})` : ""
        }; delete it with the provider's own tools`,
      );
  }

  session.ctx.out.success({ ...summary(record), reference, replaced }, record.name);

  return 0;
}

async function lsSnapshots(session: Session) {
  const store = await session.store();
  const entries = await listAll(store, "snapshot", (message) => session.ctx.out.note(message));
  const rows = entries.map(({ record }) => summary(record));

  const lines = rows.map((row) =>
    [row.name.padEnd(20), row.profile.padEnd(12), row.status.padEnd(9), row.sandbox].join(" "),
  );

  session.ctx.out.success(
    { snapshots: rows },
    rows.length
      ? [
          `${"NAME".padEnd(20)} ${"PROFILE".padEnd(12)} ${"STATUS".padEnd(9)} SANDBOX`,
          ...lines,
        ].join("\n")
      : "no snapshots; capture one with `sandbar snapshot create <sandbox>`",
  );

  return 0;
}

function remoteRow(info: SnapshotInfo, records: Entry[]) {
  const recorded = records.find(
    ({ record }) => record.reference?.nativeId === info.reference.nativeId,
  )?.record.name;

  return {
    id: info.reference.nativeId,
    state: info.state,
    preserve: info.preserve,
    source: info.source?.id ?? null,
    createdAt: info.createdAt,
    record: recorded ?? null,
    reference: info.reference,
  };
}

/** List the provider's snapshots for this profile, marking those this store recorded. */
async function lsRemote(session: Session) {
  const profile = await session.profile();
  const client = await session.connect(profile);
  const capabilities = await client.capabilities();

  if (capabilities.snapshots.list.status !== "supported")
    throw new CliError(
      "UNSUPPORTED",
      `${profile.provider} cannot list snapshots through Sandbar`,
      "`sandbar snapshot ls` shows the snapshots this store recorded",
    );

  const records = (await listAll(await session.store(), "snapshot")).filter(
    ({ record }) => record.profile === profile.name,
  );

  const rows: ReturnType<typeof remoteRow>[] = [];
  let cursor: string | undefined;
  let coverage: string | undefined;

  // A bounded walk: at most 1000 snapshots, so a huge account cannot stall the command.
  for (let page = 0; page < 10; page++) {
    const result = await client.snapshots.list({ limit: 100, cursor });
    coverage = result.coverage;
    rows.push(...result.items.map((info) => remoteRow(info, records)));
    cursor = result.nextCursor;

    if (!cursor) break;
  }

  if (cursor) session.ctx.out.note(`showing the first ${rows.length} snapshots; more exist`);

  const lines = rows.map((row) =>
    [
      row.id.padEnd(28),
      row.state.padEnd(9),
      (row.preserve ?? "-").padEnd(18),
      (row.record ?? "-").padEnd(20),
      row.source ?? "-",
    ].join(" "),
  );

  session.ctx.out.success(
    { profile: profile.name, coverage, snapshots: rows, truncated: !!cursor },
    rows.length
      ? [
          `${"ID".padEnd(28)} ${"STATE".padEnd(9)} ${"PRESERVE".padEnd(18)} ${"RECORD".padEnd(20)} SOURCE`,
          ...lines,
        ].join("\n")
      : `no snapshots on ${profile.provider} for profile ${profile.name}`,
  );

  return 0;
}

async function inspectSnapshot(session: Session, args: readonly string[]) {
  if (args.length !== 1) throw usage("Expected exactly one snapshot name");
  const store = await session.store();
  const { record } = await recoverCapture(session, store, await findSnapshot(store, args[0]!));
  let state: string = record.status === "captured" ? "unknown" : record.status;

  if (record.status === "captured" && record.reference) {
    const client = await session.connect(await session.profileNamed(record.profile));

    try {
      state = (await (await client.snapshots.get(record.reference)).inspect()).state;
    } catch (cause) {
      const report = describeError(cause);

      state = report.code === "NOT_FOUND" ? "gone" : "unreachable";
    }
  }

  const lines = [
    `name      ${record.name}`,
    `sandbox   ${record.sandbox}`,
    `provider  ${record.provider} (profile ${record.profile})`,
    `status    ${record.status}`,
    `state     ${state}`,
    `preserve  ${record.preserve ?? "unknown"}`,
    `id        ${record.reference?.nativeId ?? "none"}`,
    `captured  ${record.createdAt}`,
  ];

  session.ctx.out.success(
    {
      ...summary(record),
      state,
      reference: record.reference,
      recovery: record.recovery ?? null,
    },
    lines.join("\n"),
  );

  return 0;
}

async function forgetSnapshot(session: Session, args: readonly string[]) {
  if (args.length !== 1) throw usage("Expected exactly one snapshot name");
  const store = await session.store();
  const { record, version } = await findSnapshot(store, args[0]!);
  await store.remove("snapshot", record.name, version);

  const lines = [`forgot ${record.name}`];

  if (record.reference)
    lines.push(
      `${record.provider} still holds ${record.reference.nativeId}; forget never deletes it (\`sandbar snapshot rm\` does)`,
    );

  session.ctx.out.success(
    { name: record.name, result: "forgotten", id: record.reference?.nativeId ?? null },
    lines.join("\n"),
  );

  return 0;
}

/** Drop a record once its snapshot is confirmed gone, unless it changed meanwhile. */
async function forgetDeleted(store: StateStore, entry: Entry) {
  const current = await store.get("snapshot", entry.record.name);

  if (current?.version === entry.version)
    await store.remove("snapshot", entry.record.name, entry.version);
}

function deletedOutput(session: Session, record: SnapshotRecord, result: "deleted" | "gone") {
  session.ctx.out.success(
    { name: record.name, result, id: record.reference?.nativeId ?? null },
    result === "gone" ? `${record.name} was already gone` : `deleted ${record.name}`,
  );

  return 0;
}

/**
 * Delete the snapshot on the provider, then the record. An uncertain delete keeps the record as
 * `deleting` with its operation reference; running rm again observes that operation and never
 * submits a second delete. Without `force`, only snapshots this CLI verifiably captured are deleted.
 */
async function rmSnapshot(session: Session, args: readonly string[], force: boolean) {
  if (args.length !== 1) throw usage("Expected exactly one snapshot name");
  const store = await session.store();
  const entry = await recoverCapture(session, store, await findSnapshot(store, args[0]!));
  const { record } = entry;
  const client = await session.connect(await session.profileNamed(record.profile));

  if (record.status === "deleting" && record.recovery?.kind === "snapshot_delete") {
    let value: unknown;

    try {
      value = await (await client.recover(record.recovery)).observe();
    } catch (cause) {
      if (!(cause instanceof SandbarError)) throw cause;

      if (cause.effect === "none")
        throw new CliError(
          cause.code,
          cause.message,
          `the store keeps ${record.name} deleting; run \`sandbar snapshot rm ${record.name}\` again`,
          { snapshot: record.name, recovery: record.recovery },
        );
    }

    if (!DeleteResult.safeParse(value).success)
      throw new CliError(
        "OUTCOME_UNKNOWN",
        `The delete of ${record.name} is still unconfirmed`,
        `the store keeps ${record.name}; run \`sandbar snapshot rm ${record.name}\` again later`,
        { snapshot: record.name, recovery: record.recovery },
      );
    await forgetDeleted(store, entry);

    return deletedOutput(session, record, "deleted");
  }

  if (!["captured", "deleting"].includes(record.status) || !record.reference)
    throw new CliError(
      "CONFLICT",
      `${record.name} has no confirmed snapshot to delete`,
      "`sandbar snapshot inspect` checks an uncertain capture; `sandbar snapshot forget` drops the record",
    );

  if (record.reference.ownership !== "verified-created" && !force)
    throw new CliError(
      "FORBIDDEN",
      `${record.name} was not captured by this CLI (ownership ${record.reference.ownership})`,
      "pass --force to delete it anyway",
      { snapshot: record.name },
    );

  const outcome = await deleteRemote(client, record.reference, session.ctx.signal);

  if (!("error" in outcome)) {
    await forgetDeleted(store, entry);

    return deletedOutput(session, record, outcome.gone ? "gone" : "deleted");
  }

  const report = describeError(outcome.error);

  if (report.outcome === "rejected") throw outcome.error;

  const recovery = report.known?.recovery;

  if (!recovery)
    throw new CliError(
      "OUTCOME_UNKNOWN",
      report.message,
      `the store keeps ${record.name} and there is no saved delete to check; check \`sandbar snapshot ls --remote\` before running \`sandbar snapshot rm ${record.name}\` again, which sends a new delete`,
      { snapshot: record.name },
    );
  let kept = `the store keeps ${record.name}; run \`sandbar snapshot rm ${record.name}\` again to check`;

  try {
    await store.update(
      "snapshot",
      record.name,
      { ...record, status: "deleting", recovery },
      entry.version,
    );
  } catch (storeCause) {
    kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
  }

  throw new CliError("OUTCOME_UNKNOWN", report.message, kept, { snapshot: record.name, recovery });
}

/** The recorded snapshot for `create --snapshot`, checked before anything is claimed. */
export async function snapshotSource(session: Session, name: string): Promise<SnapshotRecord> {
  const { record } = await findSnapshot(await session.store(), name);

  if (record.status !== "captured" || !record.reference)
    throw new CliError(
      "CONFLICT",
      `Snapshot ${record.name} is ${record.status}, not captured`,
      "`sandbar snapshot inspect` checks it",
    );

  return record;
}

/** Start a sandbox from a recorded snapshot with the create's network, env, labels and lifetime. */
export async function restoreSnapshot(
  session: Session,
  client: SandbarClient<true>,
  record: SnapshotRecord,
  input: CreateInput,
): Promise<SandboxHandle<true>> {
  const snapshot = await client.snapshots.get(SnapshotReference.parse(record.reference));
  const { network, env, labels, lifecycle } = input;

  return snapshot.restore({ network, env, labels, lifecycle }, { signal: session.ctx.signal });
}

export const snapshotActions = ["create", "ls", "inspect", "rm", "forget"] as const;

export async function snapshotCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  if ((flags.string("name") || flags.bool("replace")) && action !== "create")
    throw usage("--name and --replace only apply to `sandbar snapshot create`");

  if (flags.bool("remote") && action !== "ls")
    throw usage("--remote only applies to `sandbar snapshot ls`");

  if (flags.bool("force") && action !== "rm")
    throw usage("--force only applies to `sandbar snapshot rm`");

  switch (action) {
    case "create":
      return createCommand(session, flags, args);
    case "ls":
      if (args.length) throw usage("snapshot ls takes no arguments");

      return flags.bool("remote") ? lsRemote(session) : lsSnapshots(session);
    case "inspect":
      return inspectSnapshot(session, args);
    case "rm":
      return rmSnapshot(session, args, flags.bool("force"));
    case "forget":
      return forgetSnapshot(session, args);
    default:
      throw usage(
        action ? `Unknown snapshot command ${action}` : "Expected a snapshot command",
        `use one of: ${snapshotActions.join(", ")}`,
      );
  }
}
