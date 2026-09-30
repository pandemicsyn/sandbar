import type { Json } from "sandbar-adapter";

const validatedReferences = new WeakSet<object>();

const operationReferences = new WeakMap<object, () => object>();

/** SDK-owned access to private state; telemetry never invokes a public accessor. */
export function certifyOperationReference<T extends object>(
  operation: T,
  read: () => object,
): void {
  operationReferences.set(operation, read);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This identity-only lookup never traverses untrusted objects or application accessors.
export function certifiedOperationReference(value: unknown): object | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- WeakMap lookup requires an object identity.
  if (!value || typeof value !== "object") return undefined;

  return operationReferences.get(value)?.();
}

/** Called only after the SDK validates and seals its own reference copy. */
export function certifyRecoveryReference<T extends object>(reference: T): T {
  validatedReferences.add(reference);

  return reference;
}

/** Membership never traverses an application-provided reference or opaque token. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This identity-only predicate accepts untrusted telemetry inputs and consults prior validation without parsing or traversing them.
export function certifiedRecoveryAvailable(reference: unknown): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- WeakSet membership accepts only object identities and never inspects their properties.
  return !!reference && typeof reference === "object" && validatedReferences.has(reference);
}

/** The caller has validated JSON and enforced the reference's declared byte bound. */
export function freezeRecoveryToken(value: Json): void {
  const pending: Json[] = [value];

  while (pending.length > 0) {
    const current = pending.pop()!;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only bounded, validated JSON containers have children to freeze.
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
}
