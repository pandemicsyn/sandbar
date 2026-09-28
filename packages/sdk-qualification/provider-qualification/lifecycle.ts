import {
  AdapterSandbox,
  Image,
  SandbarError,
  OutcomeUnknownError,
  WaitAbortedError,
  type AdapterDirectClient,
  type AdapterRecoveryReference,
} from "sandbar-sdk";
import { LedgerStore } from "./ledger";
import type { Scenario } from "./report";
import { boundedRead } from "./bounds";
import {
  FailureCapture,
  envdSchema,
  errorDiagnostic,
  sensitiveValues,
  type FailureDiagnostic,
} from "./diagnostics";

export type ConnectionFactory = (
  onReference: (reference: AdapterRecoveryReference) => Promise<void>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the public SDK external-error diagnostic boundary; the callback performs field-only redaction.
  onDiagnostic?: (error: unknown) => void,
) => Promise<AdapterDirectClient>;

export type Step = {
  scenario: Scenario;
  status: "passed" | "failed" | "not-run" | "unsupported" | "blocked";
  issue?: string;
  diagnostic?: FailureDiagnostic;
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only public SDK recovery errors expose a validated reference.
async function recordRecoveryError(ledger: LedgerStore, error: unknown): Promise<void> {
  if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError) {
    const reference = error.reference;

    if (reference.mode === "direct") await recordReference(ledger, reference);
  }
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
  options: {
    network: string;
    region?: string;
    cleanupWaitMs?: number;
    signal?: AbortSignal;
    selectedScenarios?: ReadonlySet<Scenario>;
    redactions?: readonly string[];
    envdVersion?: (ownedSandboxId: string, signal?: AbortSignal) => Promise<string | undefined>;
  },
): Promise<Step[]> {
  return ledger.withLock(() => runPreparedLocked(factory, ledger, imageId, options));
}

async function runPreparedLocked(
  factory: ConnectionFactory,
  ledger: LedgerStore,
  imageId: string,
  options: Parameters<typeof runPrepared>[3],
): Promise<Step[]> {
  const steps: Step[] = [];
  let client: AdapterDirectClient | undefined;
  let box: AdapterSandbox | undefined;
  let createFailed = false;
  const diagnosticJobs: Promise<FailureDiagnostic>[] = [];
  const releaseErrors: unknown[] = [];

  const step = async (
    scenario: Scenario,
    work: (capture: FailureCapture) => Promise<void>,
    prerequisites: readonly Scenario[] = [],
  ) => {
    if (
      options.selectedScenarios &&
      !options.selectedScenarios.has(scenario) &&
      scenario !== "connect" &&
      scenario !== "create-prepared" &&
      scenario !== "close"
    ) {
      steps.push({ scenario, status: "not-run", issue: "not-selected" });

      return;
    }

    if (
      prerequisites.some(
        (id) => !steps.some((entry) => entry.scenario === id && entry.status === "passed"),
      )
    ) {
      steps.push({ scenario, status: "blocked", issue: "dependency-failed" });

      return;
    }

    if (options.signal?.aborted && scenario !== "close") {
      steps.push({ scenario, status: "blocked", issue: "interrupted" });

      return;
    }

    const stage =
      scenario === "create-prepared"
        ? "create"
        : scenario.startsWith("exec-")
          ? "exec"
          : scenario.startsWith("file-")
            ? "write"
            : scenario === "connect" ||
                scenario === "inspect" ||
                scenario === "inventory" ||
                scenario === "close"
              ? scenario
              : "checkpoint";

    const capture = new FailureCapture(ledger, scenario, stage, options.redactions);

    try {
      await work(capture);
      steps.push({ scenario, status: "passed" });
    } catch (error) {
      const diagnostic = await capture.failure(error);
      await recordRecoveryError(ledger, error);
      steps.push({
        scenario,
        status: outcome(error),
        issue: error instanceof SandbarError ? error.code : "assertion-failed",
        diagnostic,
      });
    }
  };

  try {
    await step("connect", async () => {
      const opening = factory(
        (reference) => recordReference(ledger, reference),
        (error) => {
          releaseErrors.push(error);
          diagnosticJobs.push(
            new FailureCapture(ledger, "close", "close", options.redactions).failure(error),
          );
        },
      );

      try {
        client = await boundedRead(opening, options.signal);
      } catch (error) {
        // A late read-only connection must close; no create may follow an interrupted connect.
        void opening.then((connected) => connected.close()).catch(() => undefined);
        throw error;
      }
    });

    if (!client) return steps;
    const connected = client;
    await ledger.update((value) => ({ ...value, createIntent: true }));
    await step("create-prepared", async (capture) => {
      box = await connected.sandboxes.create(
        {
          environment: Image.prepared(imageId),
          networkPolicy: options.network,
          region: options.region,
          labels: { "sandbar.qualification.run": ledger.runId },
        },
        { signal: options.signal },
      );
      capture.at("checkpoint");
      await ledger.update((value) => ({ ...value, sandboxId: box!.id }));
    });

    if (!box) {
      createFailed = true;

      return steps;
    }

    const sandbox = box;

    if (options.envdVersion) {
      let envd;

      try {
        const version = await boundedRead(
          options.envdVersion(sandbox.id, options.signal),
          options.signal,
        );

        envd = envdSchema.parse(
          version === undefined ? { status: "unavailable" } : { status: "available", version },
        );
      } catch (error) {
        envd = {
          status: "unavailable" as const,
          error: errorDiagnostic(error, await sensitiveValues(ledger, options.redactions ?? [])),
        };
      }

      await ledger.update((value) => ({ ...value, envd }));
    }

    await step("inspect", async (capture) => {
      const state = (await boundedRead(sandbox.inspect(), options.signal)).state;
      capture.state(state, "running");

      if (state !== "running") throw new Error("Not running");
    });
    await step("exec-argv", async (capture) => {
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

      capture.output(result, "argument with spaces|argv-ok", "err");

      if (result.stdoutText() !== "argument with spaces|argv-ok" || result.stderrText() !== "err")
        throw new Error("Output mismatch");
    });
    await step("exec-shell", async (capture) => {
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

      capture.output(result, "shell-ok", "");

      if (result.stdoutText() !== "shell-ok") throw new Error("Output mismatch");
    });
    await step("exec-nonzero", async (capture) => {
      try {
        const result = await sandbox.exec(
          { command: { kind: "shell", script: "printf fail >&2; exit 7" }, deadlineSeconds: 20 },
          { signal: options.signal },
        );

        capture.output(result, "", "fail");
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
    await step("file-binary", async (capture) => {
      capture.file(first, true);
      await sandbox.writeFile(path, first, { overwrite: true, signal: options.signal });
      capture.at("read");
      const actual = await boundedRead(sandbox.readFile(path), options.signal);
      capture.compareBytes(actual, first);
    });
    await step(
      "file-overwrite",
      async (capture) => {
        capture.file(second, true);
        await sandbox.writeFile(path, second, { overwrite: true, signal: options.signal });
        capture.at("read");
        const actual = await boundedRead(sandbox.readFile(path), options.signal);
        capture.compareBytes(actual, second);
      },
      ["file-binary"],
    );
    await step(
      "file-no-clobber",
      async (capture) => {
        capture.file(first, false);

        try {
          await sandbox.writeFile(path, first, { overwrite: false, signal: options.signal });
          throw new Error("No-clobber unexpectedly passed");
        } catch (error) {
          if (!(error instanceof SandbarError) || error.code !== "CONFLICT") throw error;
        }

        capture.at("read");
        const actual = await boundedRead(sandbox.readFile(path), options.signal);
        capture.compareBytes(actual, second);
      },
      ["file-binary", "file-overwrite"],
    );
    await step("inventory", async (capture) => {
      let cursor: string | undefined;

      for (let page = 0; page < 10; page++) {
        const listed = await boundedRead(
          connected.operations.inventory({ limit: 100, cursor }),
          options.signal,
        );

        const found = listed.items.some(
          (item) => item.id === sandbox.id && item.state === "running",
        );

        capture.inventory(page + 1, listed.items.length, found);

        if (found) return;
        cursor = listed.nextCursor;

        if (!cursor) break;
      }

      throw new Error("Owned sandbox absent from bounded inventory");
    });
  } finally {
    if (client) {
      try {
        const result = await reconcileLocked(
          publicCleanupAccess(client, ledger),
          ledger,
          options.cleanupWaitMs ?? 60_000,
          options.redactions,
        );

        steps.push(...result);
      } catch (error) {
        const diagnostic = await new FailureCapture(
          ledger,
          "destroy",
          "checkpoint",
          options.redactions,
        ).failure(error);

        steps.push(
          { scenario: "destroy", status: "failed", issue: "cleanup-failed", diagnostic },
          { scenario: "confirm-cleanup", status: "blocked", issue: "cleanup-unconfirmed" },
        );
      } finally {
        await step("close", async () => {
          await client!.close();
          await Promise.all(diagnosticJobs);

          if (releaseErrors.length)
            throw new Error("SDK connection release failed", { cause: releaseErrors[0] });
        });
      }
    } else if (!(await ledger.read()).createReference) {
      await ledger.update((value) => ({ ...value, cleanup: "not-required", lastIssue: undefined }));
      steps.push(
        { scenario: "destroy", status: "not-run" },
        { scenario: "confirm-cleanup", status: "not-run" },
      );
    }

    await Promise.all(diagnosticJobs);

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

export type CleanupAccess = {
  verifyReference(reference: AdapterRecoveryReference): Promise<void>;
  observeCreate(
    reference: AdapterRecoveryReference,
    signal?: AbortSignal,
  ): Promise<{ id: string } | null>;
  observeDestroy(reference: AdapterRecoveryReference, signal?: AbortSignal): Promise<boolean>;
  sandbox(id: string): Pick<AdapterSandbox, "inspect" | "destroy">;
};

export function publicCleanupAccess(
  client: AdapterDirectClient,
  ledger?: LedgerStore,
): CleanupAccess {
  return {
    async verifyReference(reference) {
      await client.recover(reference);
    },
    async observeCreate(reference, signal) {
      const result = await boundedRead((await client.recover(reference)).observe(), signal);

      return result instanceof AdapterSandbox ? { id: result.id } : null;
    },
    async observeDestroy(reference, signal) {
      const operation = await client.recover(reference);

      try {
        // The SDK decodes confirmed compute termination as undefined; pending is null.
        return (await boundedRead(operation.observe(), signal)) === undefined;
      } finally {
        if (ledger) await recordReference(ledger, operation.reference);
      }
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
  redactions: readonly string[] = [],
): Promise<Step[]> {
  return ledger.withLock(() => reconcileLocked(access, ledger, waitMs, redactions));
}

/** Standalone recovery acquires the same run lock before authenticating or reading the provider. */
export async function reconcileConnection(
  factory: ConnectionFactory,
  ledger: LedgerStore,
  waitMs = 60_000,
  redactions: readonly string[] = [],
): Promise<Step[]> {
  return ledger.withLock(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("cleanup connection time limit"), waitMs);
    const deadline = Date.now() + waitMs;
    const releaseErrors: unknown[] = [];
    const diagnosticJobs: Promise<FailureDiagnostic>[] = [];

    const opening = factory(
      (reference) => recordReference(ledger, reference),
      (error) => {
        releaseErrors.push(error);
        diagnosticJobs.push(
          new FailureCapture(ledger, "close", "close", redactions).failure(error),
        );
      },
    );

    let client: AdapterDirectClient;

    try {
      client = await boundedRead(opening, controller.signal);
    } catch (error) {
      void opening.then((connected) => connected.close()).catch(() => undefined);

      const diagnostic = await new FailureCapture(ledger, "connect", "connect", redactions).failure(
        error,
      );

      return [{ scenario: "connect", status: "failed", issue: "assertion-failed", diagnostic }];
    } finally {
      clearTimeout(timer);
    }

    const steps: Step[] = [];

    try {
      steps.push(
        ...(await reconcileLocked(
          publicCleanupAccess(client, ledger),
          ledger,
          Math.max(1, deadline - Date.now()),
          redactions,
        )),
      );
    } finally {
      try {
        await client.close();
        await Promise.all(diagnosticJobs);

        if (releaseErrors.length) {
          const diagnostic = await new FailureCapture(ledger, "close", "close", redactions).failure(
            new Error("SDK connection release failed", { cause: releaseErrors[0] }),
          );

          steps.push({ scenario: "close", status: "failed", issue: "close-failed", diagnostic });
        } else {
          steps.push({ scenario: "close", status: "passed" });
        }
      } catch (error) {
        const diagnostic = await new FailureCapture(ledger, "close", "close", redactions).failure(
          error,
        );

        steps.push({ scenario: "close", status: "failed", issue: "close-failed", diagnostic });
      }
    }

    return steps;
  });
}

async function reconcileLocked(
  access: CleanupAccess,
  ledger: LedgerStore,
  waitMs: number,
  redactions: readonly string[] = [],
): Promise<Step[]> {
  const state = await ledger.read();
  const capture = new FailureCapture(ledger, "destroy", "checkpoint", redactions);

  // The awaited pre-submit checkpoint must exist before a native create can be dispatched.
  if (!state.createReference) {
    await ledger.update((value) => ({ ...value, cleanup: "not-required", lastIssue: undefined }));

    return [
      { scenario: "destroy", status: "not-run" },
      { scenario: "confirm-cleanup", status: "not-run" },
    ];
  }

  if (state.cleanup === "confirmed")
    return [
      { scenario: "destroy", status: "passed" },
      { scenario: "confirm-cleanup", status: "passed" },
    ];

  let id = state.sandboxId;
  const controller = new AbortController();
  const signal = waitMs > 0 ? controller.signal : undefined;

  const timer =
    waitMs > 0 ? setTimeout(() => controller.abort("cleanup time limit"), waitMs) : undefined;

  const deadline = Date.now() + waitMs;

  try {
    await access.verifyReference(state.createReference);

    if (!id) {
      capture.at("recover-create");
      const result = await access.observeCreate(state.createReference, signal);

      if (result) {
        id = result.id;
        await ledger.update((value) => ({ ...value, sandboxId: id }));
      }
    }

    if (!id) throw new Error("Create outcome remains unknown");
    const box = access.sandbox(id);

    capture.at("inspect");

    if ((await boundedRead(box.inspect(), signal)).state === "destroyed") {
      await ledger.update((value) => ({ ...value, cleanup: "confirmed", lastIssue: undefined }));

      return [
        { scenario: "destroy", status: "passed" },
        { scenario: "confirm-cleanup", status: "passed" },
      ];
    }

    let terminationConfirmed = false;
    capture.at("destroy");

    if (state.destroyReference) {
      if (state.destroyReference.kind !== "destroy" || state.destroyReference.sandboxId !== id)
        throw new Error("Saved destroy does not belong to the owned sandbox");
      terminationConfirmed = await access.observeDestroy(state.destroyReference, signal);
    } else {
      // Public destroy resolves only for a correlated computeStopped completion.
      await box.destroy({ signal });
      terminationConfirmed = true;
    }

    if (terminationConfirmed) {
      await ledger.update((value) => ({ ...value, cleanup: "confirmed", lastIssue: undefined }));

      return [
        { scenario: "destroy", status: "passed" },
        { scenario: "confirm-cleanup", status: "passed" },
      ];
    }

    capture.at("confirm-cleanup");

    while (Date.now() < deadline) {
      const current = await ledger.read();

      const confirmed = current.destroyReference
        ? await access.observeDestroy(current.destroyReference, signal)
        : false;

      if (confirmed || (await boundedRead(box.inspect(), signal)).state === "destroyed") {
        await ledger.update((value) => ({ ...value, cleanup: "confirmed", lastIssue: undefined }));

        return [
          { scenario: "destroy", status: "passed" },
          { scenario: "confirm-cleanup", status: "passed" },
        ];
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) break;
      await boundedRead(
        new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining))),
        signal,
      );
    }

    await ledger.update((value) => ({
      ...value,
      cleanup: "unresolved",
      lastIssue: "confirmation-failed",
    }));

    const diagnostic = await capture.failure(new Error("Cleanup confirmation timed out"));

    return [
      { scenario: "destroy", status: "blocked", issue: "cleanup-unconfirmed", diagnostic },
      { scenario: "confirm-cleanup", status: "failed", issue: "cleanup-unconfirmed", diagnostic },
    ];
  } catch (error) {
    const diagnostic = await capture.failure(error);
    await recordRecoveryError(ledger, error);
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
        diagnostic,
      },
      { scenario: "confirm-cleanup", status: "blocked", issue: "cleanup-unconfirmed" },
    ];
  } finally {
    clearTimeout(timer);
  }
}
