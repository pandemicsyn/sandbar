import type { LedgerStore } from "./ledger";
import { runPrepared, type ConnectionFactory, type Step } from "./lifecycle";
import {
  probeNetwork,
  networkProbeId,
  requireBlocked,
  requireInternet,
  type NetworkSample,
} from "./network-probe";

export type NetworkRun = { policy: "internet" | "blocked"; ledger: LedgerStore; steps: Step[] };

/** Two owned sandboxes at most. Both control samples surround the blocked probe in the same live control. */
export async function runNetworkPair(
  factory: ConnectionFactory,
  internetLedger: LedgerStore,
  blockedLedger: LedgerStore,
  imageId: string,
  options: Pick<
    Parameters<typeof runPrepared>[3],
    "signal" | "cleanupWaitMs" | "redactions" | "envdVersion"
  >,
): Promise<NetworkRun[]> {
  if (imageId !== "base")
    throw new Error("Network qualification requires the public base template");

  const runs: NetworkRun[] = [];
  const samples: NetworkSample[] = [];

  const evidence = () => ({
    probe: networkProbeId,
    samples: [...samples],
  });

  const save = async () => {
    await internetLedger.update((value) => ({ ...value, networkEvidence: evidence() }));
    await blockedLedger.update((value) => ({ ...value, networkEvidence: evidence() }));
  };

  const internetSteps = await runPrepared(factory, internetLedger, imageId, {
    ...options,
    network: "internet",
    selectedScenarios: new Set(["network-internet"]),
    async networkCheck(control, controlCapture) {
      const before = await probeNetwork(control, "before", controlCapture, options.signal);
      samples.push(before);
      await save();
      requireInternet(before);

      const blockedSteps = await runPrepared(factory, blockedLedger, imageId, {
        ...options,
        network: "blocked",
        selectedScenarios: new Set(["network-blocked"]),
        async networkCheck(blocked, capture) {
          const sample = await probeNetwork(blocked, "blocked", capture, options.signal);
          samples.push(sample);
          await save();
          // Run the after control even when outbound connectivity unexpectedly succeeds.
          const after = await probeNetwork(control, "after", capture, options.signal);
          samples.push(after);
          await save();
          requireInternet(after);
          requireBlocked(sample);

          return evidence();
        },
      });

      runs.push({ policy: "blocked", ledger: blockedLedger, steps: blockedSteps });

      if (!samples.some((sample) => sample.phase === "after"))
        throw new Error("Blocked exercise did not reach its after positive control");
      requireInternet(samples.find((sample) => sample.phase === "after")!);

      return evidence();
    },
  });

  if (!internetSteps.some((step) => step.scenario === "network-internet"))
    internetSteps.push({
      scenario: "network-internet",
      status: "blocked",
      issue: "dependency-failed",
    });

  runs.push({ policy: "internet", ledger: internetLedger, steps: internetSteps });

  if (!runs.some((run) => run.policy === "blocked")) {
    await blockedLedger.update((value) => ({ ...value, cleanup: "not-required" }));
    runs.push({
      policy: "blocked",
      ledger: blockedLedger,
      steps: [
        {
          scenario: "network-blocked",
          status: "blocked",
          issue: "dependency-failed",
          networkEvidence: samples.length ? evidence() : undefined,
        },
      ],
    });
  }

  return runs;
}
