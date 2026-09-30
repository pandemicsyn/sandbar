import {
  Image,
  AdapterSandbox,
  AdapterVolume,
  AdapterSnapshot,
  OutcomeUnknownError,
  WaitAbortedError,
  SandbarError,
  type AdapterDirectClient,
  type AdapterOperation,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { z } from "zod";
import type { MountSpec } from "sandbar-adapter";
import type { ConnectionFactory } from "../../provider-qualification/connection";
import { LedgerStore } from "../../provider-qualification/ledger";
import { boundedRead } from "../../provider-qualification/bounds";
import { cleanupOwned, cleanupCompute, partialResource } from "./cleanup";

const creators = new Set(["create", "snapshot_capture", "snapshot_restore", "volume_create"]);

const computeKinds = new Set(["create", "snapshot_restore"]);

/** Test-owned resources only. Bun owns test execution, assertion failures and reporting. */
export class TestResources {
  client!: AdapterDirectClient;
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private role = "setup";
  private cleaning = false;
  private timer: ReturnType<typeof setTimeout>;
  private release = () => {};
  private lease?: Promise<void>;
  private opened = false;
  private opening?: Promise<AdapterDirectClient>;
  private readonly releaseErrors: unknown[] = [];

  constructor(
    readonly factory: ConnectionFactory,
    readonly ledger: LedgerStore,
    readonly imageId: string,
    readonly network: string,
    readonly bounds: {
      compute: number;
      snapshots: number;
      volumes: number;
      exerciseMs: number;
      cleanupMs: number;
    },
    private readonly initial?: {
      provider: string;
      connection: import("../../provider-qualification/ledger").RunLedger["connection"];
    },
  ) {
    this.signal = this.controller.signal;
    this.timer = setTimeout(
      () => this.controller.abort("Integration exercise time limit"),
      bounds.exerciseMs,
    );
  }

  async open() {
    const acquired = new Promise<void>((resolve, reject) => {
      this.lease = this.ledger
        .withAdmissionLock(async () => {
          if (this.cleaning) throw Error("Setup was cancelled before admission");

          if (this.initial) {
            await this.ledger.requirePreviousCleanup(this.initial.provider);
            await this.ledger.initialize(
              this.initial.provider,
              { kind: "borrowed-prepared", class: "prepared" },
              this.initial.connection,
            );
          }

          const previous = await this.ledger.read();

          if (this.cleaning) throw Error("Setup was cancelled before connection");
          await this.ledger.requirePreviousCleanup(previous.provider);

          if (previous.stateMutations?.length)
            throw new Error("Existing custody must be reconciled first");
          await this.ledger.update((value) => ({
            ...value,
            stateMode: "live-state",
            stateMutations: [],
            cleanup: "pending",
          }));

          if (this.cleaning) throw Error("Setup was cancelled before connection");

          const held = new Promise<void>((release) => {
            this.release = release;
          });

          resolve();
          await held;
        })
        .catch(reject);
    });

    await acquired;
    this.opened = true;
    await this.reconnect(AbortSignal.any([this.signal, AbortSignal.timeout(30000)]));

    return this;
  }

  async setup<T>(work: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => this.controller.abort("Integration setup time limit"), 30000);

    try {
      return await boundedRead(work(), this.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private journal = async (reference: AdapterRecoveryReference) => {
    const state = await this.ledger.read();
    const entries = state.stateMutations ?? [];

    const existing = entries.find(
      (entry) =>
        z.object({ submissionId: z.string() }).parse(entry.reference).submissionId ===
        reference.submissionId,
    );

    const creation = creators.has(reference.kind);

    if (creation && !existing) {
      this.signal.throwIfAborted();

      if (this.cleaning) throw new Error("Teardown forbids new allocations");
      const creations = entries.filter((entry) => entry.creation);

      const count = (kinds: Set<string>) =>
        creations.filter((entry) =>
          kinds.has(z.object({ kind: z.string() }).parse(entry.reference).kind),
        ).length;

      if (
        computeKinds.has(reference.kind) &&
        (count(computeKinds) >= this.bounds.compute ||
          creations.filter(
            (entry) =>
              computeKinds.has(z.object({ kind: z.string() }).parse(entry.reference).kind) &&
              entry.cleanup === "pending",
          ).length >= 2)
      )
        throw new Error("Compute allocation/concurrency budget exhausted");

      if (
        reference.kind === "snapshot_capture" &&
        count(new Set([reference.kind])) >= this.bounds.snapshots
      )
        throw new Error("Snapshot budget exhausted");

      if (
        reference.kind === "volume_create" &&
        count(new Set([reference.kind])) >= this.bounds.volumes
      )
        throw new Error("Volume budget exhausted");
    }

    if (existing) await this.ledger.saveStateReference(reference);
    else
      await this.ledger.update((value) => ({
        ...value,
        stateRole: this.role,
        stateMutations: [
          ...(value.stateMutations ?? []),
          {
            role: this.role,
            reference,
            creation,
            cleanup: creation ? "pending" : "not-required",
          },
        ],
      }));
  };

  async reconnect(signal = this.signal) {
    signal.throwIfAborted();

    if (this.client) await this.client.close();

    const opening = this.factory(this.journal, (error) => {
      this.releaseErrors.push(error);
    });

    this.opening = opening;
    opening.then(
      (client) => {
        if ((this.cleaning || signal.aborted) && this.client !== client)
          void client.close().catch((error) => {
            this.releaseErrors.push(error);
          });
      },
      () => {},
    );
    this.client = await boundedRead(opening, signal);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK generic results are narrowed to public resource handles before retaining custody.
  private async save(reference: AdapterRecoveryReference, value?: unknown, noEffect = false) {
    const capture = z.object({ snapshot: z.instanceof(AdapterSnapshot) }).safeParse(value);

    const resource =
      value instanceof AdapterVolume
        ? value.reference
        : capture.success
          ? capture.data.snapshot.reference
          : partialResource(reference);

    await this.ledger.update((state) => ({
      ...state,
      stateMutations: state.stateMutations?.map((entry) => {
        if (
          z.object({ submissionId: z.string() }).parse(entry.reference).submissionId !==
          reference.submissionId
        )
          return entry;

        if (value instanceof AdapterSandbox) return { ...entry, reference, sandboxId: value.id };

        if (resource) return { ...entry, reference, resource };

        if (noEffect && entry.creation && !entry.resource && !entry.sandboxId)
          return { ...entry, reference, cleanup: "not-required" };

        return { ...entry, reference };
      }),
    }));
  }

  async wait<T>(operation: AdapterOperation<T>): Promise<T> {
    try {
      const value = await operation.wait({ signal: this.signal, pollMs: 200 });
      await this.save(operation.reference, value);

      return value;
    } catch (error) {
      await this.save(
        (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError) &&
          error.reference.mode === "direct"
          ? error.reference
          : operation.reference,
        undefined,
        error instanceof SandbarError && error.effect === "none",
      );
      throw error;
    }
  }

  at(role: string) {
    this.signal.throwIfAborted();
    this.role = role;
  }

  async create(role: string, mounts?: MountSpec[], network = this.network) {
    this.at(role);

    return this.wait(
      await this.client.sandboxes.submitCreate(
        { environment: Image.prepared(this.imageId), networkPolicy: network, mounts },
        { signal: this.signal },
      ),
    );
  }

  async volume() {
    this.at("volume/create");

    return this.wait(
      await this.client.volumes.submitCreate(
        { name: `sandbar-${this.ledger.runId.replaceAll("-", "")}` },
        { signal: this.signal },
      ),
    );
  }

  read(box: AdapterSandbox, path: string) {
    return boundedRead(box.readFile(path), this.signal);
  }

  async exec(box: AdapterSandbox, script: string) {
    const output = await box.exec(
      { command: { kind: "shell", script }, deadlineSeconds: 10, maxOutputBytes: 512 },
      { signal: this.signal },
    );

    if (output.exitCode !== 0 || output.truncated)
      throw new Error("Guest probe did not complete cleanly");

    return output.stdoutText(512);
  }

  async destroy(role: string) {
    await cleanupCompute(
      this.client,
      this.ledger,
      role,
      () => {
        this.role = `${role}/delete`;
      },
      this.bounds.cleanupMs,
      this.signal,
    );
  }

  async close() {
    this.cleaning = true;
    clearTimeout(this.timer);
    this.controller.abort("Test finished; no further allocations");

    try {
      if (!this.client && this.opening) {
        try {
          this.client = await boundedRead(this.opening, AbortSignal.timeout(5000));
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError")
            this.releaseErrors.push(error);
        }
      }

      if (this.opened && this.client)
        await cleanupOwned(this.client, this.ledger, this.bounds.cleanupMs, (role) => {
          this.role = role;
        });
      else if (this.opened)
        await this.ledger.update((value) => ({
          ...value,
          cleanup: value.stateMutations?.some((entry) => entry.creation)
            ? "unresolved"
            : "not-required",
        }));
    } finally {
      try {
        if (this.client) await boundedRead(this.client.close(), AbortSignal.timeout(5000));
      } finally {
        this.release();
        await this.lease;
      }
    }

    if (this.releaseErrors.length)
      throw new Error("SDK release failed", { cause: this.releaseErrors[0] });
  }
}
