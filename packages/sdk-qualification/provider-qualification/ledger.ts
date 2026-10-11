import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterRecoveryReference } from "sandbar-sdk";
import { z } from "zod";
import { ResourceScope, ResourceReference } from "sandbar-adapter";
import { envdSchema, failureDiagnosticSchema } from "./diagnostics";
import { networkEvidenceSchema, networkProbeId } from "./network-probe";

const ledgerSchema = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  provider: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
  createdAt: z.iso.datetime(),
  image: z.strictObject({
    kind: z.enum(["borrowed-prepared", "borrowed-oci", "owned-built"]),
    class: z.string().min(1).max(80),
  }),
  connection: z
    .union([
      z.strictObject({
        profile: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/),
        routing: z.record(
          z.string().max(80),
          z.union([z.string().max(512), z.number().finite(), z.boolean()]),
        ),
      }),
      z.strictObject({
        target: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
        snapshotId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_-]+$/),
        // Read known saved routing without changing the current fixture's creation budget.
        ttlMinutes: z.union([z.literal(10), z.literal(15)]),
        restartAfterCapture: z.boolean().optional(),
        networkPolicy: z.enum(["blocked", "daytona-default"]).optional(),
      }),
      z.strictObject({
        target: z.string().min(1).max(128),
        region: z.string().min(1).max(128),
        timeoutSeconds: z.number().int().min(60).max(3600),
      }),
      z.strictObject({
        teamId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/)
          .optional(),
        templateId: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?(?::default)?$/),
        timeoutSeconds: z.literal(300),
        preview: z.strictObject({ access: z.enum(["protected", "public"]) }).optional(),
      }),
    ])
    .optional(),
  fileRoot: z.enum(["/tmp", "/home/user"]).optional(),
  companionRunId: z.uuid().optional(),
  networkPolicy: z.enum(["internet", "blocked", "daytona-default"]).optional(),
  networkProbe: z.literal(networkProbeId).optional(),
  networkEvidence: networkEvidenceSchema.optional(),
  envd: envdSchema.optional(),
  diagnostics: z
    .array(failureDiagnosticSchema.extend({ scenario: z.string().max(80) }))
    .max(64)
    .optional(),
  stateMode: z.literal("live-state").optional(),
  stateRole: z.string().max(80).optional(),
  stateBorrowedVolume: z.unknown().optional(),
  stateSelection: z
    .array(z.enum(["snapshot-roundtrip", "volume-persistence", "volume-crud"]))
    .max(3)
    .optional(),
  stateMutations: z
    .array(
      z.strictObject({
        role: z.string().max(80),
        reference: z.unknown(),
        resource: z.unknown().optional(),
        sandboxId: z.string().max(512).optional(),
        cleanup: z.enum(["pending", "confirmed", "borrowed", "not-required"]),
        creation: z.boolean(),
      }),
    )
    .max(64)
    .optional(),
  stateObservations: z.record(z.string().max(80), z.unknown()).optional(),
  createIntent: z.boolean(),
  createReference: z.unknown().optional(),
  destroyReference: z.unknown().optional(),
  operationReferences: z.array(z.unknown()).max(32).optional(),
  sandboxId: z.string().min(1).max(512).optional(),
  cleanup: z.enum(["pending", "confirmed", "unresolved", "not-required"]),
  lastIssue: z.enum(["outcome-unknown", "cleanup-failed", "confirmation-failed"]).optional(),
});

export type RunLedger = z.infer<typeof ledgerSchema> & {
  createReference?: AdapterRecoveryReference;
  destroyReference?: AdapterRecoveryReference;
  operationReferences?: AdapterRecoveryReference[];
};

export async function requirePrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (info.mode & 0o700) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe ledger directory permissions");
}

type StateCustody = NonNullable<RunLedger["stateMutations"]>[number];

const custodyIdentity = z.object({
  version: z.number().int(),
  mode: z.literal("direct"),
  provider: z.string(),
  kind: z.string(),
  operationId: z.string(),
  submissionId: z.string(),
  invocationKey: z.string(),
  scope: ResourceScope,
  sandboxId: z.string().optional(),
  resource: ResourceReference.optional(),
});

// Only the currently supported public recovery identity can exclude another provider's
// custody. Legacy checkpoint normalization remains separate and does not grant admission.
const admissionIdentity = custodyIdentity.extend({
  version: z.literal(2),
  provider: ledgerSchema.shape.provider,
  kind: z.enum(["create", "image_build", "snapshot_capture", "snapshot_restore", "volume_create"]),
  operationId: z.string().min(1).max(128),
  submissionId: z.string().min(1).max(128),
  invocationKey: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(512).optional(),
  tokenVersion: z.number().int().positive().optional(),
  token: z.json().optional(),
});

function operationIdentity(entry: StateCustody) {
  const value = custodyIdentity.parse(entry.reference);

  return JSON.stringify([
    value.version,
    value.mode,
    value.provider,
    value.kind,
    value.operationId,
    value.submissionId,
    value.invocationKey,
    value.sandboxId,
    value.resource ? resourceIdentity(value.resource) : null,
    value.scope.authority,
    Object.entries(value.scope.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

function resourceIdentity(resource: ResourceReference) {
  return JSON.stringify([
    resource.kind,
    resource.provider,
    resource.nativeId,
    resource.generation,
    resource.scope.authority,
    Object.entries(resource.scope.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

function normalizedCustody(entries: StateCustody[]) {
  const unique = new Map<string, StateCustody>();

  for (const entry of entries) {
    const id = custodyIdentity.parse(entry.reference).submissionId;
    const first = unique.get(id);

    if (!first) {
      unique.set(id, entry);
      continue;
    }

    if (operationIdentity(first) !== operationIdentity(entry))
      throw new Error("Checkpoint operation identity conflicts with saved custody");

    if (first.sandboxId && entry.sandboxId && first.sandboxId !== entry.sandboxId)
      throw new Error("Checkpoint sandbox identity conflicts with saved custody");

    if (
      first.resource &&
      entry.resource &&
      resourceIdentity(ResourceReference.parse(first.resource)) !==
        resourceIdentity(ResourceReference.parse(entry.resource))
    )
      throw new Error("Checkpoint resource identity conflicts with saved custody");

    if (
      first.creation &&
      entry.creation &&
      (first.role !== entry.role || first.cleanup !== entry.cleanup)
    )
      throw new Error("Checkpoint cleanup obligation conflicts with saved custody");
    const owner = !first.creation && entry.creation ? entry : first;
    unique.set(id, {
      ...owner,
      reference: entry.reference,
      resource: first.resource ?? entry.resource,
      sandboxId: first.sandboxId ?? entry.sandboxId,
    });
  }

  return [...unique.values()];
}

export function operationCheckpoints(
  entries: RunLedger["operationReferences"],
  reference: AdapterRecoveryReference,
) {
  // SAFETY: Every entry came from a schema-read ledger or the SDK recovery-reference hook.
  return normalizedCustody([
    ...(entries ?? []).map((saved) => ({
      role: "operation",
      reference: saved,
      creation: false,
      cleanup: "not-required" as const,
    })),
    { role: "operation", reference, creation: false, cleanup: "not-required" },
  ]).map((entry) => entry.reference as AdapterRecoveryReference);
}

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

  /** Serialize all runs in this private ledger directory, including paired reconciliation. */
  async withAdmissionLock<T>(work: () => Promise<T>, companion?: LedgerStore): Promise<T> {
    if (
      companion &&
      (dirname(this.path) !== dirname(companion.path) || this.runId === companion.runId)
    )
      throw new Error("Invalid companion ledger");
    const lockPath = join(dirname(this.path), ".admission.lock");
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

  /** Called under shared admission; E2B volume-only custody does not consume a zero-volume compute budget. */
  async requirePreviousCleanup(
    provider: RunLedger["provider"],
    budget?: { volumes: number },
  ): Promise<void> {
    ledgerSchema.shape.provider.parse(provider);

    if (budget) z.number().int().nonnegative().parse(budget.volumes);

    for (const filename of await readdir(dirname(this.path))) {
      if (!filename.endsWith(".json")) continue;
      const runId = filename.slice(0, -5);

      if (!z.uuid().safeParse(runId).success) continue;
      const previous = await new LedgerStore(dirname(this.path), runId).read();

      if (
        (previous.createReference ||
          previous.stateMutations?.some(
            (entry) => entry.creation && entry.cleanup === "pending",
          )) &&
        previous.cleanup !== "confirmed" &&
        previous.cleanup !== "not-required"
      ) {
        // Separate providers have independent resource budgets. Do not separate accounts or
        // regions: saved routing alone does not authenticate a different spending scope.
        const creations = [
          ...(previous.createReference
            ? [{ reference: previous.createReference, resource: undefined }]
            : []),
          ...(previous.stateMutations ?? [])
            .filter((entry) => entry.creation && entry.cleanup === "pending")
            .map((entry) => ({
              reference: entry.reference,
              resource: entry.resource,
              sandboxId: entry.sandboxId,
            })),
        ];

        const identified = creations.every((entry) => {
          const identity = admissionIdentity.safeParse(entry.reference);

          const resource =
            entry.resource === undefined ? undefined : ResourceReference.safeParse(entry.resource);

          return (
            identity.success &&
            identity.data.provider === previous.provider &&
            (!identity.data.resource || identity.data.resource.provider === previous.provider) &&
            (resource === undefined ||
              (resource.success && resource.data.provider === previous.provider))
          );
        });

        const isolatedE2BVolumes =
          identified &&
          provider === "e2b" &&
          previous.provider === provider &&
          budget?.volumes === 0 &&
          !previous.createReference &&
          !previous.createIntent &&
          !previous.sandboxId &&
          previous.image.kind === "borrowed-prepared" &&
          creations.every((entry) => {
            const identity = admissionIdentity.parse(entry.reference);

            const resource =
              entry.resource === undefined ? undefined : ResourceReference.parse(entry.resource);

            return (
              identity.kind === "volume_create" &&
              !identity.sandboxId &&
              !("sandboxId" in entry && entry.sandboxId) &&
              (!identity.resource || identity.resource.kind === "volume") &&
              (!resource || resource.kind === "volume")
            );
          });

        if (!identified || (previous.provider === provider && !isolatedE2BVolumes))
          throw new Error(
            "An earlier run has unresolved resources for this provider or unverified identity; reconcile its private ledger before creating another sandbox",
          );
      }
    }
  }

  async initialize(
    provider: RunLedger["provider"],
    image: RunLedger["image"],
    connection?: RunLedger["connection"],
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await requirePrivateDirectory(dirname(this.path));
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

  async saveStateReference(reference: AdapterRecoveryReference): Promise<void> {
    const before = await this.read();
    const normalized = normalizedCustody(before.stateMutations ?? []);

    if (normalized.length !== (before.stateMutations ?? []).length) {
      const backup = await open(
        `${this.path}.checkpoint-history-${crypto.randomUUID()}`,
        "wx",
        0o600,
      );

      try {
        await backup.writeFile(JSON.stringify(before));
        await backup.sync();
      } finally {
        await backup.close();
      }
    }

    await this.update((value) => {
      const entries = normalizedCustody(value.stateMutations ?? []);

      const incoming: StateCustody = {
        role: value.stateRole ?? "reconcile/delete",
        reference,
        cleanup: "not-required",
        creation: false,
      };

      return { ...value, stateMutations: normalizedCustody([...entries, incoming]) };
    });
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

/** Compatibility for persisted baseline receipts; new Bun fixtures use stateMutations. */
export async function recordLegacyReference(
  ledger: LedgerStore,
  reference: AdapterRecoveryReference,
) {
  await ledger.update((value) =>
    reference.kind === "create"
      ? { ...value, createReference: reference }
      : reference.kind === "destroy"
        ? { ...value, destroyReference: reference }
        : {
            ...value,
            operationReferences: operationCheckpoints(value.operationReferences, reference),
          },
  );
}
