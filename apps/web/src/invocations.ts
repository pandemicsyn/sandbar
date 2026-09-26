import { intentSha256 } from "@sandbar/contracts";
import { newInvocationKey } from "./api";

type SavedInvocation = {
  key: string;
  intentHash: string;
  status: "pending" | "accepted";
};

// Persist only the invocation identity and intent hash, never the payload.
const prefix = "sandbar:pending-invocation:v1:";
const storageKey = (scope: string) => `${prefix}${scope}`;

function readInvocation(scope: string): SavedInvocation | undefined {
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
      /^[0-9a-f]{64}$/.test(value.intentHash) &&
      "status" in value &&
      (value.status === "pending" || value.status === "accepted")
    )
      return {
        key: value.key,
        intentHash: value.intentHash,
        status: value.status,
      };
  } catch {
    // Keep the unknown record until the operator explicitly starts a new attempt.
  }
  throw new Error(
    "The previous invocation record is unreadable. Inspect Sandbar before starting a new attempt.",
  );
}

export function invocationStatus(
  scope: string,
): SavedInvocation["status"] | undefined {
  try {
    return readInvocation(scope)?.status;
  } catch {
    try {
      return localStorage.getItem(storageKey(scope)) === null
        ? undefined
        : "pending";
    } catch {
      return undefined;
    }
  }
}

export async function recoverInvocation<T>(
  scope: string,
  lookup: (key: string) => Promise<T>,
): Promise<T | undefined> {
  if (!navigator.locks?.request)
    throw new Error(
      "This browser cannot coordinate safe requests across tabs.",
    );
  return navigator.locks.request(`sandbar:invocation:${scope}`, async () => {
    const attempt = readInvocation(scope);
    if (!attempt) return undefined;
    const result = await lookup(attempt.key);
    localStorage.setItem(
      storageKey(scope),
      JSON.stringify({ ...attempt, status: "accepted" }),
    );
    return result;
  });
}

export async function clearPendingInvocation(scope: string): Promise<void> {
  if (!navigator.locks?.request)
    throw new Error(
      "This browser cannot coordinate safe requests across tabs.",
    );
  await navigator.locks.request(`sandbar:invocation:${scope}`, () => {
    localStorage.removeItem(storageKey(scope));
  });
}

export async function withInvocation<T>(
  scope: string,
  intent: unknown,
  submit: (key: string) => Promise<T>,
): Promise<T> {
  const intentHash = await intentSha256(intent);
  if (!navigator.locks?.request)
    throw new Error(
      "This browser cannot coordinate safe requests across tabs.",
    );
  return navigator.locks.request(`sandbar:invocation:${scope}`, async () => {
    let attempt = readInvocation(scope);
    if (attempt?.status === "accepted" && attempt.intentHash !== intentHash)
      attempt = undefined;
    if (attempt && attempt.intentHash !== intentHash) {
      throw new Error(
        "An earlier request may have been accepted. Retry its original inputs first, or explicitly start a new attempt with possible duplicate effects.",
      );
    }
    if (!attempt) {
      attempt = { key: newInvocationKey(), intentHash, status: "pending" };
      localStorage.setItem(storageKey(scope), JSON.stringify(attempt));
    }
    const result = await submit(attempt.key);
    localStorage.setItem(
      storageKey(scope),
      JSON.stringify({ ...attempt, status: "accepted" }),
    );
    return result;
  });
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
