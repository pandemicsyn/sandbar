import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { Image, Sandbar, type AdapterRecoveryReference } from "sandbar-sdk";
import { createE2BAdapter } from "./index";
import { createSdkTransport } from "./transport";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture() {
  const calls: {
    method: string;
    path: string;
    body?: { path: string };
    signal?: AbortSignal | null;
  }[] = [];

  const detail = {
    sandboxID: "sandbox_one",
    templateID: "template_one",
    metadata: z.record(z.string(), z.string()).parse({}),
    state: "running",
    envdVersion: "0.5.0",
    envdAccessToken: "guest-token",
    domain: "e2b.app",
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: "kill", autoResume: false },
    endAt: "2026-10-02T01:00:00Z",
  };

  let code: string | undefined;
  let lost = false;
  let attachmentStatus = 200;

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const rpc = url.pathname.startsWith("/filesystem.Filesystem/");
      const body = rpc ? z.object({ path: z.string() }).parse(await request.json()) : undefined;
      calls.push({ method: request.method, path: url.pathname, body, signal: request.signal });

      if (rpc) {
        expect(request.headers.get("X-Access-Token")).toBe("guest-token");
        expect(request.headers.get("X-API-Key")).toBeNull();

        if (lost) throw new TypeError("lost guest acknowledgement");

        if (code)
          return Response.json(
            { code, message: "fixture native rejection" },
            { status: code === "not_found" ? 404 : 400 },
          );

        // Stat succeeding with an unknown symlink type still proves entry existence.
        if (url.pathname.endsWith("/Stat"))
          return Response.json({
            entry: {
              name: "link",
              type: "FILE_TYPE_UNSPECIFIED",
              path: body!.path,
              symlinkTarget: "/missing",
            },
          });

        return Response.json({});
      }

      if (url.pathname.startsWith("/teams/")) return Response.json({});

      if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
        detail.metadata = z
          .object({ metadata: z.record(z.string(), z.string()) })
          .parse(await request.json()).metadata;

        return Response.json(detail, { status: 201 });
      }

      if (url.pathname === "/sandboxes/sandbox_one")
        return Response.json(detail, { status: attachmentStatus });
      throw Error(`Unexpected native fixture ${request.method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  const connect = (onReference?: (ref: AdapterRecoveryReference) => void) =>
    Sandbar.connect({
      adapter: createE2BAdapter(({ apiKey }) => createSdkTransport(apiKey, fetcher)),
      config: { teamId: "team_one" },
      credentials: { apiKey: "test-key" },
      onReference,
    });

  return {
    calls,
    detail,
    connect,
    code(value?: string) {
      code = value;
    },
    lost() {
      lost = true;
    },
    attachmentStatus(value: number) {
      attachmentStatus = value;
    },
    rpcCalls: () => calls.filter((call) => call.path.startsWith("/filesystem.Filesystem/")),
  };
}

async function create(
  f: ReturnType<typeof fixture>,
  onReference?: (ref: AdapterRecoveryReference) => void,
) {
  const client = await f.connect(onReference);
  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return { client, box };
}

test("E2B pinned Stat: dangling entry exists, only guest NotFound is false, errors/attachment failures reject", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    expect(await box.fileExists("/home/user/link/")).toBe(true);
    expect(f.rpcCalls().at(-1)?.body).toEqual({ path: "/home/user/link" });
    f.code("not_found");
    expect(await box.fileExists("/home/user/missing")).toBe(false);

    for (const code of ["permission_denied", "unauthenticated", "internal", "unavailable"]) {
      f.code(code);
      await expect(box.fileExists("/home/user/file")).rejects.toMatchObject({ effect: "none" });
    }

    f.code();
    f.attachmentStatus(404);
    const before = f.rpcCalls().length;
    await expect(box.fileExists("/home/user/file")).rejects.toMatchObject({
      code: "NOT_FOUND",
      effect: "none",
    });
    expect(f.rpcCalls()).toHaveLength(before);
  } finally {
    await client.close();
  }
});

test("E2B native mkdir/remove require explicit recursion, issue one RPC and preserve ACK/missing success", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    expect(box.supports("listFiles")).toBe(true);
    expect(box.supports("fileExists")).toBe(true);
    await expect(box.removeFile("///", { recursive: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
    await expect(
      box.makeDirectory("/home/user/a", { recursive: true, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    expect(f.rpcCalls()).toHaveLength(0);
    await box.makeDirectory("//home/user///a/b//", { recursive: true });
    f.code("already_exists");
    await box.makeDirectory("/home/user/a/b", { recursive: true });
    f.code("invalid_argument");
    await expect(box.makeDirectory("/home/user/file", { recursive: true })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      effect: "none",
    });
    f.code();
    await box.removeFile("/home/user/link/", { recursive: true });
    await box.removeFile("/home/user/missing", { recursive: true });
    expect(f.rpcCalls().map((call) => [call.path.split("/").at(-1), call.body?.path])).toEqual([
      ["MakeDir", "/home/user/a/b"],
      ["MakeDir", "/home/user/a/b"],
      ["MakeDir", "/home/user/file"],
      ["Remove", "/home/user/link"],
      ["Remove", "/home/user/missing"],
    ]);
    expect(f.rpcCalls().every((call) => call.signal instanceof AbortSignal)).toBe(true);
  } finally {
    await client.close();
  }
});

for (const method of ["makeDirectory", "removeFile"] as const) {
  test(`E2B lost ${method} ACK retains intent; observation never replays`, async () => {
    const f = fixture();
    const saved: AdapterRecoveryReference[] = [];

    const { client, box } = await create(f, (ref) => {
      saved.push(ref);
    });

    try {
      f.code("permission_denied");
      await expect(box[method]("/home/user/partial", { recursive: true })).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        effect: "possible",
      });
      f.code();
      f.lost();
      await expect(box[method]("/home/user/job", { recursive: true })).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        effect: "possible",
      });
      const reference = saved.at(-1)!;
      expect(reference).toMatchObject({
        fileMutation: { path: "/home/user/job", recursive: true },
        sandboxReference: box.reference,
      });
      const recovered = await client.recover(JSON.parse(JSON.stringify(reference)));
      await expect(recovered.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      await expect(recovered.wait()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(f.rpcCalls()).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
}
