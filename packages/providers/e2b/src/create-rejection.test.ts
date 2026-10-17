import { afterEach, expect, test } from "bun:test";
import { Sandbar } from "sandbar-sdk";
import { createE2BAdapter } from "./index";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

function nativeCreate(response: () => Response) {
  const creates: string[] = [];

  // SAFETY: This deterministic fetch boundary matches Bun's fetch/preconnect shape and receives only fixture credentials.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.pathname === "/v2/templates") return Response.json([]);

      if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
        creates.push(url.pathname);

        return response();
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  return creates;
}

const connect = () =>
  Sandbar.connect({
    adapter: createE2BAdapter(),
    config: {},
    credentials: { apiKey: "fixture-key" },
  });

test.each([
  [400, "INVALID_ARGUMENT"],
  [401, "UNAUTHENTICATED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [429, "RATE_LIMIT"],
] as const)(
  "E2B create HTTP %i is a clean %s rejection with the native reason",
  async (status, code) => {
    const creates = nativeCreate(() =>
      Response.json(
        { code: status, message: "Team has reached the concurrent sandbox limit\n(fixture-key)" },
        { status },
      ),
    );

    const client = await connect();

    try {
      const error = await client.sandboxes.create({ networkPolicy: "blocked" }).then(
        () => undefined,
        (failure: Error & { code?: string }) => failure,
      );

      expect(error).toMatchObject({ code });
      expect(error?.message).toContain("E2B rejected sandbox creation");
      expect(error?.message).toContain(
        "Team has reached the concurrent sandbox limit ([redacted])",
      );
      expect(error?.message).not.toContain("fixture-key");
      expect(creates).toHaveLength(1);
    } finally {
      await client.close();
    }
  },
);

test.each([409, 500, 503])("E2B create HTTP %i stays an unknown outcome", async (status) => {
  const creates = nativeCreate(() => Response.json({ code: status, message: "busy" }, { status }));
  const client = await connect();

  try {
    await expect(client.sandboxes.create({ networkPolicy: "blocked" })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(creates).toHaveLength(1);
  } finally {
    await client.close();
  }
});
