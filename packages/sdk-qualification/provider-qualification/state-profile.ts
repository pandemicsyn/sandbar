import { z } from "zod";
import {
  AdapterSandbox,
  AdapterSnapshot,
  AdapterVolume,
  SandbarError,
  OutcomeUnknownError,
  WaitAbortedError,
  Image,
  ResourceReference,
  type AdapterDirectClient,
  type AdapterRecoveryReference,
  type AdapterOperation,
} from "sandbar-sdk";
import { AdapterError, SnapshotInfo, assertResourceScope } from "sandbar-adapter";
import { LedgerStore } from "./ledger";
import { FailureCapture } from "./diagnostics";
import { boundedRead } from "./bounds";
import { type ConnectionFactory, type Step } from "./lifecycle";
import { snapshotProbe, volumeProbe, type StateEvidence } from "./state-evidence";

function partialResource(reference: AdapterRecoveryReference) {
  if (reference.kind === "volume_create") {
    const parsed = z
      .object({ state: z.literal("accepted"), volume: ResourceReference })
      .safeParse(reference.token);

    if (
      !parsed.success ||
      parsed.data.volume.kind !== "volume" ||
      parsed.data.volume.ownership !== "verified-created"
    )
      return undefined;
    assertResourceScope(parsed.data.volume, {
      provider: reference.provider,
      scope: reference.scope,
    });

    return parsed.data.volume;
  }

  if (reference.kind !== "snapshot_capture") return undefined;

  const token = z
    .union([
      z.object({
        captureState: z.enum(["accepted", "completed", "failed"]),
        snapshot: SnapshotInfo,
      }),
      z.object({ snapshot: ResourceReference }),
    ])
    .safeParse(reference.token);

  if (!token.success) return undefined;

  const resource =
    "reference" in token.data.snapshot ? token.data.snapshot.reference : token.data.snapshot;

  if (resource.kind !== "snapshot" || resource.ownership !== "verified-created") return undefined;
  assertResourceScope(resource, {
    provider: reference.provider,
    scope: reference.scope,
  });

  return resource;
}

function captureInProgress(reference: AdapterRecoveryReference) {
  const parsed = z
    .object({
      provider: z.literal("daytona"),
      kind: z.literal("snapshot_capture"),
      token: z.object({ captureState: z.string() }),
    })
    .safeParse(reference);

  return parsed.success && !["completed", "failed"].includes(parsed.data.token.captureState);
}

const processAbsent = `python3 -c 'import errno,socket
s=socket.socket(socket.AF_UNIX);s.settimeout(1)
try:
 s.connect("/tmp/sandbar-memory.sock");print("PROCESS_PRESENT")
except OSError as e:
 if e.errno not in (errno.ENOENT,errno.ECONNREFUSED,errno.ECONNRESET): raise
 print("PROCESS_ABSENT")
finally: s.close()'`;

type StateScenario = "snapshot-roundtrip" | "volume-persistence";

const bytes = new Uint8Array([0, 255, 10, 83, 97, 110, 100, 98, 97, 114]);

const sourceChanged = new Uint8Array([1, 2, 3]);

const restoredChanged = new Uint8Array([4, 5, 6]);

function equal(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
    throw new Error("State bytes differ");
}

const creationKinds = ["create", "snapshot_capture", "snapshot_restore", "volume_create"];

const memoryProgram = `import os,socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.bind('/tmp/sandbar-memory.sock')
s.listen(2)
s.settimeout(240)
nonce=os.urandom(16).hex()
count=0
while True:
 c,_=s.accept()
 count+=1
 c.sendall((nonce+':'+str(count)).encode())
 c.close()
`;

const memoryRead = `python3 -c 'import socket;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(3);s.connect("/tmp/sandbar-memory.sock");print(s.recv(128).decode());s.close()'`;

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function memorySample(value: string) {
  const match = /^([0-9a-f]{32}):(\d+)\n$/.exec(value);

  if (!match) throw new Error("Missing bounded memory observation");

  return { nonce: match[1]!, count: Number(match[2]) };
}

export async function runState(
  factory: ConnectionFactory,
  ledger: LedgerStore,
  imageId: string,
  options: {
    network: string;
    provider: "daytona" | "e2b";
    selected: ReadonlySet<StateScenario>;
    signal: AbortSignal;
    cleanupWaitMs?: number;
    redactions?: readonly string[];
    borrowedVolume?: ResourceReference;
    sourcePreflight?: (source: AdapterSandbox) => Promise<void>;
  },
): Promise<Step[]> {
  return ledger.withLock(async () => {
    const steps: Step[] = [];
    let role = "connect";
    let client: AdapterDirectClient | undefined;
    const closeDiagnostics: Promise<import("./diagnostics").FailureDiagnostic>[] = [];

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Only bounded redacted error fields enter qualification diagnostics.
    const onDiagnostic = (error: unknown) => {
      closeDiagnostics.push(
        new FailureCapture(ledger, "close", "close", options.redactions).failure(error),
      );
    };

    const previous = await ledger.read();

    if (previous.stateMutations?.length)
      throw new Error("Existing state custody must be reconciled before another exercise");
    await ledger.update((value) => ({
      ...value,
      stateMode: "live-state",
      stateSelection: [...options.selected],
      stateMutations: [],
      cleanup: "pending",
    }));

    const journal = async (reference: AdapterRecoveryReference) => {
      await ledger.update((value) => ({
        ...value,
        stateRole: role,
        stateMutations: [
          ...(value.stateMutations ?? []).filter(
            (entry) =>
              // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
              (entry.reference as AdapterRecoveryReference).submissionId !== reference.submissionId,
          ),
          {
            role,
            reference,
            creation: creationKinds.includes(reference.kind),
            cleanup: creationKinds.includes(reference.kind) ? "pending" : "not-required",
          },
        ],
      }));
    };

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Public generic operation results are narrowed to SDK handles or parsed snapshot results before retaining custody.
    const save = async (reference: AdapterRecoveryReference, result?: unknown) =>
      ledger.update((value) => ({
        ...value,
        stateMutations: (value.stateMutations ?? []).map((entry) => {
          // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
          if ((entry.reference as AdapterRecoveryReference).submissionId !== reference.submissionId)
            return entry;

          if (result instanceof AdapterSandbox)
            return { ...entry, reference, sandboxId: result.id };

          if (result instanceof AdapterVolume)
            return { ...entry, reference, resource: result.reference };

          const capture = z.object({ snapshot: z.instanceof(AdapterSnapshot) }).safeParse(result);

          if (capture.success)
            return { ...entry, reference, resource: capture.data.snapshot.reference };

          const partial = partialResource(reference);

          if (partial) return { ...entry, reference, resource: partial };

          const failure = z
            .object({ captureState: z.literal("failed") })
            .safeParse(reference.token);

          if (reference.kind === "snapshot_capture" && failure.success)
            return { ...entry, reference, cleanup: "not-required" };

          return { ...entry, reference };
        }),
      }));

    const wait = async <T>(operation: AdapterOperation<T>, signal = options.signal): Promise<T> => {
      try {
        const value = await operation.wait({ signal, pollMs: 200 });
        await save(operation.reference, value);

        return value;
      } catch (error) {
        await save(
          error instanceof OutcomeUnknownError || error instanceof WaitAbortedError
            ? error.reference.mode === "direct"
              ? error.reference
              : operation.reference
            : operation.reference,
        );
        throw error;
      }
    };

    const create = async (name: string, mounts?: import("sandbar-adapter").MountSpec[]) => {
      role = name;

      return wait(
        await client!.sandboxes.submitCreate(
          { environment: Image.prepared(imageId), networkPolicy: options.network, mounts },
          { signal: options.signal },
        ),
      );
    };

    const read = async (box: AdapterSandbox, path: string) =>
      boundedRead(box.readFile(path), options.signal);

    const exec = async (box: AdapterSandbox, script: string) => {
      const output = await box.exec(
        { command: { kind: "shell", script }, deadlineSeconds: 10, maxOutputBytes: 512 },
        { signal: options.signal },
      );

      if (output.exitCode !== 0) throw new Error("State command exited unsuccessfully");

      if (output.truncated) throw new Error("State command output truncated");

      return output.stdoutText(512);
    };

    const snapshotPath =
      options.provider === "e2b" ? "/home/user/sandbar-captured.bin" : "/tmp/sandbar-captured.bin";

    const volumePath = `/mnt/sandbar-state/sandbar_${ledger.runId.replaceAll("-", "")}.bin`;
    const volumeBytes = new TextEncoder().encode(`Sandbar persistence ${ledger.runId}`);
    const observed: Partial<Record<StateScenario, StateEvidence>> = {};

    try {
      const connecting = factory(journal, onDiagnostic);
      connecting.then(
        (value) => {
          if (options.signal.aborted && client !== value) void value.close();
        },
        () => {},
      );
      client = await boundedRead(connecting, options.signal);
      steps.push({ scenario: "connect", status: "passed" });

      if (options.selected.has("snapshot-roundtrip")) {
        const capture = new FailureCapture(
          ledger,
          "snapshot-roundtrip",
          "create",
          options.redactions,
        );

        try {
          const restore = (await client.capabilities()).snapshots.restore;

          if (restore.status !== "supported")
            throw new SandbarError(
              restore.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
              restore.reason,
            );
          const source = await create("snapshot/source");
          await options.sourcePreflight?.(source);

          const plan = await source.checkSnapshot();

          if (plan.status !== "supported")
            throw new SandbarError(
              plan.status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
              plan.reason,
            );
          role = "snapshot/write";
          await source.writeFile(snapshotPath, bytes, {
            overwrite: true,
            signal: options.signal,
          });
          let before: ReturnType<typeof memorySample> | undefined;

          {
            role = "snapshot/memory-start";
            await exec(
              source,
              `python3 -c ${quote(memoryProgram)} >/tmp/sandbar-memory-error 2>&1 &`,
            );

            // Probe readiness through bounded commands; no mutation capture is retried.
            for (let index = 0; index < 10 && !before; index++) {
              try {
                role = "snapshot/memory-read";
                before = memorySample(await exec(source, memoryRead));
              } catch {
                if (index === 9) throw new Error("Memory process did not become ready");
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          }

          role = "snapshot/capture";

          const captureOperation = await source.submitSnapshot(undefined, {
            signal: options.signal,
          });

          const finishCapture = async () => {
            try {
              return await wait(captureOperation);
            } catch (error) {
              const restart = z
                .object({
                  captureState: z.literal("completed"),
                  restartState: z.literal("not-submitted"),
                })
                .safeParse(captureOperation.reference.token);

              if (
                !(error instanceof OutcomeUnknownError) ||
                !restart.success ||
                options.signal.aborted
              )
                throw error;
              await captureOperation.continue({ signal: options.signal });

              return await wait(captureOperation);
            }
          };

          const result = await finishCapture();

          const expected =
            plan.value.profile.sourceAfter === "unchanged"
              ? plan.value.sourceState
              : plan.value.profile.sourceAfter;

          const actual = await boundedRead(source.inspect(), options.signal);

          if (result.source.state !== expected || actual.state !== expected)
            throw new Error("Actual source lifecycle differs from accepted profile");
          const info = await boundedRead(result.snapshot.inspect(), options.signal);

          if (
            info.preserve !== plan.value.profile.preserve ||
            info.restoreExecution !== plan.value.profile.restoreExecution ||
            result.capture.preserve !== info.preserve ||
            result.capture.restoreExecution !== info.restoreExecution ||
            result.capture.interruption !== plan.value.profile.interruption ||
            info.mountHandling !== "none" ||
            info.state !== "ready"
          )
            throw new Error("Snapshot metadata does not establish requested capture");

          if (expected === "running") {
            role = "snapshot/source-change";
            await source.writeFile(snapshotPath, sourceChanged, {
              overwrite: true,
              signal: options.signal,
            });
            role = "snapshot/source-change-readback";
            equal(await read(source, snapshotPath), sourceChanged);
          }

          role = "snapshot/restore";

          const restored = await wait(
            await result.snapshot.submitRestore(
              { networkPolicy: options.network, requireIndependentLifecycle: true },
              { signal: options.signal },
            ),
          );

          if (restored.id === source.id) throw new Error("Restore reused source compute identity");
          equal(await read(restored, snapshotPath), bytes);

          if (plan.value.profile.restoreExecution === "resume" && before) {
            role = "snapshot/restored-memory";
            const first = memorySample(await exec(restored, memoryRead));
            const second = memorySample(await exec(restored, memoryRead));
            role = "snapshot/source-memory";
            const original = memorySample(await exec(source, memoryRead));

            if (
              first.nonce !== before.nonce ||
              second.nonce !== before.nonce ||
              original.nonce !== before.nonce ||
              first.count !== before.count + 1 ||
              second.count !== before.count + 2 ||
              original.count !== before.count + 1
            )
              throw new Error("RAM/process state or private-memory independence is unverified");
          }

          if (plan.value.profile.restoreExecution === "fresh") {
            role = "snapshot/restored-process-absent";

            if ((await exec(restored, processAbsent)) !== "PROCESS_ABSENT\n")
              throw new Error("Fresh restore retained the captured guest process");

            if (expected === "running") {
              role = "snapshot/source-process-absent";

              if ((await exec(source, processAbsent)) !== "PROCESS_ABSENT\n")
                throw new Error("Stopped/restarted source retained its previous guest process");
            }
          }

          role = "snapshot/restored-change";
          await restored.writeFile(snapshotPath, restoredChanged, {
            overwrite: true,
            signal: options.signal,
          });
          role = "snapshot/restored-change-readback";
          equal(await read(restored, snapshotPath), restoredChanged);

          if (expected === "running") {
            role = "snapshot/source-isolation-readback";
            equal(await read(source, snapshotPath), sourceChanged);
          }

          // Free compute before the second restore; at most two active sandboxes.
          await cleanupCompute(
            client,
            ledger,
            "snapshot/source",
            () => {
              role = "snapshot/source/delete";
            },
            options.cleanupWaitMs ?? 60000,
          );
          await cleanupCompute(
            client,
            ledger,
            "snapshot/restore",
            () => {
              role = "snapshot/restore/delete";
            },
            options.cleanupWaitMs ?? 60000,
          );

          const savedSnapshot = ResourceReference.parse(
            JSON.parse(JSON.stringify(result.snapshot.reference)),
          );

          await client.close();
          client = await factory(journal, onDiagnostic);
          const reopenedSnapshot = await client.snapshots.get(savedSnapshot);
          const reopenedInfo = await boundedRead(reopenedSnapshot.inspect(), options.signal);

          if (
            reopenedInfo.reference.nativeId !== savedSnapshot.nativeId ||
            reopenedInfo.reference.generation !== savedSnapshot.generation ||
            reopenedInfo.mountHandling !== "none"
          )
            throw new Error("Fresh connection lost captured identity or historical provenance");
          role = "snapshot/restore-second";

          const again = await wait(
            await reopenedSnapshot.submitRestore(
              { networkPolicy: options.network, requireIndependentLifecycle: true },
              { signal: options.signal },
            ),
          );

          equal(await read(again, snapshotPath), bytes);
          observed["snapshot-roundtrip"] = {
            probe: snapshotProbe,
            preserve: plan.value.profile.preserve,
            captureMode: "native-default",
            restoreExecution: plan.value.profile.restoreExecution,
            sourceProcesses: plan.value.profile.interruption === "stop" ? "ended" : "continued",
            freshExecution:
              plan.value.profile.restoreExecution === "fresh"
                ? "verified-missing-guest-process"
                : "not-applicable",
            sourceState: expected === "running" ? "running" : "stopped",
            capturedBytes: true,
            newIdentity: true,
            metadataInspected: true,
            serializedReferenceReopened: true,
            freshConnectionAfterSourceDeletion: true,
            restoredWriteIndependent: true,
            sourceWriteIndependent: expected === "running",
            secondRestoreOriginalBytes: true,
            memory:
              plan.value.profile.restoreExecution === "resume"
                ? "verified-unix-socket-nonce-counter"
                : "not-applicable",
            ownedArtifactDeleted: true,
          };
          await ledger.update((value) => ({
            ...value,
            stateObservations: {
              ...value.stateObservations,
              "snapshot-roundtrip": observed["snapshot-roundtrip"],
            },
          }));
          steps.push({ scenario: "snapshot-roundtrip", status: "passed" });
        } catch (error) {
          steps.push({
            scenario: "snapshot-roundtrip",
            status: stateStatus(error),
            issue: stateIssue(error),
            diagnostic: await capture.failure(error),
          });
        }
      }

      if (options.selected.has("volume-persistence")) {
        const capture = new FailureCapture(
          ledger,
          "volume-persistence",
          "create",
          options.redactions,
        );

        if (steps.some((step) => step.status === "failed" || step.status === "blocked"))
          steps.push({
            scenario: "volume-persistence",
            status: "blocked",
            issue: "dependency-failed",
          });
        else
          try {
            const caps = await client.capabilities();

            if (caps.volumes.status !== "supported" || caps.mounts?.status !== "supported")
              throw new SandbarError(
                caps.volumes.status === "unsupported" || caps.mounts?.status === "unsupported"
                  ? "UNSUPPORTED"
                  : "UNAVAILABLE",
                "Volume/mount capability eligibility is not established",
              );
            let volume: AdapterVolume;

            if (options.borrowedVolume) {
              const borrowed = ResourceReference.parse({
                ...options.borrowedVolume,
                ownership: "borrowed",
              });

              volume = await client.volumes.get(borrowed);
              await ledger.update((value) => ({ ...value, stateBorrowedVolume: borrowed }));
            } else {
              role = "volume/create";
              volume = await wait(
                await client.volumes.submitCreate(
                  { name: `sandbar-${ledger.runId.replaceAll("-", "")}` },
                  { signal: options.signal },
                ),
              );
            }

            let info = await boundedRead(volume.inspect(), options.signal);

            for (let index = 0; info.state === "creating" && index < 40; index++) {
              await boundedRead(new Promise((resolve) => setTimeout(resolve, 500)), options.signal);
              info = await boundedRead(volume.inspect(), options.signal);
            }

            if (info.state !== "ready") throw new Error("Volume readiness unconfirmed");
            const producer = await create("volume/producer", [volume.at("/mnt/sandbar-state")]);
            role = "volume/write";
            await producer.writeFile(volumePath, volumeBytes, {
              overwrite: !options.borrowedVolume,
              signal: options.signal,
            });
            // A finite writer closes before compute cleanup. This does not invent native durability.
            role = "volume/writer-close";
            await exec(
              producer,
              `python3 -c ${quote(`import os;f=open(${JSON.stringify(volumePath)},"rb");os.fsync(f.fileno());f.close()`)}`,
            );
            equal(await read(producer, volumePath), volumeBytes);
            await cleanupCompute(
              client,
              ledger,
              "volume/producer",
              () => {
                role = "volume/producer/delete";
              },
              options.cleanupWaitMs ?? 60000,
            );
            await boundedRead(volume.inspect(), options.signal);
            const consumer = await create("volume/consumer", [volume.at("/mnt/sandbar-state")]);
            equal(await read(consumer, volumePath), volumeBytes);

            let readOnly: "unsupported" | "rejected-write-unchanged-bytes" = "unsupported";

            if (caps.mounts.value.access.includes("read-only")) {
              await cleanupCompute(
                client,
                ledger,
                "volume/consumer",
                () => {
                  role = "volume/consumer/delete";
                },
                options.cleanupWaitMs ?? 60000,
              );

              const reader = await create("volume/read-only", [
                volume.at("/mnt/sandbar-state", { access: "read-only" }),
              ]);

              role = "volume/read-only/assert";

              const script = `import errno
try:
 f=open(${JSON.stringify(volumePath)},"r+b")
 f.write(bytes([7]));f.close()
 print("WRITE_ACCEPTED")
except OSError as e:
 if e.errno not in (errno.EACCES,errno.EPERM,errno.EROFS): raise
 print("READ_ONLY_REJECTED")`;

              if ((await exec(reader, `python3 -c ${quote(script)}`)) !== "READ_ONLY_REJECTED\n")
                throw new Error("Advertised read-only mount accepted a write");
              equal(await read(reader, volumePath), volumeBytes);
              readOnly = "rejected-write-unchanged-bytes";
            }

            observed["volume-persistence"] = {
              probe: volumeProbe,
              ownership: options.borrowedVolume ? "borrowed" : "created",
              metadataInspected: true,
              producerWriter: "finite-writer-closed",
              shutdownDurability: "allow-unconfirmed-explicit",
              computeDeletedVolumeRetained: true,
              reopenedBytes: true,
              readOnly,
              storageCleanup: options.borrowedVolume ? "borrowed-retained" : "owned-deleted",
            };
            await ledger.update((value) => ({
              ...value,
              stateObservations: {
                ...value.stateObservations,
                "volume-persistence": observed["volume-persistence"],
              },
            }));
            steps.push({ scenario: "volume-persistence", status: "passed" });
          } catch (error) {
            steps.push({
              scenario: "volume-persistence",
              status: stateStatus(error),
              issue: stateIssue(error),
              diagnostic: await capture.failure(error),
            });
          }
      }
    } catch (error) {
      steps.push({
        scenario: "connect",
        status: "failed",
        issue: stateIssue(error),
        diagnostic: await new FailureCapture(
          ledger,
          "connect",
          "connect",
          options.redactions,
        ).failure(error),
      });
    } finally {
      if (client) {
        const cleanup = await reconcileState(
          client,
          ledger,
          options.cleanupWaitMs ?? 60000,
          (name) => {
            role = name;
          },
        );

        steps.push(...cleanup);

        try {
          await client.close();
        } catch (error) {
          onDiagnostic(error);
        }

        const failures = await Promise.all(closeDiagnostics);
        steps.push({
          scenario: "close",
          status: failures.length ? "failed" : "passed",
          diagnostic: failures[0],
        });
      } else
        await ledger.update((value) => ({
          ...value,
          cleanup: (value.stateMutations ?? []).some((entry) => entry.creation)
            ? "unresolved"
            : "not-required",
        }));
    }

    const state = await ledger.read();

    for (const step of steps)
      if (step.scenario === "snapshot-roundtrip" || step.scenario === "volume-persistence") {
        if (
          step.status === "passed" &&
          (state.cleanup !== "confirmed" ||
            steps.some((item) => item.scenario === "close" && item.status !== "passed"))
        ) {
          step.status = "blocked";
          step.issue = "cleanup-unconfirmed";
        } else if (step.status === "passed") step.stateEvidence = observed[step.scenario];
      }

    return steps;
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught external errors are narrowed to public SDK errors before reading codes.
function stateStatus(error: unknown): Step["status"] {
  if (
    (error instanceof SandbarError || error instanceof AdapterError) &&
    error.code === "UNSUPPORTED"
  )
    return "unsupported";

  if (
    (error instanceof SandbarError || error instanceof AdapterError) &&
    error.code === "UNAVAILABLE"
  )
    return "blocked";

  return "failed";
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Caught external errors are classified without serializing provider objects.
function stateIssue(error: unknown) {
  return stateStatus(error) === "unsupported"
    ? "unsupported-capability"
    : error instanceof OutcomeUnknownError
      ? "outcome-unknown"
      : error instanceof WaitAbortedError
        ? "interrupted"
        : stateStatus(error) === "blocked"
          ? "dependency-failed"
          : "assertion-failed";
}

async function cleanupCompute(
  client: AdapterDirectClient,
  ledger: LedgerStore,
  name: string,
  setRole: () => void | Promise<void>,
  budget: number,
) {
  const entry = (await ledger.read()).stateMutations?.find(
    (entry) => entry.role === name && entry.creation,
  );

  if (!entry || entry.cleanup === "confirmed") return;

  if (!entry.sandboxId) throw new Error("Compute identity is unconfirmed");
  await setRole();

  const existing = (await ledger.read()).stateMutations?.find(
    (value) => value.role === `${name}/delete`,
  );

  const signal = AbortSignal.timeout(budget);

  // SAFETY: recover parses the persisted direct reference and verifies its full connection binding before provider access.
  const operation = existing
    ? await client.recover(existing.reference as AdapterRecoveryReference)
    : await new AdapterSandbox(client, entry.sandboxId).submitDestroy({
        signal,
        storage: "allow-unconfirmed",
      });

  const save = async (reference: AdapterRecoveryReference) =>
    ledger.update((value) => ({
      ...value,
      stateMutations: value.stateMutations?.map((item) =>
        z.object({ submissionId: z.string() }).parse(item.reference).submissionId ===
        reference.submissionId
          ? { ...item, reference }
          : item,
      ),
    }));

  try {
    const value = await operation.wait({ signal });
    await save(operation.reference);

    if (!z.object({ computeStopped: z.literal(true) }).safeParse(value).success)
      throw new Error("Recovered compute cleanup unconfirmed");
  } catch (error) {
    await save(
      (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError) &&
        error.reference.mode === "direct"
        ? error.reference
        : operation.reference,
    );
    throw error;
  }

  await ledger.update((value) => ({
    ...value,
    stateMutations: value.stateMutations?.map((item) =>
      item.role === name ? { ...item, cleanup: "confirmed" } : item,
    ),
  }));
}

/** Reconcile every creator before teardown; never submit a creator from interruption recovery. */
export async function reconcileState(
  client: AdapterDirectClient,
  ledger: LedgerStore,
  budget = 60000,
  setRole: (name: string) => void | Promise<void> = () => {},
): Promise<Step[]> {
  const deadline = Date.now() + budget;
  const signal = AbortSignal.timeout(budget);
  let failed = false;
  let cleanupDiagnostic: import("./diagnostics").FailureDiagnostic | undefined;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The diagnostic boundary extracts and redacts bounded Error fields.
  const failure = async (error: unknown) => {
    failed = true;
    cleanupDiagnostic ??= await new FailureCapture(
      ledger,
      "confirm-cleanup",
      "confirm-cleanup",
    ).failure(error);
  };

  const persistReference = async (reference: AdapterRecoveryReference) =>
    ledger.update((value) => ({
      ...value,
      stateMutations: value.stateMutations?.map((entry) =>
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        (entry.reference as AdapterRecoveryReference).submissionId === reference.submissionId
          ? { ...entry, reference, resource: entry.resource ?? partialResource(reference) }
          : entry,
      ),
    }));

  // Capture observation needs the original source alive. Missing identity remains durable.
  const pending =
    (await ledger.read()).stateMutations?.filter(
      (entry) =>
        entry.creation &&
        entry.cleanup === "pending" &&
        ((!entry.resource && !entry.sandboxId) ||
          // SAFETY: This SDK-produced custody reference is schema-parsed by captureInProgress before examining its stage.
          captureInProgress(entry.reference as AdapterRecoveryReference)),
    ) ?? [];

  for (const entry of pending) {
    try {
      // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
      const operation = await client.recover(entry.reference as AdapterRecoveryReference);
      const result = await operation.wait({ signal });
      await persistReference(operation.reference);
      await ledger.update((value) => ({
        ...value,
        stateMutations: value.stateMutations?.map((item) =>
          item.role === entry.role
            ? result instanceof AdapterSandbox
              ? { ...item, sandboxId: result.id }
              : result instanceof AdapterVolume
                ? { ...item, resource: result.reference }
                : z.object({ snapshot: z.instanceof(AdapterSnapshot) }).safeParse(result).success
                  ? {
                      ...item,
                      resource: z.object({ snapshot: z.instanceof(AdapterSnapshot) }).parse(result)
                        .snapshot.reference,
                    }
                  : item
            : item,
        ),
      }));
    } catch (error) {
      if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        await persistReference(error.reference as AdapterRecoveryReference);
      await failure(error);
    }
  }

  // Keep unresolved capture source evidence alive until an operator can inspect it; native TTL remains fallback.
  const unresolved = (await ledger.read()).stateMutations?.some(
    (entry) =>
      entry.creation &&
      entry.cleanup === "pending" &&
      ((!entry.resource && !entry.sandboxId) ||
        // SAFETY: This SDK-produced custody reference is schema-parsed by captureInProgress before examining its stage.
        captureInProgress(entry.reference as AdapterRecoveryReference)),
  );

  for (const entry of (await ledger.read()).stateMutations ?? []) {
    if (!entry.creation || entry.cleanup !== "pending" || !entry.sandboxId) continue;

    if (unresolved && entry.role === "snapshot/source") {
      failed = true;
      continue;
    }

    try {
      await cleanupCompute(
        client,
        ledger,
        entry.role,
        () => setRole(`${entry.role}/delete`),
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
        // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
        await persistReference(error.reference as AdapterRecoveryReference);
      await failure(error);
    }
  }

  // Delete independently owned retained storage only after all compute dependencies are confirmed gone.
  const computePending = (await ledger.read()).stateMutations?.some(
    (entry) => entry.creation && entry.sandboxId && entry.cleanup === "pending",
  );

  if (!computePending && !unresolved)
    for (const entry of (await ledger.read()).stateMutations ?? []) {
      if (!entry.creation || entry.cleanup !== "pending" || !entry.resource) continue;

      try {
        const resource = ResourceReference.parse(entry.resource);

        if (resource.ownership !== "verified-created")
          throw new Error("Artifact ownership is unverified");
        const deleteRole = `${entry.role}/delete`;
        await setRole(deleteRole);

        const existing = (await ledger.read()).stateMutations?.find(
          (value) => value.role === deleteRole,
        );

        const operation = existing
          ? // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
            await client.recover(existing.reference as AdapterRecoveryReference)
          : resource.kind === "snapshot"
            ? await new AdapterSnapshot(client, resource).submitDelete({ signal })
            : await new AdapterVolume(client, resource).submitDelete({ signal });

        const result = await operation.wait({ signal });
        await persistReference(operation.reference);

        if (!z.object({ deleted: z.literal(true) }).safeParse(result).success)
          throw new Error("Retained artifact deletion unconfirmed");
        await ledger.update((value) => ({
          ...value,
          stateMutations: value.stateMutations?.map((item) =>
            item.role === entry.role ? { ...item, cleanup: "confirmed" } : item,
          ),
        }));
      } catch (error) {
        if (error instanceof OutcomeUnknownError || error instanceof WaitAbortedError)
          // SAFETY: The SDK produced this direct custody reference; recover validates the full schema and connection binding before provider access.
          await persistReference(error.reference as AdapterRecoveryReference);
        await failure(error);
      }
    }

  const remaining = (await ledger.read()).stateMutations?.some(
    (entry) => entry.creation && entry.cleanup === "pending",
  );

  await ledger.update((value) => ({
    ...value,
    cleanup:
      failed || remaining
        ? "unresolved"
        : (value.stateMutations ?? []).some((entry) => entry.creation)
          ? "confirmed"
          : "not-required",
  }));

  return [
    {
      scenario: "confirm-cleanup",
      status: failed || remaining ? "failed" : "passed",
      issue: failed || remaining ? "cleanup-unconfirmed" : undefined,
      diagnostic: cleanupDiagnostic,
    },
  ];
}
