import { intentSha256 } from "@sandbar/contracts";
import { newInvocationKey } from "./api";

type PendingInvocation = { key: string; intentHash: string };

// Memory only: a route change keeps an unresolved request's identity, while a
// browser restart still requires inspecting Sandbar before starting new work.
const pending = new Map<string, PendingInvocation>();

export function hasPendingInvocation(scope: string): boolean {
  return pending.has(scope);
}

export function clearPendingInvocation(scope: string): void {
  pending.delete(scope);
}

export async function withInvocation<T>(
  scope: string,
  intent: unknown,
  submit: (key: string) => Promise<T>,
): Promise<T> {
  const intentHash = await intentSha256(intent);
  let attempt = pending.get(scope);
  if (attempt && attempt.intentHash !== intentHash) {
    throw new Error(
      "An earlier request may have been accepted. Retry its original inputs first, or explicitly start a new attempt with possible duplicate effects.",
    );
  }
  if (!attempt) {
    attempt = { key: newInvocationKey(), intentHash };
    pending.set(scope, attempt);
  }
  const result = await submit(attempt.key);
  pending.delete(scope);
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
