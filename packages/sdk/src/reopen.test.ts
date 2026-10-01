import { expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type AdapterSession,
} from "sandbar-adapter";
import { Sandbar, Image } from "./index";

function fixture(reopening: boolean) {
  const scope = { authority: { kind: "fixture", id: "account" }, partition: {} };

  const reference = sandboxReference("reopen-fixture", scope, "native", {
    operation: "op",
    submission: "submission",
  });

  let hold = false;
  let inspected = 0;

  const adapter = defineAdapter({
    name: "reopen-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      const session: AdapterSession = {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          if (reopening) return { id: "native", state: "running", reference };

          return { id: "native", state: "running" };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
        async inspect() {
          return { id: "native", state: "running" };
        },
      };

      if (reopening)
        session.reopen = async () => {
          inspected++;

          if (hold) await new Promise(() => {});

          return {
            ...unknownSandboxFacts(),
            reference,
            nativeState: "native-running",
            state: "running",
            observedAt: new Date().toISOString(),
          };
        };

      return session;
    },
  });

  return {
    connect: () => Sandbar.connect({ adapter, config: {}, credentials: {} }),
    reference,
    hold() {
      hold = true;
    },
    inspected: () => inspected,
  };
}

test("legacy adapter inspection remains useful with null reference and unsupported reopening", async () => {
  const f = fixture(false);
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fixture") });
    expect(box.reference).toBeNull();
    expect(await box.inspect()).toMatchObject({
      state: "running",
      reference: null,
      nativeState: null,
      expires: { status: "unknown" },
    });
    expect((await client.capabilities()).lifecycle.reopen.status).toBe("unsupported");
    await expect(client.sandboxes.get(f.reference)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }
});

test("reopen rejects mismatched scope before native IO and normalizes caller cancellation", async () => {
  const f = fixture(true);
  const client = await f.connect();

  try {
    await expect(client.sandboxes.get({ ...f.reference, provider: "other" })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    expect(f.inspected()).toBe(0);
    f.hold();
    const controller = new AbortController();
    const opening = client.sandboxes.get(f.reference, { signal: controller.signal });
    await Promise.resolve();
    controller.abort("caller stop");
    await expect(opening).rejects.toMatchObject({ code: "WAIT_ABORTED" });
  } finally {
    await client.close();
  }
});
