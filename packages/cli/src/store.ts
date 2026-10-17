import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ResourceReference } from "sandbar-sdk";
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
});

export type SandboxRecord = z.infer<typeof SandboxRecord>;

export type RecordKind = SandboxRecord["kind"];

export type Versioned = { record: SandboxRecord; version: string };

/**
 * Per-record operations only (no rename across records, no locks, no transactions), so an
 * object store with conditional writes can implement the same contract later.
 */
export interface StateStore {
  get(kind: RecordKind, name: string): Promise<Versioned | null>;
  /** Claims a name; CONFLICT when it is taken. */
  create(kind: RecordKind, name: string, record: SandboxRecord): Promise<{ version: string }>;
  /** Compare-and-swap on the version returned by get/create; CONFLICT on mismatch. */
  update(
    kind: RecordKind,
    name: string,
    record: SandboxRecord,
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

function encode(record: SandboxRecord): string {
  return `${JSON.stringify(SandboxRecord.parse(record), null, 2)}\n`;
}

/** JSON files under `<dir>/<kind>s/<name>.json`. */
export class FsStateStore implements StateStore {
  constructor(readonly dir: string) {}

  private folder(kind: RecordKind): string {
    return join(this.dir, `${kind}es`);
  }

  private path(kind: RecordKind, name: string): string {
    return join(this.folder(kind), `${RecordName.parse(name)}.json`);
  }

  async get(kind: RecordKind, name: string): Promise<Versioned | null> {
    let text: string;

    try {
      text = await readFile(this.path(kind, name), "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return null;
      throw cause;
    }

    const parsed = SandboxRecord.safeParse(JSON.parse(text));

    if (!parsed.success)
      throw new CliError("STORE_INVALID", `Store record ${this.path(kind, name)} is invalid`);

    return { record: parsed.data, version: versionOf(text) };
  }

  async create(
    kind: RecordKind,
    name: string,
    record: SandboxRecord,
  ): Promise<{ version: string }> {
    const text = encode(record);
    await mkdir(this.folder(kind), { recursive: true });

    try {
      await writeFile(this.path(kind, name), text, { flag: "wx" });
    } catch (cause) {
      if (errorCode(cause) === "EEXIST")
        throw new CliError("CONFLICT", `Name ${name} is already in use`);
      throw cause;
    }

    return { version: versionOf(text) };
  }

  async update(
    kind: RecordKind,
    name: string,
    record: SandboxRecord,
    version: string,
  ): Promise<{ version: string }> {
    const current = await this.get(kind, name);

    if (!current || current.version !== version)
      throw new CliError("CONFLICT", `Store record ${name} changed concurrently`);
    const text = encode(record);
    const temporary = `${this.path(kind, name)}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, this.path(kind, name));

    return { version: versionOf(text) };
  }

  async remove(kind: RecordKind, name: string, version?: string): Promise<void> {
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

export async function listAll(store: StateStore, kind: RecordKind): Promise<Versioned[]> {
  const found: Versioned[] = [];
  let cursor: string | undefined;

  do {
    const page = await store.list(kind, cursor);

    for (const name of page.names) {
      const entry = await store.get(kind, name);

      if (entry) found.push(entry);
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
