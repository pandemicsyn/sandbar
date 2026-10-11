import { AdapterError, type Json } from "sandbar-adapter";
import { z } from "zod";

/** Trusted host injection; implementations must dispatch each request at most once. */
export type VercelTransport = {
  fetch(url: string, init: RequestInit): Promise<Response>;
  close?(): void | Promise<void>;
};

export const VERCEL_API = "https://vercel.com/api";

export async function boundedBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new AdapterError("UNAVAILABLE", "Missing native response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abortRead: (() => void) | undefined;

  const aborted = new Promise<never>((_resolve, reject) => {
    abortRead = () => reject(new AdapterError("TIMEOUT", "Native read interrupted"));

    if (signal?.aborted) abortRead();
    else signal?.addEventListener("abort", abortRead, { once: true });
  });

  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);

      if (chunk.done) break;
      size += chunk.value.length;

      if (size > limit) throw new AdapterError("UNAVAILABLE", "Native response exceeds byte bound");
      chunks.push(chunk.value);
    }
  } finally {
    if (abortRead) signal?.removeEventListener("abort", abortRead);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return Buffer.concat(chunks, size);
}

export class VercelClient {
  constructor(
    private transport: VercelTransport,
    private token: string,
    private teamId: string,
  ) {}
  async request(
    path: string,
    signal: AbortSignal,
    body?: string | Uint8Array,
    headers?: Record<string, string>,
  ) {
    const url = new URL(VERCEL_API + path);
    url.searchParams.set("teamId", this.teamId);

    const response = await this.transport.fetch(url.href, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof Uint8Array ? Buffer.from(body) : body,
    });

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});

      const code =
        response.status === 404
          ? "NOT_FOUND"
          : response.status === 401 || response.status === 403
            ? "UNAUTHENTICATED"
            : response.status === 429
              ? "RATE_LIMIT"
              : "UNAVAILABLE";

      throw new AdapterError(code, `Vercel request failed (${response.status})`);
    }

    return response;
  }
  async json<T>(
    path: string,
    signal: AbortSignal,
    schema: z.ZodType<T>,
    body?: { [key: string]: Json | undefined },
  ) {
    const response = await this.request(
      path,
      signal,
      body === undefined ? undefined : JSON.stringify(body),
    );

    const bytes = await boundedBody(response, 2 * 1024 * 1024, signal);

    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
}
