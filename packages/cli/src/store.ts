import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceReference, type RecoveryReference } from "sandbar-sdk";
import { z } from "zod";
import { CliError, usage } from "./output";

export const RecordName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const SandboxRecord = z.strictObject({
  format: z.literal(1),
  kind: z.literal("sandbox"),
  name: RecordName,
  /** `creating` claims the name before the provider call; `unknown` keeps an uncertain create for gc. */
  status: z.enum(["creating", "created", "unknown"]),
  profile: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  labels: z.record(z.string(), z.string()),
  image: z.string().optional(),
  reference: ResourceReference.extend({ kind: z.literal("sandbox") }).nullable(),
  /**
   * Set by `sandbar adopt`: the record came from a provider listing, not a create by this CLI, so
   * `rm` refuses it without --force and `rm --all` skips it. Absent on created records.
   */
  adopted: z.literal(true).optional(),
  /** The SDK's operation reference for an uncertain create; the SDK validates it on recovery. */
  recovery: z
    .custom<RecoveryReference>(
      (value) => z.record(z.string(), z.unknown()).safeParse(value).success,
    )
    .optional(),
});

export type SandboxRecord = z.infer<typeof SandboxRecord>;

export const RetainedResource = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
  ownership: z.enum(["verified", "unknown"]),
  cleanup: z.enum(["manual", "provider_expiry", "none_known"]),
});

export const ImageRecord = z.strictObject({
  format: z.literal(1),
  kind: z.literal("image"),
  name: RecordName,
  /**
   * `building` claims the name before the provider call; `unknown` keeps an uncertain build;
   * `deleting` keeps a delete whose outcome is unknown until `sandbar image rm` confirms it.
   */
  status: z.enum(["building", "built", "unknown", "deleting"]),
  profile: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  /** The OCI reference as typed; `--image` matches it exactly, so a mutable tag keeps its build. */
  source: z.string().min(1),
  /** The SDK's prepared image, bound to the provider account and scope that built it. */
  prepared: z
    .strictObject({
      kind: z.literal("prepared"),
      value: z.string().min(1),
      provider: z.string().min(1),
      scope: ResourceReference.shape.scope,
    })
    .nullable(),
  /** Provider-side artifacts the build left behind. `sandbar image rm` deletes the built image. */
  retainedResources: z.array(RetainedResource),
  /** The SDK's scoped image reference for the build; absent on records from older CLIs. */
  reference: ResourceReference.extend({ kind: z.literal("image") }).optional(),
  recovery: z
    .custom<RecoveryReference>(
      (value) => z.record(z.string(), z.unknown()).safeParse(value).success,
    )
    .optional(),
});

export type ImageRecord = z.infer<typeof ImageRecord>;

export const SnapshotRecord = z.strictObject({
  format: z.literal(1),
  kind: z.literal("snapshot"),
  name: RecordName,
  /**
   * `capturing` claims the name before the provider call; `unknown` keeps an uncertain capture;
   * `deleting` keeps a delete whose outcome is unknown until `sandbar snapshot rm` confirms it.
   */
  status: z.enum(["capturing", "captured", "unknown", "deleting"]),
  profile: z.string().min(1),
  provider: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  /** Store name of the sandbox it was captured from. */
  sandbox: z.string().min(1),
  /** What the capture keeps: `filesystem` or `filesystem+memory`. */
  preserve: z.string().min(1).nullable(),
  reference: ResourceReference.extend({ kind: z.literal("snapshot") }).nullable(),
  recovery: z
    .custom<RecoveryReference>(
      (value) => z.record(z.string(), z.unknown()).safeParse(value).success,
    )
    .optional(),
});

export type SnapshotRecord = z.infer<typeof SnapshotRecord>;

type Records = { sandbox: SandboxRecord; image: ImageRecord; snapshot: SnapshotRecord };

export type RecordKind = keyof Records;

/** The schema that guards each kind of record on every read and write. */
type RecordSchemas = { [K in RecordKind]: z.ZodType<Records[K]> };

const schemas: RecordSchemas = {
  sandbox: SandboxRecord,
  image: ImageRecord,
  snapshot: SnapshotRecord,
};

const folders = {
  sandbox: "sandboxes",
  image: "images",
  snapshot: "snapshots",
} satisfies Record<RecordKind, string>;

export type Versioned<R = SandboxRecord> = { record: R; version: string };

/**
 * Per-record operations only (no operations across records, no transactions), so an object
 * store with conditional writes can implement the same contract later.
 */
export interface StateStore {
  get<K extends RecordKind>(kind: K, name: string): Promise<Versioned<Records[K]> | null>;
  /** Claims a name; CONFLICT when it is taken. */
  create<K extends RecordKind>(
    kind: K,
    name: string,
    record: Records[K],
  ): Promise<{ version: string }>;
  /** Compare-and-swap on the version returned by get/create; CONFLICT on mismatch. */
  update<K extends RecordKind>(
    kind: K,
    name: string,
    record: Records[K],
    version: string,
  ): Promise<{ version: string }>;
  remove(kind: RecordKind, name: string, version?: string): Promise<void>;
  list(
    kind: RecordKind,
    cursor?: string,
    limit?: number,
  ): Promise<{ names: string[]; cursor?: string }>;
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encode<K extends RecordKind>(kind: K, record: Records[K]): string {
  return `${JSON.stringify(schemas[kind].parse(record), null, 2)}\n`;
}

/** A lock older than this belongs to a crashed process and may be broken. */
const STALE_LOCK_MS = 30_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * JSON files under `<dir>/sandboxes/<name>.json` and `<dir>/images/<name>.json`. Readers never see partial files: create links a
 * fully written temporary file into place (failing if the name exists) and update renames one.
 * update and remove hold a short per-record lock file so their version check is a real
 * compare-and-swap between CLI processes.
 */
export class FsStateStore implements StateStore {
  constructor(readonly dir: string) {}

  private folder(kind: RecordKind): string {
    return join(this.dir, folders[kind]);
  }

  private path(kind: RecordKind, name: string): string {
    return join(this.folder(kind), `${RecordName.parse(name)}.json`);
  }

  private async temporary(kind: RecordKind, name: string, text: string): Promise<string> {
    await mkdir(this.folder(kind), { recursive: true });
    const path = `${this.path(kind, name)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(path, text, { flag: "wx" });

    return path;
  }

  private async locked<T>(kind: RecordKind, name: string, action: () => Promise<T>): Promise<T> {
    const lock = `${this.path(kind, name)}.lock`;
    await mkdir(this.folder(kind), { recursive: true });

    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(lock, String(process.pid), { flag: "wx" });
        break;
      } catch (cause) {
        if (errorCode(cause) !== "EEXIST") throw cause;
        const held = await stat(lock).catch(() => null);

        if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) await unlink(lock).catch(() => {});
        else if (attempt >= 100)
          throw new CliError("CONFLICT", `Store record ${name} is locked by another process`);
        else await sleep(20);
      }
    }

    try {
      return await action();
    } finally {
      await unlink(lock).catch(() => {});
    }
  }

  async get<K extends RecordKind>(kind: K, name: string): Promise<Versioned<Records[K]> | null> {
    let text: string;

    try {
      text = await readFile(this.path(kind, name), "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return null;
      throw cause;
    }

    let json: z.infer<ReturnType<typeof z.json>>;

    try {
      json = z.json().parse(JSON.parse(text));
    } catch {
      throw new CliError(
        "STORE_INVALID",
        `Store record ${this.path(kind, name)} is not valid JSON`,
      );
    }

    const parsed = schemas[kind].safeParse(json);

    if (!parsed.success)
      throw new CliError("STORE_INVALID", `Store record ${this.path(kind, name)} is invalid`);

    return { record: parsed.data, version: versionOf(text) };
  }

  async create<K extends RecordKind>(
    kind: K,
    name: string,
    record: Records[K],
  ): Promise<{ version: string }> {
    const text = encode(kind, record);
    const temporary = await this.temporary(kind, name, text);

    try {
      await link(temporary, this.path(kind, name));
    } catch (cause) {
      if (errorCode(cause) === "EEXIST")
        throw new CliError("CONFLICT", `Name ${name} is already in use`);
      throw cause;
    } finally {
      await unlink(temporary).catch(() => {});
    }

    return { version: versionOf(text) };
  }

  async update<K extends RecordKind>(
    kind: K,
    name: string,
    record: Records[K],
    version: string,
  ): Promise<{ version: string }> {
    return this.locked(kind, name, async () => {
      const current = await this.get(kind, name);

      if (!current || current.version !== version)
        throw new CliError("CONFLICT", `Store record ${name} changed concurrently`);
      const text = encode(kind, record);
      await rename(await this.temporary(kind, name, text), this.path(kind, name));

      return { version: versionOf(text) };
    });
  }

  async remove(kind: RecordKind, name: string, version?: string): Promise<void> {
    await this.locked(kind, name, async () => {
      if (version !== undefined) {
        const current = await this.get(kind, name);

        if (current && current.version !== version)
          throw new CliError("CONFLICT", `Store record ${name} changed concurrently`);
      }

      try {
        await unlink(this.path(kind, name));
      } catch (cause) {
        if (errorCode(cause) !== "ENOENT") throw cause;
      }
    });
  }

  async list(
    kind: RecordKind,
    cursor?: string,
    limit = 1000,
  ): Promise<{ names: string[]; cursor?: string }> {
    let files: string[];

    try {
      files = await readdir(this.folder(kind));
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return { names: [] };
      throw cause;
    }

    const names = files
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -5))
      .filter((name) => RecordName.safeParse(name).success && (!cursor || name > cursor))
      .sort();

    const page = names.slice(0, limit);

    return { names: page, cursor: names.length > limit ? page.at(-1) : undefined };
  }
}

/** Every readable record; an unreadable one is reported to `onInvalid` and skipped. */
export async function listAll<K extends RecordKind>(
  store: StateStore,
  kind: K,
  onInvalid?: (message: string) => void,
): Promise<Versioned<Records[K]>[]> {
  const found: Versioned<Records[K]>[] = [];
  let cursor: string | undefined;

  do {
    const page = await store.list(kind, cursor);

    for (const name of page.names) {
      try {
        const entry = await store.get(kind, name);

        if (entry) found.push(entry);
      } catch (cause) {
        if (!(cause instanceof CliError) || cause.code !== "STORE_INVALID") throw cause;
        onInvalid?.(`warning: ${cause.message}; skipped`);
      }
    }

    cursor = page.cursor;
  } while (cursor);

  return found;
}

export function checkName(name: string): string {
  const parsed = RecordName.safeParse(name);

  if (!parsed.success)
    throw usage(
      `Invalid name ${name}`,
      "use 1-63 lowercase letters, digits and dashes, starting with a letter or digit",
    );

  return parsed.data;
}

export function generatedName(): string {
  return `sb-${randomBytes(3).toString("hex").slice(0, 5)}`;
}
