import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterRecoveryReference } from "sandbar-sdk";
import { z } from "zod";

const ledgerSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  provider: z.enum(["daytona", "e2b"]),
  createdAt: z.iso.datetime(),
  image: z.strictObject({
    kind: z.enum(["borrowed-prepared", "owned-built"]),
    class: z.string().min(1).max(80),
  }),
  connection: z
    .union([
      z.strictObject({
        target: z.string().min(1).max(128),
        region: z.string().min(1).max(128),
        timeoutSeconds: z.number().int().min(60).max(3600),
      }),
      z.strictObject({
        teamId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        timeoutSeconds: z.literal(300),
      }),
    ])
    .optional(),
  createIntent: z.boolean(),
  createReference: z.unknown().optional(),
  destroyReference: z.unknown().optional(),
  operationReferences: z.array(z.unknown()).max(32).optional(),
  sandboxId: z.string().min(1).max(512).optional(),
  cleanup: z.enum(["pending", "confirmed", "unresolved"]),
  lastIssue: z.enum(["outcome-unknown", "cleanup-failed", "confirmation-failed"]).optional(),
});

export type RunLedger = z.infer<typeof ledgerSchema> & {
  createReference?: AdapterRecoveryReference;
  destroyReference?: AdapterRecoveryReference;
  operationReferences?: AdapterRecoveryReference[];
};

/** Private crash-recovery state. The caller must put directory on persistent restricted storage. */
export class LedgerStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    directory: string,
    readonly runId: string,
    private readonly checkpoint?: (ledger: RunLedger) => Promise<void>,
  ) {
    if (!z.uuid().safeParse(runId).success) throw new Error("Invalid run ID");
    this.path = join(directory, `${runId}.json`);
  }

  async read(): Promise<RunLedger> {
    const info = await lstat(this.path);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe ledger file permissions");
    // SAFETY: Ledger fields are schema-parsed here; the SDK validates the saved recovery reference before use.
    const value = ledgerSchema.parse(JSON.parse(await readFile(this.path, "utf8"))) as RunLedger;

    if (value.runId !== this.runId) throw new Error("Ledger run ID mismatch");

    return value;
  }

  /** One process may exercise or reconcile a run at a time. Crash locks fail closed. */
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.read();
    const lockPath = `${this.path}.lock`;
    const lock = await open(lockPath, "wx", 0o600);

    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
      await lock.sync();

      return await work();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async initialize(
    provider: RunLedger["provider"],
    image: RunLedger["image"],
    connection?: RunLedger["connection"],
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(dirname(this.path));

    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o077) !== 0 ||
      (process.getuid && directoryInfo.uid !== process.getuid())
    )
      throw new Error("Unsafe ledger directory permissions");
    const file = await open(this.path, "wx", 0o600);

    try {
      await file.writeFile(
        JSON.stringify({
          version: 1,
          runId: this.runId,
          provider,
          createdAt: new Date().toISOString(),
          image,
          connection,
          createIntent: false,
          cleanup: "pending",
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }

    await this.checkpoint?.(await this.read());
  }

  update(change: (value: RunLedger) => RunLedger): Promise<void> {
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        const next = ledgerSchema.parse(change(await this.read()));
        const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);

        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }

        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");

        try {
          await directory.sync();
        } finally {
          await directory.close();
        }

        // A failed off-runner checkpoint rejects the SDK before-submit hook, so no create is sent.
        // SAFETY: The next ledger was validated with ledgerSchema before persistence.
        await this.checkpoint?.(next as RunLedger);
      });

    return this.queue;
  }
}
