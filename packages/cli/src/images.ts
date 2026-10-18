import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  Image,
  SandbarError,
  type ImageBuildResult,
  type ImageInfo,
  type ImageInput,
  type ResourceReference,
  type SandbarClient,
} from "sandbar-sdk";
import type { Flags } from "./commands";
import { CliError, describeError, usage } from "./output";
import type { ResolvedProfile } from "./providers";
import type { Session } from "./session";
import {
  checkName,
  ImageRecord,
  listAll,
  RecordName,
  type StateStore,
  type Versioned,
} from "./store";

type Entry = Versioned<ImageRecord>;

const BuildResult = ImageRecord.pick({
  prepared: true,
  retainedResources: true,
  reference: true,
}).extend({
  prepared: ImageRecord.shape.prepared.unwrap(),
});

const DeleteResult = z.looseObject({ deleted: z.literal(true) });

/** A name from the reference's last path segment, e.g. ghcr.io/org/tool:1.2 gives tool-1-2. */
function derivedName(source: string): string {
  const base = (source.split("/").at(-1) ?? source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 57)
    .replace(/^-+|-+$/g, "");

  return RecordName.safeParse(base).success ? base : "image";
}

/** The built record for this reference as typed on this profile, if any. */
async function findBuild(store: StateStore, profile: string, source: string) {
  const entries = await listAll(store, "image");

  return entries.find(
    ({ record }) =>
      record.profile === profile &&
      record.source === source &&
      record.prepared &&
      record.status !== "deleting",
  );
}

function mergeRetained(
  previous: ImageRecord["retainedResources"],
  next: ImageRecord["retainedResources"],
) {
  const seen = new Set(previous.map((item) => `${item.kind}/${item.id}`));

  return [...previous, ...next.filter((item) => !seen.has(`${item.kind}/${item.id}`))];
}

async function claim(store: StateStore, record: Omit<ImageRecord, "name">, requested?: string) {
  const base = requested ? checkName(requested) : derivedName(record.source);

  for (let attempt = 0; ; attempt++) {
    const name = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const full = { ...record, name };

    try {
      const { version } = await store.create("image", name, full);

      return { record: full, version };
    } catch (cause) {
      if (!(cause instanceof CliError) || cause.code !== "CONFLICT" || attempt >= 8) throw cause;

      if (requested)
        throw new CliError(
          "CONFLICT",
          `Image name ${name} is already in use`,
          "choose another --name, or `sandbar image forget` the old record",
        );
    }
  }
}

type Built = { entry: Entry; built: boolean };

/**
 * Build `source` on this profile and record it, or return the existing record. A refresh keeps
 * the old record until the new build is confirmed, then lists both builds' retained resources.
 */
async function buildImage(
  session: Session,
  client: SandbarClient<true>,
  profile: ResolvedProfile,
  source: string,
  options: { name?: string; refresh?: boolean },
): Promise<Built> {
  const store = await session.store();
  const existing = await findBuild(store, profile.name, source);

  if (existing && options.name && existing.record.name !== checkName(options.name))
    throw new CliError(
      "CONFLICT",
      `${source} is already built for profile ${profile.name} as ${existing.record.name}`,
      "use that name, or `sandbar image forget` it first",
    );

  if (existing && !options.refresh) return { entry: existing, built: false };

  if (!(await client.capabilities()).imageBuild)
    throw new CliError(
      "UNSUPPORTED",
      `${profile.provider} does not build images`,
      "providers that boot OCI images directly take --image without a build",
    );

  const claimed =
    existing ??
    (await claim(
      store,
      {
        format: 1,
        kind: "image",
        status: "building",
        profile: profile.name,
        provider: profile.provider,
        createdAt: new Date().toISOString(),
        source,
        prepared: null,
        retainedResources: [],
      },
      options.name,
    ));

  session.ctx.out.note(`building ${source} on ${profile.provider}; this can take a few minutes`);
  let result: ImageBuildResult;

  try {
    result = await client.images.build(
      { source: { kind: "oci", value: source } },
      { signal: session.ctx.signal },
    );
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected") {
      if (!existing) await store.remove("image", claimed.record.name, claimed.version);
      throw cause;
    }

    const recovery = report.known?.recovery;
    let kept = `the store keeps ${claimed.record.name}; \`sandbar image inspect ${claimed.record.name}\` checks the build again`;

    if (existing)
      kept = `${existing.record.name} still holds the previous build; the new one may exist on the provider`;
    else
      try {
        await store.update(
          "image",
          claimed.record.name,
          { ...claimed.record, status: "unknown", recovery },
          claimed.version,
        );
      } catch (storeCause) {
        kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
      }

    throw new CliError("OUTCOME_UNKNOWN", report.message, kept, {
      image: claimed.record.name,
      recovery,
    });
  }

  const { recovery: _recovery, ...rest } = claimed.record;

  const record: ImageRecord = {
    ...rest,
    status: "built",
    createdAt: new Date().toISOString(),
    prepared: result.prepared,
    retainedResources: mergeRetained(claimed.record.retainedResources, result.retainedResources),
    reference: result.reference,
  };

  try {
    const { version } = await store.update("image", record.name, record, claimed.version);

    return { entry: { record, version }, built: true };
  } catch (cause) {
    throw new CliError(
      "STORE_WRITE_FAILED",
      `Built ${source} as ${result.prepared.value} but could not record it: ${describeError(cause).message}`,
      "the provider keeps the image; pass it with --prepared, or rebuild once the store is writable",
      { image: record.name },
      "partial",
    );
  }
}

/**
 * The create environment for `--image`. Providers without an image build get the OCI reference
 * as is; build-first providers use this profile's recorded build, or build only when asked to.
 */
export async function imageEnvironment(
  session: Session,
  client: SandbarClient<true>,
  profile: ResolvedProfile,
  source: string,
  build: boolean,
): Promise<ImageInput> {
  if (!(await client.capabilities()).imageBuild) return Image.oci(source);

  const store = await session.store();
  const found = await findBuild(store, profile.name, source);

  if (found?.record.prepared) return Image.prepared(found.record.prepared);

  const autoBuild = (await session.config()).value.images?.autoBuild === true;

  if (!build && !autoBuild)
    throw new CliError(
      "UNSUPPORTED",
      `image ${source} is not built for profile ${profile.name}; run: sandbar image build ${source}`,
      `pass --build to build it during this command, or set images.autoBuild in sandbar.json`,
    );

  const { entry } = await buildImage(session, client, profile, source, {});

  if (!entry.record.prepared) throw new Error(`Image record ${entry.record.name} has no build`);

  return Image.prepared(entry.record.prepared);
}

function summary(record: ImageRecord) {
  return {
    name: record.name,
    source: record.source,
    profile: record.profile,
    provider: record.provider,
    status: record.status,
    createdAt: record.createdAt,
    prepared: record.prepared?.value ?? null,
    retainedResources: record.retainedResources,
  };
}

function retainedLines(record: ImageRecord): string[] {
  return record.retainedResources.map(
    (item) => `  ${item.kind} ${item.id} (cleanup ${item.cleanup}, ownership ${item.ownership})`,
  );
}

async function findImage(store: StateStore, name: string): Promise<Entry> {
  const found = await store.get("image", checkName(name));

  if (!found)
    throw new CliError(
      "NOT_FOUND",
      `No image record named ${name}`,
      "list them with `sandbar image ls`",
    );

  return found;
}

/** Observe an uncertain build again and record it once the provider confirms it. */
async function recoverBuild(session: Session, store: StateStore, entry: Entry): Promise<Entry> {
  const { record } = entry;

  if (record.status !== "unknown" || record.recovery?.kind !== "image_build") return entry;

  const client = await session.connect(await session.profileNamed(record.profile));
  let value: unknown;

  try {
    value = await (await client.recover(record.recovery)).observe();
  } catch (cause) {
    if (cause instanceof SandbarError && cause.effect !== "none") return entry;
    throw cause;
  }

  const parsed = BuildResult.safeParse(value);

  if (!parsed.success) return entry;

  const { recovery: _recovery, ...rest } = record;
  const recovered: ImageRecord = { ...rest, status: "built", ...parsed.data };
  const { version } = await store.update("image", record.name, recovered, entry.version);
  session.ctx.out.note(
    `${record.name}: recovered the uncertain build as ${parsed.data.prepared.value}`,
  );

  return { record: recovered, version };
}

async function buildCommand(session: Session, flags: Flags, args: readonly string[]) {
  if (args.length !== 1)
    throw usage("Expected exactly one OCI image reference", "e.g. sandbar image build python:3.12");
  const profile = await session.profile();
  const client = await session.connect(profile);

  const { entry, built } = await buildImage(session, client, profile, args[0]!, {
    name: flags.string("name"),
    refresh: flags.bool("refresh"),
  });

  const { record } = entry;

  session.ctx.out.success(
    { ...summary(record), built },
    built
      ? record.name
      : `${record.name} (already built; pass --refresh to build ${record.source} again)`,
  );

  return 0;
}

async function lsImages(session: Session) {
  const store = await session.store();
  const entries = await listAll(store, "image", (message) => session.ctx.out.note(message));
  const rows = entries.map(({ record }) => summary(record));

  const lines = rows.map((row) =>
    [row.name.padEnd(20), row.profile.padEnd(12), row.status.padEnd(9), row.source].join(" "),
  );

  session.ctx.out.success(
    { images: rows },
    rows.length
      ? [
          `${"NAME".padEnd(20)} ${"PROFILE".padEnd(12)} ${"STATUS".padEnd(9)} SOURCE`,
          ...lines,
        ].join("\n")
      : "no image records; build one with `sandbar image build <oci-ref>`",
  );

  return 0;
}

async function inspectImage(session: Session, args: readonly string[]) {
  if (args.length !== 1) throw usage("Expected exactly one image name");
  const store = await session.store();
  const { record } = await recoverBuild(session, store, await findImage(store, args[0]!));

  const lines = [
    `name      ${record.name}`,
    `source    ${record.source}`,
    `provider  ${record.provider} (profile ${record.profile})`,
    `status    ${record.status}`,
    `prepared  ${record.prepared?.value ?? "none"}`,
    `built     ${record.createdAt}`,
    ...(record.retainedResources.length ? ["retained", ...retainedLines(record)] : []),
  ];

  session.ctx.out.success(
    {
      ...summary(record),
      preparedImage: record.prepared,
      reference: record.reference ?? null,
      recovery: record.recovery ?? null,
    },
    lines.join("\n"),
  );

  return 0;
}

async function forgetImage(session: Session, args: readonly string[]) {
  if (args.length !== 1) throw usage("Expected exactly one image name");
  const store = await session.store();
  const { record, version } = await findImage(store, args[0]!);
  await store.remove("image", record.name, version);

  const lines = [`forgot ${record.name}`];

  if (record.retainedResources.length)
    lines.push(
      `${record.provider} still holds these; forget never deletes them (\`sandbar image rm\` does, where the provider supports it):`,
      ...retainedLines(record),
    );

  session.ctx.out.success(
    { name: record.name, result: "forgotten", retainedResources: record.retainedResources },
    lines.join("\n"),
  );

  return 0;
}

/** The recorded build as an image reference; older records never claim verified ownership. */
function recordReference(record: ImageRecord): ResourceReference | null {
  if (record.reference) return record.reference;

  if (!record.prepared) return null;

  return {
    version: 1,
    kind: "image",
    provider: record.prepared.provider,
    scope: structuredClone(record.prepared.scope),
    nativeId: record.prepared.value,
    ownership: "unknown",
  };
}

/** Drop a record once its provider image is confirmed gone, unless it changed meanwhile. */
async function forgetDeleted(store: StateStore, entry: Entry) {
  const current = await store.get("image", entry.record.name);

  if (current?.version === entry.version)
    await store.remove("image", entry.record.name, entry.version);
}

function deletedOutput(session: Session, record: ImageRecord, result: "deleted" | "gone") {
  const prepared = record.prepared?.value ?? null;
  const others = record.retainedResources.filter((item) => item.id !== prepared);
  const lines = [result === "gone" ? `${record.name} was already gone` : `deleted ${record.name}`];

  if (others.length)
    lines.push(
      `${record.provider} still holds these from earlier builds:`,
      ...retainedLines({ ...record, retainedResources: others }),
    );

  session.ctx.out.success(
    { name: record.name, result, prepared, retainedResources: others },
    lines.join("\n"),
  );

  return 0;
}

/**
 * Delete the recorded build on the provider, then the record. An uncertain delete keeps the
 * record as `deleting` with its operation reference; running rm again observes that operation
 * and never submits a second delete.
 */
async function rmImage(session: Session, args: readonly string[]) {
  if (args.length !== 1) throw usage("Expected exactly one image name");
  const store = await session.store();
  const entry = await recoverBuild(session, store, await findImage(store, args[0]!));
  const { record } = entry;
  const client = await session.connect(await session.profileNamed(record.profile));

  if (record.status === "deleting") {
    if (record.recovery?.kind !== "image_delete")
      throw new CliError("OUTCOME_UNKNOWN", `${record.name} has no saved delete to check`);
    let value: unknown;

    try {
      value = await (await client.recover(record.recovery)).observe();
    } catch (cause) {
      if (!(cause instanceof SandbarError) || cause.effect === "none") throw cause;
    }

    if (!DeleteResult.safeParse(value).success)
      throw new CliError(
        "OUTCOME_UNKNOWN",
        `The delete of ${record.name} is still unconfirmed`,
        `the store keeps ${record.name}; run \`sandbar image rm ${record.name}\` again later`,
        { image: record.name, recovery: record.recovery },
      );
    await forgetDeleted(store, entry);

    return deletedOutput(session, record, "deleted");
  }

  const reference = recordReference(record);

  if (record.status !== "built" || !reference)
    throw new CliError(
      "CONFLICT",
      `${record.name} has no confirmed build to delete`,
      "`sandbar image inspect` checks an uncertain build; `sandbar image forget` drops the record",
    );

  const capabilities = await client.capabilities();

  if (capabilities.imageManagement.delete.status !== "supported")
    throw new CliError(
      "UNSUPPORTED",
      `${record.provider} cannot delete images through Sandbar`,
      "`sandbar image forget` drops the record; delete the image with the provider's own tools",
    );

  const shared = (await listAll(store, "image")).find(
    (other) =>
      other.record.name !== record.name &&
      other.record.profile === record.profile &&
      other.record.prepared?.value === reference.nativeId,
  );

  if (shared)
    throw new CliError(
      "CONFLICT",
      `${record.name} and ${shared.record.name} record the same provider image`,
      "forget one record first, so the other is not left pointing at a deleted image",
    );

  try {
    await client.images.delete(reference, { signal: session.ctx.signal });
  } catch (cause) {
    const report = describeError(cause);

    if (report.outcome === "rejected" && report.code === "NOT_FOUND") {
      await forgetDeleted(store, entry);

      return deletedOutput(session, record, "gone");
    }

    if (report.outcome === "rejected") throw cause;

    const recovery = report.known?.recovery;
    let kept = `the store keeps ${record.name}; run \`sandbar image rm ${record.name}\` again to check`;

    try {
      await store.update(
        "image",
        record.name,
        { ...record, status: "deleting", recovery },
        entry.version,
      );
    } catch (storeCause) {
      kept = `the store could not record it (${describeError(storeCause).message}); keep the reference below`;
    }

    throw new CliError("OUTCOME_UNKNOWN", report.message, kept, {
      image: record.name,
      recovery,
    });
  }

  await forgetDeleted(store, entry);

  return deletedOutput(session, record, "deleted");
}

function remoteRow(info: ImageInfo, records: Entry[]) {
  const recorded = records.find(({ record }) => record.prepared?.value === info.reference.nativeId)
    ?.record.name;

  return {
    id: info.reference.nativeId,
    state: info.state,
    visibility: info.visibility,
    source: info.source?.value ?? null,
    createdAt: info.createdAt,
    record: recorded ?? null,
    reference: info.reference,
  };
}

/** List the provider's images for this profile, marking those this store recorded. */
async function lsRemote(session: Session) {
  const profile = await session.profile();
  const client = await session.connect(profile);
  const capabilities = await client.capabilities();

  if (capabilities.imageManagement.list.status !== "supported")
    throw new CliError(
      "UNSUPPORTED",
      `${profile.provider} cannot list images through Sandbar`,
      "`sandbar image ls` shows the builds this store recorded",
    );

  const records = (await listAll(await session.store(), "image")).filter(
    ({ record }) => record.profile === profile.name,
  );

  const rows: ReturnType<typeof remoteRow>[] = [];
  let cursor: string | undefined;
  let coverage = capabilities.imageManagement.list.value.coverage;

  // A bounded walk: at most 1000 images, so a huge account cannot stall the command.
  for (let page = 0; page < 10; page++) {
    const result = await client.images.list({ limit: 100, cursor });
    coverage = result.coverage;
    rows.push(...result.items.map((info) => remoteRow(info, records)));
    cursor = result.nextCursor;

    if (!cursor) break;
  }

  if (cursor) session.ctx.out.note(`showing the first ${rows.length} images; more exist`);

  const lines = rows.map((row) =>
    [
      row.id.padEnd(28),
      row.state.padEnd(9),
      row.visibility.padEnd(10),
      (row.record ?? "-").padEnd(20),
      row.source ?? "-",
    ].join(" "),
  );

  session.ctx.out.success(
    { profile: profile.name, coverage, images: rows, truncated: !!cursor },
    rows.length
      ? [
          `${"ID".padEnd(28)} ${"STATE".padEnd(9)} ${"VISIBILITY".padEnd(10)} ${"RECORD".padEnd(20)} SOURCE`,
          ...lines,
        ].join("\n")
      : `no images on ${profile.provider} for profile ${profile.name}`,
  );

  return 0;
}

export const imageActions = ["build", "ls", "inspect", "rm", "forget"] as const;

export async function imageCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  if ((flags.string("name") || flags.bool("refresh")) && action !== "build")
    throw usage("--name and --refresh only apply to `sandbar image build`");

  if (flags.bool("remote") && action !== "ls")
    throw usage("--remote only applies to `sandbar image ls`");

  switch (action) {
    case "build":
      return buildCommand(session, flags, args);
    case "ls":
      if (args.length) throw usage("image ls takes no arguments");

      return flags.bool("remote") ? lsRemote(session) : lsImages(session);
    case "inspect":
      return inspectImage(session, args);
    case "rm":
      return rmImage(session, args);
    case "forget":
      return forgetImage(session, args);
    default:
      throw usage(
        action ? `Unknown image command ${action}` : "Expected an image command",
        `use one of: ${imageActions.join(", ")}`,
      );
  }
}
