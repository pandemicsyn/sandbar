import { SandbarError, type SandboxListEntry } from "sandbar-sdk";
import {
  coverageNote,
  forget,
  remoteSandboxes,
  renderTable,
  storesSandbox,
  type Flags,
} from "./commands";
import { CliError, describeError, usage, type BatchItem } from "./output";
import type { Session } from "./session";
import { listAll } from "./store";
import { parseDuration, parsePairs } from "./units";

/** One sandbox gc looked at; `name` is its store name, or the native id when it has none. */
type GcItem = BatchItem & { id: string; createdAt: string | null };

type GcRemoved = GcItem & { retainedResources: string[] };

function matches(item: SandboxListEntry, labels: Record<string, string>): boolean {
  return (
    item.labels !== null &&
    Object.entries(labels).every(([key, value]) => item.labels![key] === value)
  );
}

/**
 * `sandbar gc`: destroy the profile's sandboxes whose provider labels match every `--label`,
 * optionally only those created before `--older-than`. It reads the provider's listing rather than
 * the store, so it finds sandboxes that a killed job never removed.
 */
export async function gcCommand(session: Session, flags: Flags): Promise<number> {
  const { out } = session.ctx;
  const labels = parsePairs(flags.strings("label"), "label");

  if (flags.positionals.length) throw usage("gc takes no sandbox names; select them with --label");

  if (!Object.keys(labels).length)
    throw usage(
      "Pass at least one --label k=v",
      "gc only destroys sandboxes carrying labels you set at create, e.g. --label run=42",
    );

  const olderThan = flags.string("older-than");
  const cutoff = olderThan ? Date.now() - parseDuration(olderThan, "older-than") * 1000 : null;
  const dryRun = flags.bool("dry-run");

  const profile = await session.profile();
  const store = await session.store();
  const entries = await listAll(store, "sandbox", (warning) => out.note(warning));
  const client = await session.connect(profile);
  const listing = await remoteSandboxes(client);

  // Destroyed sandboxes stay listed on some providers; there is nothing left to collect.
  const live = listing.items.filter((item) => item.state !== "destroyed");
  const removed: GcRemoved[] = [];
  const skipped: GcItem[] = [];
  const failed: (GcItem & { code: string })[] = [];
  let lastCause: unknown;

  out.note(`${profile.provider} lists ${coverageNote[listing.coverage]}`);

  if (!listing.complete)
    out.note(
      `warning: read the first ${listing.items.length} sandboxes; the provider has more, so run gc again`,
    );

  if (live.length && live.every((item) => item.labels === null))
    out.note(`${profile.provider} reports no labels on listed sandboxes, so gc matches none`);

  for (const item of live.filter((candidate) => matches(candidate, labels))) {
    const createdAt = item.createdAt === null ? null : Date.parse(item.createdAt);
    const entry = entries.find(({ record }) => storesSandbox(record, profile, client, item));

    const base: Omit<GcItem, "result"> = {
      name: entry?.record.name ?? item.id,
      id: item.id,
      createdAt: item.createdAt,
    };

    if (cutoff !== null) {
      if (createdAt === null) {
        skipped.push({
          ...base,
          result: "skipped",
          reason: `${profile.provider} reports no creation time, so --older-than cannot apply`,
        });
        continue;
      }

      if (createdAt > cutoff) continue;
    }

    if (!item.reference) {
      skipped.push({
        ...base,
        result: "skipped",
        reason: `${profile.provider} lists it without a reopenable reference`,
      });
      continue;
    }

    if (entry?.record.adopted) {
      skipped.push({
        ...base,
        result: "skipped",
        reason: `adopted into the store; remove it with \`sandbar rm ${entry.record.name} --force\``,
      });
      continue;
    }

    if (dryRun) {
      removed.push({ ...base, result: "would-destroy", retainedResources: [] });
      continue;
    }

    try {
      let result = "destroyed";
      let retainedResources: string[] = [];

      try {
        const box = await client.sandboxes.get(item.reference, { signal: session.ctx.signal });
        retainedResources = (await box.destroy({ signal: session.ctx.signal })).retainedResources;
      } catch (cause) {
        if (!(cause instanceof SandbarError) || cause.code !== "NOT_FOUND") throw cause;
        result = "gone";
      }

      if (entry) await forget(store, entry);
      removed.push({ ...base, result, retainedResources });

      if (retainedResources.length)
        out.note(`${base.name}: retained ${retainedResources.join(", ")}`);
    } catch (cause) {
      const report = describeError(cause);
      lastCause = cause;
      failed.push({ ...base, result: "failed", code: report.code, reason: report.message });
    }
  }

  if (failed.length === 1 && !removed.length) throw lastCause;

  if (failed.length)
    throw new CliError(
      "PARTIAL",
      `Removed ${removed.length} of ${removed.length + failed.length} matching sandboxes; ${failed.length} failed`,
      "see error.details; run gc again once the cause is fixed",
      undefined,
      "partial",
      { removed, skipped, failed },
    );

  for (const item of skipped) out.note(`skipped ${item.name}: ${item.reason}`);

  if (!removed.length && !skipped.length) out.note("no sandboxes matched");

  out.success(
    {
      provider: profile.provider,
      profile: profile.name,
      coverage: listing.coverage,
      complete: listing.complete,
      dryRun,
      removed,
      skipped,
    },
    removed.length
      ? renderTable([
          ["NAME", "RESULT", "CREATED"],
          ...removed.map((item) => [item.name, item.result, item.createdAt ?? "-"]),
        ])
      : "",
  );

  return 0;
}
