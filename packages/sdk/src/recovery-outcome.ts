import type { RecoveryFacts, ResourceReference } from "sandbar-adapter";
import type { AdapterRecoveryReference } from "./adapter-reference";
import type { RecoveryReference } from "./resource";
import { freezeReference } from "./freeze-reference";

/** Historical evidence and advisory continuation; never dispatch authority. */
export type RecoveryOutcome = Omit<RecoveryFacts, "retainedResources"> & {
  /** Up to 64 known resources from bounded facts and the saved mount envelope. */
  readonly retainedResources: ResourceReference[];
  readonly reference: AdapterRecoveryReference;
};

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

  const resources = [...facts.retainedResources, ...retainedResources];

  const known = [
    ...new Map(resources.map((resource) => [JSON.stringify(resource), resource])).values(),
  ];

  return freezeReference({
    ...structuredClone(facts),
    retainedResources: structuredClone(known),
    reference: structuredClone(reference),
  });
}
