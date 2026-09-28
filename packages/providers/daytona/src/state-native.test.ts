import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image, OutcomeUnknownError } from "sandbar-sdk";
import { daytonaState } from "./state-native";

function fixture() {
  const scope = { authority: { kind: "organization", id: "org-one" }, partition: { target: "us" } };
  let state = "started";
  let mounted = false;

  let snapshot: {
    id: string;
    name: string;
    organizationId: string;
    general: boolean;
    state: string;
    sourceSandboxId: string;
    sandboxClass: string;
    regionIds: string[];
  } | null = null;

  const calls = { stop: 0, capture: 0, delete: 0 };
  let failedDelete = false;

  // SAFETY: The deterministic fetch fixture implements the native request signature and preconnect property.
  const fetcher = Object.assign(
    async (value: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(value));
      const method = init?.method ?? "GET";

      if (url.pathname === "/sandbox/source") {
        return Response.json({
          id: "source",
          organizationId: "org-one",
          target: "us",
          state,
          sandboxClass: "container",
          volumes: mounted ? [{ volumeId: "external", mountPath: "/mnt/data" }] : [],
        });
      }

      if (url.pathname === "/sandbox/source/stop" && method === "POST") {
        calls.stop++;
        state = "stopped";

        return Response.json({});
      }

      if (url.pathname === "/sandbox/source/snapshot" && method === "POST") {
        calls.capture++;

        const request = z
          .object({ name: z.string(), includeMemory: z.literal(false) })
          .parse(JSON.parse(String(init?.body)));

        snapshot = {
          id: "snapshot-one",
          name: request.name,
          organizationId: "org-one",
          general: false,
          state: "active",
          sourceSandboxId: "source",
          sandboxClass: "container",
          regionIds: ["us"],
        };

        return Response.json({ id: "source", state: "stopped" });
      }

      if (url.pathname.startsWith("/snapshots/")) {
        if (method === "DELETE") {
          calls.delete++;
          snapshot = null;

          return new Response(null, { status: failedDelete ? 500 : 204 });
        }

        const id = decodeURIComponent(url.pathname.slice("/snapshots/".length));

        return snapshot && (snapshot.id === id || snapshot.name === id)
          ? Response.json(snapshot)
          : new Response(null, { status: 404 });
      }

      if (url.pathname === "/volumes") return Response.json([]);
      throw new Error(`Unexpected fixture route ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const connect = (onReference?: (ref: { kind: string }) => void) => {
    const resource = daytonaState({
      scope,
      apiUrl: "https://fixture.invalid",
      apiKey: "fixture-key",
      target: "us",
      fetch: fetcher,
    });

    return Sandbar.connect({
      adapter: defineAdapter({
        name: "daytona",
        config: z.strictObject({}),
        credentials: z.strictObject({}),
        async connect() {
          return {
            ...resource.fields,
            scope,
            supports: { images: ["prepared"], network: ["blocked"] },
            async create() {
              return { id: "source", state: "running" };
            },
            async destroy() {
              return { computeStopped: true, retainedResources: [] };
            },
            async inspect(box) {
              return { id: box.id, state: state === "stopped" ? "stopped" : "running" };
            },
          };
        },
      }),
      config: {},
      credentials: {},
      onReference,
    });
  };

  return {
    connect,
    calls,
    setState(value: string) {
      state = value;
    },
    mount() {
      mounted = true;
    },
    shareSnapshot() {
      if (snapshot) snapshot.general = true;
    },
    failDelete() {
      failedDelete = true;
    },
  };
}

test("Daytona cold capture explicitly stops once, uses includeMemory false, and reopens acknowledged provenance", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  await expect(source.snapshot({ preserve: "filesystem" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(f.calls.stop).toBe(0);

  const result = await source.snapshot({
    preserve: "filesystem",
    maxInterruption: "stop",
    sourceAfter: "stopped",
    consistency: "caller-quiesced",
  });

  expect(f.calls).toEqual({ stop: 1, capture: 1, delete: 0 });
  expect(result.source.state).toBe("stopped");
  const saved = structuredClone(result.snapshot.reference);
  await client.close();
  const reopened = await f.connect();
  const snapshot = await reopened.snapshots.get(saved);
  expect((await snapshot.inspect()).mountHandling).toBe("none");
  await snapshot.delete();
  expect(f.calls.delete).toBe(1);
  await reopened.close();
});

test("Daytona external mounts reject snapshot capture before stop or retained storage allocation", async () => {
  const f = fixture();
  f.mount();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  await expect(
    source.snapshot({
      preserve: "filesystem",
      maxInterruption: "stop",
      sourceAfter: "stopped",
      consistency: "caller-quiesced",
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls.stop).toBe(0);
  expect(f.calls.capture).toBe(0);
  await client.close();
});

test("Daytona absence cannot turn a failed delete into successful correlated cleanup", async () => {
  const f = fixture();
  const client = await f.connect();
  const source = await client.sandboxes.create({ environment: Image.prepared("base") });

  const result = await source.snapshot({
    preserve: "filesystem",
    maxInterruption: "stop",
    sourceAfter: "stopped",
    consistency: "caller-quiesced",
  });

  f.failDelete();
  const operation = await result.snapshot.submitDelete();
  await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  const recovered = await client.recover(operation.reference);
  await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.delete).toBe(1);
  await client.close();
});

test("Daytona capture revalidates unchanged stopped source after the durable barrier", async () => {
  const f = fixture();
  f.setState("stopped");

  const client = await f.connect((ref) => {
    if (ref.kind === "snapshot_capture") f.setState("started");
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });
  await expect(
    source.snapshot({
      preserve: "filesystem",
      sourceAfter: "unchanged",
      consistency: "caller-quiesced",
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.calls.stop).toBe(0);
  expect(f.calls.capture).toBe(0);
  await client.close();
});

test("Daytona deletion refuses changed shared ownership after the durable barrier", async () => {
  const f = fixture();

  const client = await f.connect((ref) => {
    if (ref.kind === "snapshot_delete") f.shareSnapshot();
  });

  const source = await client.sandboxes.create({ environment: Image.prepared("base") });

  const result = await source.snapshot({
    preserve: "filesystem",
    maxInterruption: "stop",
    sourceAfter: "stopped",
    consistency: "caller-quiesced",
  });

  await expect(result.snapshot.delete()).rejects.toBeInstanceOf(OutcomeUnknownError);
  expect(f.calls.delete).toBe(0);
  await client.close();
});
