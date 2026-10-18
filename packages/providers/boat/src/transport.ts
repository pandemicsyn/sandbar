import { BoatApi, Configuration, FetchError, ResponseError, type FetchAPI } from "@boatdev/sdk";
import { AdapterError, type AdapterErrorCode } from "@sandbar-sdk/adapter";
import { z } from "zod";

/** Fixed Boat Public API v1 origin; it is not a project-controlled setting. */
export const BOAT_API = "https://boat.dev/api/v1";

/** Largest native response body the adapter accepts, before JSON decoding. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Boat's error envelope. `retryable: true` marks a refusal that provably never ran
 * the request (for example, a sandbox still restoring its disk).
 */
const Envelope = z.object({
  status: z.number().int().optional(),
  code: z.string().max(128).optional(),
  message: z.string().optional(),
  requestId: z.string().max(256).optional(),
  retryable: z.boolean().optional(),
  error: z
    .object({ details: z.object({ retryable: z.boolean().optional() }).optional() })
    .optional(),
});

export type NativeFailure = {
  /** HTTP status, or undefined when no response arrived. */
  status?: number;
  code?: string;
  requestId?: string;
  retryable: boolean;
  error: AdapterError;
};

const codes = new Map<number, AdapterErrorCode>([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [402, "CAPACITY"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [409, "CONFLICT"],
  [410, "NOT_FOUND"],
  [413, "CAPACITY"],
  [422, "INVALID_ARGUMENT"],
  [429, "RATE_LIMIT"],
  [503, "UNAVAILABLE"],
  [504, "TIMEOUT"],
]);

/** Native statuses that Boat documents or HTTP defines as refused before any effect. */
const definitive = new Set([400, 401, 402, 403, 404, 410, 413, 422, 429]);

/** 409 codes that describe an attempt still in flight rather than a refusal. */
const inFlight = new Set(["idempotency_in_progress"]);

/** 503 codes Boat documents as answered with nothing created or run. */
const unavailableBeforeEffect = new Set(["no_ready_machine", "out_of_capacity"]);

/** Boat's docs spell the restoring refusal with either the legacy or current prefix. */
const restoring = /\b(?:sandbox|boat)_restoring\b/;

function clean(text: string, secrets: readonly string[]): string {
  let value = text;

  for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[redacted]");

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Normalize an SDK throw into a redacted AdapterError plus the evidence needed to
 * decide whether the native request could have taken effect.
 */
export async function nativeFailure(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK and fetch throws are parsed and redacted at this boundary.
  error: unknown,
  secrets: readonly string[],
): Promise<NativeFailure> {
  if (error instanceof AdapterError) return { retryable: false, error };

  if (error instanceof ResponseError) {
    const status = error.response.status;
    let body: z.infer<typeof Envelope> = {};

    try {
      const parsed = Envelope.safeParse(await error.response.clone().json());

      if (parsed.success) body = parsed.data;
    } catch {
      /* A non-JSON error body keeps only the HTTP status. */
    }

    const code = codes.get(status) ?? (status >= 500 ? "UNAVAILABLE" : "INTERNAL");
    const detail = clean(body.message ?? "", secrets);
    const requestId = body.requestId ? clean(body.requestId, secrets) : undefined;

    return {
      status,
      code: body.code,
      requestId,
      retryable:
        body.retryable === true ||
        body.error?.details?.retryable === true ||
        restoring.test(body.message ?? ""),
      error: new AdapterError(
        code,
        `Boat API ${status}${body.code ? ` ${clean(body.code, secrets)}` : ""}${detail ? `: ${detail}` : ""}${requestId ? ` (request ${requestId})` : ""}`,
      ),
    };
  }

  if (error instanceof FetchError || error instanceof DOMException)
    return {
      retryable: false,
      error: new AdapterError(
        error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE",
        "Boat API request did not complete",
      ),
    };

  return { retryable: false, error: new AdapterError("UNAVAILABLE", "Boat API request failed") };
}

/** True only when Boat refused the request before it could take effect. */
export function refusedBeforeEffect(failure: NativeFailure): boolean {
  if (failure.retryable) return true;

  if (failure.status === undefined) return false;

  if (failure.status === 409) return !inFlight.has(failure.code ?? "");

  if (failure.status === 503) return unavailableBeforeEffect.has(failure.code ?? "");

  return definitive.has(failure.status);
}

/** Stream a response body into memory, failing once it passes the bound. */
async function bounded(response: Response, limit: number): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) break;
      length += next.value.byteLength;

      if (length > limit)
        throw new AdapterError("CAPACITY", "Boat API response exceeds the adapter bound");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * One fetch per SDK call: the generated `BoatApi` methods never retry, and this
 * wrapper adds no retry. Redirects are refused so the bearer token stays on the
 * Boat origin, and every body is bounded before decoding.
 */
export function boundedFetch(base: FetchAPI, limit = MAX_RESPONSE_BYTES): FetchAPI {
  return async (input, init) => {
    const response = await base(input, { ...init, redirect: "error" });

    return bounded(response, limit);
  };
}

/** Raw generated client methods only; the SDK's convenience helpers resend some requests. */
export function createBoatClient(apiKey: string, fetchApi: FetchAPI = globalThis.fetch): BoatApi {
  return new BoatApi(
    new Configuration({
      basePath: BOAT_API,
      accessToken: apiKey,
      fetchApi: boundedFetch(fetchApi),
    }),
  );
}
