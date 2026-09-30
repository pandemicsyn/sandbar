import type { RecoveryFacts, ResourceReference } from "sandbar-adapter";
import type { AdapterRecoveryReference } from "./adapter-reference";
import type { RecoveryReference } from "./resource";
import { freezeReference } from "./freeze-reference";

/** Historical evidence and advisory continuation; never dispatch authority. */
export type RecoveryOutcome = Omit<RecoveryFacts, "retainedResources"> & {
  /** Every known resource from provider facts, completion and the saved mount envelope. */
  readonly retainedResources: ResourceReference[];
  readonly reference: AdapterRecoveryReference;
  readonly retainedNativeIds: readonly string[];
  readonly retainedArtifacts: readonly import("sandbar-adapter").RetainedArtifact[];
  readonly nextAction: "continue" | "observe" | "manual" | "none" | "unknown";
};

/** Identity within a verified provider/scope envelope; observations are not identity. */
export function resourceIdentityKey(
  resource: Pick<ResourceReference, "kind" | "nativeId" | "generation">,
): string {
  return JSON.stringify([resource.kind, resource.nativeId, resource.generation]);
}

/** Preserve stronger custody and missing reopening evidence without merging opaque history. */
export function mergeResourceEvidence(
  primary: ResourceReference,
  fallback: ResourceReference,
): ResourceReference {
  const ownershipRank = { unknown: 0, borrowed: 1, "verified-created": 2 };

  return {
    ...fallback,
    ...primary,
    ownership:
      ownershipRank[primary.ownership] >= ownershipRank[fallback.ownership]
        ? primary.ownership
        : fallback.ownership,
    history: primary.history !== undefined ? primary.history : fallback.history,
    receipt: primary.receipt ?? fallback.receipt,
  };
}

export function recoveryOutcome(reference: AdapterRecoveryReference): RecoveryOutcome;
export function recoveryOutcome(
  reference: RecoveryReference | AdapterRecoveryReference,
): RecoveryOutcome | undefined;
export function recoveryOutcome(
  reference: RecoveryReference | AdapterRecoveryReference,
): RecoveryOutcome | undefined {
  if (reference.mode !== "direct") return undefined;

  const retainedResources: ResourceReference[] = ["create", "destroy"].includes(reference.kind)
    ? (reference.mounts ?? []).map((mount) => mount.volume)
    : [];

  const facts = reference.facts ?? {
    version: 1 as const,
    retainedResources,
    completed: [],
    steps: [],
    continuation: {
      supported: "unknown" as const,
      status: "unknown" as const,
      reason: "No normalized recovery evidence was saved; observe with current credentials",
    },
  };

  const completion = reference.completion;
  const known = new Map<string, ResourceReference>();

  for (const resource of [...facts.retainedResources, ...retainedResources]) {
    const key = resourceIdentityKey(resource);
    const prior = known.get(key);
    known.set(key, prior ? mergeResourceEvidence(prior, resource) : resource);
  }

  for (const patch of completion?.resources ?? []) {
    const key = resourceIdentityKey(patch);
    const prior = known.get(key);

    const current: ResourceReference = {
      ...prior,
      ...patch,
      version: 1,
      ownership: patch.ownership ?? prior?.ownership ?? "unknown",
      provider: reference.provider,
      scope: reference.scope,
    };

    known.set(key, prior ? mergeResourceEvidence(current, prior) : current);
  }

  const step =
    reference.kind === "snapshot_capture"
      ? "capture"
      : reference.kind === "snapshot_restore"
        ? "restore"
        : reference.kind;

  let completed = facts.completed;

  if (completion) {
    const current = { ...facts.completed.find((fact) => fact.step === step), step };

    if (completion.capture) current.capture = completion.capture;
    completed = [...facts.completed.filter((fact) => fact.step !== step), current];
  }

  const continuation = completion
    ? {
        supported: facts.continuation.supported,
        status: "unavailable" as const,
        reason: "Operation completed; no continuation is needed",
      }
    : facts.continuation;

  let nextAction: RecoveryOutcome["nextAction"] = "unknown";

  if (completion) nextAction = "none";
  else if (continuation.action && continuation.action !== "continue")
    nextAction = continuation.action;
  else if (continuation.status === "eligible" && continuation.supported === true)
    nextAction = "continue";
  else if (facts.steps.some((fact) => fact.status === "failed")) nextAction = "manual";
  else if (facts.steps.some((fact) => fact.status === "uncertain" || fact.status === "pending"))
    nextAction = "observe";
  else if (continuation.status === "unavailable") nextAction = "manual";

  return freezeReference({
    ...structuredClone(facts),
    completed: structuredClone(completed),
    steps: structuredClone(
      completion
        ? facts.steps.map((fact) =>
            fact.step === step ? { ...fact, status: "completed" as const } : fact,
          )
        : facts.steps,
    ),
    source:
      completion?.sourceState && completion.sourceState !== facts.source?.state
        ? undefined
        : structuredClone(facts.source),
    continuation: structuredClone(continuation),
    nextAction,
    retainedNativeIds: structuredClone(completion?.retainedNativeIds ?? []),
    retainedArtifacts: structuredClone(completion?.retainedArtifacts ?? []),
    retainedResources: structuredClone([...known.values()]),
    reference: structuredClone(reference),
  });
}
