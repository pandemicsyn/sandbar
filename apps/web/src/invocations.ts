import { intentSha256 } from "@sandbar/contracts";
import { newInvocationKey } from "./api";

type PendingInvocation = { key: string; intentHash: string };

// Persist only the invocation identity and intent hash, never the payload.
const prefix = "sandbar:pending-invocation:v1:";
const storageKey = (scope: string) => `${prefix}${scope}`;

function readPending(scope: string): PendingInvocation | undefined {
  const raw = localStorage.getItem(storageKey(scope));
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      typeof value.key === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value.key,
      ) &&
      "intentHash" in value &&
      typeof value.intentHash === "string" &&
      /^[0-9a-f]{64}$/.test(value.intentHash)
    )
      return { key: value.key, intentHash: value.intentHash };
  } catch {
    // Keep the unknown record until the operator explicitly starts a new attempt.
  }
  throw new Error(
    "The previous invocation record is unreadable. Inspect Sandbar before starting a new attempt.",
  );
}

export function hasPendingInvocation(scope: string): boolean {
  try {
    return localStorage.getItem(storageKey(scope)) !== null;
  } catch {
    return false;
  }
}

export function pendingInvocationKey(scope: string): string | undefined {
  return readPending(scope)?.key;
}

export function clearPendingInvocation(scope: string): void {
  localStorage.removeItem(storageKey(scope));
}

export async function withInvocation<T>(
  scope: string,
  intent: unknown,
  submit: (key: string) => Promise<T>,
): Promise<T> {
  const intentHash = await intentSha256(intent);
  let attempt = readPending(scope);
  if (attempt && attempt.intentHash !== intentHash) {
    throw new Error(
      "An earlier request may have been accepted. Retry its original inputs first, or explicitly start a new attempt with possible duplicate effects.",
    );
  }
  if (!attempt) {
    attempt = { key: newInvocationKey(), intentHash };
    localStorage.setItem(storageKey(scope), JSON.stringify(attempt));
  }
  const result = await submit(attempt.key);
  clearPendingInvocation(scope);
  return result;
}

export async function fileIntent(
  path: string,
  bytes: Uint8Array,
): Promise<{ path: string; sha256: string }> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return {
    path,
    sha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
