import {
  AdapterSandbox,
  Image,
  SandbarError,
  type AdapterDirectClient,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { LedgerStore } from "./ledger";
import type { Scenario } from "./report";

export type ConnectionFactory = (
  onReference: (reference: AdapterRecoveryReference) => Promise<void>,
) => Promise<AdapterDirectClient>;

export type Step = {
  scenario: Scenario;
  status: "passed" | "failed" | "not-run" | "unsupported" | "blocked";
  issue?: string;
};

export async function recordReference(
  ledger: LedgerStore,
  reference: AdapterRecoveryReference,
): Promise<void> {
  await ledger.update((value) => {
    if (reference.kind === "create") return { ...value, createReference: reference };

    if (reference.kind === "destroy") return { ...value, destroyReference: reference };

    return { ...value, operationReferences: [...(value.operationReferences ?? []), reference] };
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught provider errors are narrowed to SandbarError before reading a code.
function outcome(error: unknown): Step["status"] {
  return error instanceof SandbarError && error.code === "UNSUPPORTED" ? "unsupported" : "failed";
}

/** One borrowed prepared image and at most one created sandbox. No mutation is retried. */
export async function runPrepared(
  factory: ConnectionFactory,
  ledger: LedgerStore,
  imageId: string,
  options: { network: string; region?: string; cleanupWaitMs?: number; signal?: AbortSignal },
): Promise<Step[]> {
  const steps: Step[] = [];
  let client: AdapterDirectClient | undefined;
  let box: AdapterSandbox | undefined;
  let createFailed = false;

  const step = async (scenario: Scenario, work: () => Promise<void>) => {
    if (options.signal?.aborted && scenario !== "close") {
      steps.push({ scenario, status: "blocked", issue: "interrupted" });

      return;
    }

    try {
      await work();
      steps.push({ scenario, status: "passed" });
    } catch (error) {
      steps.push({
        scenario,
        status: outcome(error),
        issue: error instanceof SandbarError ? error.code : "assertion-failed",
      });
    }
  };

  try {
    await step("connect", async () => {
      client = await factory((reference) => recordReference(ledger, reference));
    });

    if (!client) return steps;
    const connected = client;
    await ledger.update((value) => ({ ...value, createIntent: true }));
    await step("create-prepared", async () => {
      box = await connected.sandboxes.create(
        {
          environment: Image.prepared(imageId),
          networkPolicy: options.network,
          region: options.region,
          labels: { "sandbar.qualification.run": ledger.runId },
        },
        { signal: options.signal },
      );
      await ledger.update((value) => ({ ...value, sandboxId: box!.id }));
    });

    if (!box) {
      createFailed = true;

      return steps;
    }

    const sandbox = box;
    await step("inspect", async () => {
      if ((await sandbox.inspect()).state !== "running") throw new Error("Not running");
    });
    await step("exec-argv", async () => {
      const result = await sandbox.exec(
        {
          command: {
            kind: "argv",
            argv: [
              "/bin/sh",
              "-c",
              'printf \'%s|%s\' "$1" "$QUAL_VALUE"; printf err >&2',
              "_",
              "argument with spaces",
            ],
          },
          cwd: "/tmp",
          env: { QUAL_VALUE: "argv-ok" },
          deadlineSeconds: 20,
          maxOutputBytes: 4096,
        },
        { signal: options.signal },
      );

      if (result.stdoutText() !== "argument with spaces|argv-ok" || result.stderrText() !== "err")
        throw new Error("Output mismatch");
    });
    await step("exec-shell", async () => {
      const result = await sandbox.exec(
        {
          command: { kind: "shell", script: "printf '%s' \"$QUAL_VALUE\"" },
          cwd: "/tmp",
          env: { QUAL_VALUE: "shell-ok" },
          deadlineSeconds: 20,
          maxOutputBytes: 4096,
        },
        { signal: options.signal },
      );

      if (result.stdoutText() !== "shell-ok") throw new Error("Output mismatch");
    });
    await step("exec-nonzero", async () => {
      try {
        await sandbox.exec(
          { command: { kind: "shell", script: "printf fail >&2; exit 7" }, deadlineSeconds: 20 },
          { signal: options.signal },
        );
        throw new Error("Nonzero command unexpectedly passed");
      } catch (error) {
        if (
          !(error instanceof SandbarError) ||
          error.code !== "NONZERO_EXIT" ||
          error.name !== "NonzeroExitError"
        )
          throw error;
      }
    });
    const path = `/tmp/sandbar-qualification-${ledger.runId}`;
    const first = new Uint8Array([0, 255, 1, 128]);
    const second = new Uint8Array([2, 254, 0]);
    await step("file-binary", async () => {
      await sandbox.writeFile(path, first, { overwrite: true, signal: options.signal });

      if (!equal(await sandbox.readFile(path), first)) throw new Error("File bytes differ");
    });
    await step("file-overwrite", async () => {
      await sandbox.writeFile(path, second, { overwrite: true, signal: options.signal });

      if (!equal(await sandbox.readFile(path), second)) throw new Error("Overwrite bytes differ");
    });
    await step("file-no-clobber", async () => {
      try {
        await sandbox.writeFile(path, first, { overwrite: false, signal: options.signal });
        throw new Error("No-clobber unexpectedly passed");
      } catch (error) {
        if (!(error instanceof SandbarError) || error.code !== "CONFLICT") throw error;
      }

      if (!equal(await sandbox.readFile(path), second)) throw new Error("Conflict changed file");
    });
    await step("inventory", async () => {
      let cursor: string | undefined;

      for (let page = 0; page < 10; page++) {
        const listed = await connected.operations.inventory({ limit: 100, cursor });

        if (listed.items.some((item) => item.id === sandbox.id && item.state === "running")) return;
        cursor = listed.nextCursor;

        if (!cursor) break;
      }

      throw new Error("Owned sandbox absent from bounded inventory");
    });
  } finally {
    if (client) {
      try {
        const result = await reconcile(
          publicCleanupAccess(client),
          ledger,
          options.cleanupWaitMs ?? 60_000,
        );

        steps.push(...result);
      } catch {
        steps.push(
          { scenario: "destroy", status: "failed", issue: "cleanup-failed" },
          { scenario: "confirm-cleanup", status: "blocked", issue: "cleanup-unconfirmed" },
        );
      } finally {
        await step("close", () => client!.close());
      }
    }

    if (createFailed)
      for (const scenario of [
        "inspect",
        "exec-argv",
        "exec-shell",
        "exec-nonzero",
        "file-binary",
        "file-overwrite",
        "file-no-clobber",
        "inventory",
      ] as const)
        steps.push({ scenario, status: "blocked", issue: "dependency-failed" });
  }

  return steps;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type CleanupAccess = {
  verifyReference(reference: AdapterRecoveryReference): Promise<void>;
  observeCreate(reference: AdapterRecoveryReference): Promise<{ id: string } | null>;
  observeDestroy(reference: AdapterRecoveryReference): Promise<void>;
  sandbox(id: string): Pick<AdapterSandbox, "inspect" | "destroy">;
};

export function publicCleanupAccess(client: AdapterDirectClient): CleanupAccess {
  return {
    async verifyReference(reference) {
      await client.recover(reference);
    },
    async observeCreate(reference) {
      const result = await (await client.recover(reference)).observe();

      return result instanceof AdapterSandbox ? { id: result.id } : null;
    },
    async observeDestroy(reference) {
      await (await client.recover(reference)).observe();
    },
    sandbox(id) {
      return new AdapterSandbox(client, id);
    },
  };
}

/** Safe to invoke after a process crash. Only the create reference for this run is eligible. */
export async function reconcile(
  access: CleanupAccess,
  ledger: LedgerStore,
  waitMs = 60_000,
): Promise<Step[]> {
  const state = await ledger.read();

  if (!state.createIntent)
    return [
      { scenario: "destroy", status: "not-run" },
      { scenario: "confirm-cleanup", status: "not-run" },
    ];

  if (state.cleanup === "confirmed")
    return [
      { scenario: "destroy", status: "passed" },
      { scenario: "confirm-cleanup", status: "passed" },
    ];

  if (!state.createReference) {
    await ledger.update((value) => ({
      ...value,
      cleanup: "unresolved",
      lastIssue: "outcome-unknown",
    }));

    return [
      { scenario: "destroy", status: "blocked", issue: "outcome-unknown" },
      { scenario: "confirm-cleanup", status: "blocked", issue: "outcome-unknown" },
    ];
  }

  let id = state.sandboxId;

  try {
    await access.verifyReference(state.createReference);

    if (!id) {
      const result = await access.observeCreate(state.createReference);

      if (result) {
        id = result.id;
        await ledger.update((value) => ({ ...value, sandboxId: id }));
      }
    }

    if (!id) throw new Error("Create outcome remains unknown");
    const box = access.sandbox(id);

    if ((await box.inspect()).state === "destroyed") {
      await ledger.update((value) => ({ ...value, cleanup: "confirmed", lastIssue: undefined }));

      return [
        { scenario: "destroy", status: "passed" },
        { scenario: "confirm-cleanup", status: "passed" },
      ];
    }

    if (state.destroyReference) await access.observeDestroy(state.destroyReference);
    else await box.destroy();
    const deadline = Date.now() + waitMs;

    while (Date.now() <= deadline) {
      if ((await box.inspect()).state === "destroyed") {
        await ledger.update((value) => ({ ...value, cleanup: "confirmed", lastIssue: undefined }));

        return [
          { scenario: "destroy", status: "passed" },
          { scenario: "confirm-cleanup", status: "passed" },
        ];
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
    }

    await ledger.update((value) => ({
      ...value,
      cleanup: "unresolved",
      lastIssue: "confirmation-failed",
    }));

    return [
      { scenario: "destroy", status: "blocked", issue: "cleanup-unconfirmed" },
      { scenario: "confirm-cleanup", status: "failed", issue: "cleanup-unconfirmed" },
    ];
  } catch {
    await ledger.update((value) => ({
      ...value,
      cleanup: "unresolved",
      lastIssue: id ? "cleanup-failed" : "outcome-unknown",
    }));

    return [
      {
        scenario: "destroy",
        status: id ? "failed" : "blocked",
        issue: id ? "cleanup-failed" : "outcome-unknown",
      },
      { scenario: "confirm-cleanup", status: "blocked", issue: "cleanup-unconfirmed" },
    ];
  }
}
