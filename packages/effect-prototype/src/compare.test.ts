import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider } from "@sandbar/provider-fake/client";
import { startFakeProviderServer } from "@sandbar/provider-fake/server";
import { ProviderReadError } from "@sandbar/provider-spi";
import { Image, OutcomeUnknownError, Sandbar } from "@sandbar/sdk/direct";
import { EffectCreateClient } from "./index";

const token = "effect-prototype-test-token";

type ControlBody =
  | {
      submissionId: string;
      action: "create";
      behavior: "lost_after_effect" | "reject";
      rejectCode?: "capacity" | "unsupported" | "conflict";
    }
  | {
      nativeIdempotency: { create: boolean; exec: boolean; destroy: boolean; writeFile: boolean };
      discoveryBySubmission: boolean;
    };

const variants = {
  baseline: (provider: Awaited<ReturnType<typeof fakeProvider>>) => Sandbar.direct({ provider }),
  effect: (provider: Awaited<ReturnType<typeof fakeProvider>>) =>
    new EffectCreateClient({ provider }),
};

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sandbar-effect-"));

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "fake.json"),
    token,
    testMode: true,
  });

  const url = server.url.toString();
  cleanup = async () => {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  };

  const control = async (path: string, body?: ControlBody): Promise<any> => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Fixture control failed: ${response.status}`);

    return response.json();
  };

  return { provider: await fakeProvider({ url, token }), control };
}

const input = { environment: Image.prepared("fake-starter") };

const createCount = (state: any) =>
  state.invocations.filter((x: any) => x.action === "create").length;

const timeout = <T>(promise: Promise<T>, ms = 300): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("wait leaked")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

for (const [name, make] of Object.entries(variants)) {
  test(`${name}: pre-abort and abort during preparation never create`, async () => {
    const { provider, control } = await fixture();
    const client = make(provider);
    const before = new AbortController();
    before.abort(new Error("before"));
    await expect(client.sandboxes.create(input, { signal: before.signal })).rejects.toBe(
      before.signal.reason,
    );
    expect(createCount(await control("/_test/state"))).toBe(0);
    const original = provider.driver.prepare.bind(provider.driver);
    let entered!: () => void, release!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    provider.driver.prepare = async (request) => {
      entered();
      await gate;

      return original(request);
    };

    const abort = new AbortController();
    const pending = client.sandboxes.create(input, { signal: abort.signal });
    await started;
    abort.abort(new Error("during preparation"));
    await expect(timeout(pending)).rejects.toBe(abort.signal.reason);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(createCount(await control("/_test/state"))).toBe(0);
    await client.close();
  });

  test(`${name}: applied lost response recovers read-only without replay`, async () => {
    const { provider, control } = await fixture();
    const client = make(provider);
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "lost_after_effect",
    });
    const operation = await client.sandboxes.submitCreate(input);
    const ref = JSON.parse(JSON.stringify(operation.reference));
    await client.close();
    const next = make(provider);
    const box = await (await next.recover(ref)).wait();
    expect(box.id).toStartWith("fake_sandbox_");
    expect(createCount(await control("/_test/state"))).toBe(1);
    await next.close();
  });

  test(`${name}: close during pending submission preserves recovery and compute`, async () => {
    const { provider, control } = await fixture();
    const original = provider.driver.create.bind(provider.driver);
    let entered!: () => void, release!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    provider.driver.create = async (request) => {
      const result = await original(request);
      entered();
      await gate;

      return result;
    };

    const client = make(provider);
    const pending = client.sandboxes.create(input);
    await started;
    await timeout(client.close());
    await expect(timeout(pending)).rejects.toBeInstanceOf(OutcomeUnknownError);
    release();
    expect(createCount(await control("/_test/state"))).toBe(1);
    expect((await control("/_test/state")).resources).toHaveLength(1);
  });

  test(`${name}: hanging observation stops promptly and never repeats create`, async () => {
    const { provider, control } = await fixture();
    const original = provider.driver.create.bind(provider.driver);
    provider.driver.create = async (request) => {
      await original(request);

      return {
        status: "pending",
        effect: "possible",
        submissionId: request.identity.submissionId,
        observeAfterMs: 50,
      };
    };

    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);
    let entered!: () => void, release!: () => void;

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    provider.driver.observe = async () => {
      entered();
      await gate;

      return null;
    };

    const abort = new AbortController();
    const pending = operation.wait({ signal: abort.signal, pollMs: 50 });
    await started;
    abort.abort(new Error("stop observation"));
    await expect(timeout(pending)).rejects.toBe(abort.signal.reason);
    release();
    expect(createCount(await control("/_test/state"))).toBe(1);
    await client.close();
  });

  test(`${name}: malformed receipt cannot certify no effect`, async () => {
    const { provider, control } = await fixture();
    const original = provider.driver.create.bind(provider.driver);
    provider.driver.create = async (request) => {
      await original(request);

      // SAFETY: this test intentionally violates DriverResult to verify malformed receipt handling.
      return {
        status: "completed",
        effect: "applied",
        submissionId: request.identity.submissionId,
        value: { kind: "sandbox", observation: { bogus: true } },
      } as never;
    };

    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);
    await expect(operation.wait()).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: operation.reference,
    });
    expect(createCount(await control("/_test/state"))).toBe(1);
    await client.close();
  });

  test(`${name}: successful client close leaves remote compute for new client`, async () => {
    const { provider, control } = await fixture();
    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);
    const box = await operation.wait();
    const ref = operation.reference;
    await timeout(client.close());
    expect((await control("/_test/state")).resources).toHaveLength(1);
    const next = make(provider);
    expect((await (await next.recover(ref)).wait()).id).toBe(box.id);
    expect(createCount(await control("/_test/state"))).toBe(1);
    await next.close();
  });

  test(`${name}: undiscoverable lost effect remains unknown`, async () => {
    const { provider, control } = await fixture();
    await control("/_test/profile", {
      nativeIdempotency: { create: false, exec: false, destroy: false, writeFile: false },
      discoveryBySubmission: false,
    });
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "lost_after_effect",
    });
    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);
    await expect(operation.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(createCount(await control("/_test/state"))).toBe(1);
    await client.close();
  });

  test(`${name}: synchronous transport throw after dispatch is observed, never replayed`, async () => {
    const { provider, control } = await fixture();
    const original = provider.driver.create.bind(provider.driver);
    provider.driver.create = (request) => {
      void original(request);
      throw new Error("transport adapter threw after dispatch");
    };

    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);

    try {
      await operation.wait();
    } catch (error) {
      expect(error).toBeInstanceOf(OutcomeUnknownError);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(createCount(await control("/_test/state"))).toBe(1);
    await client.close();
  });

  test(`${name}: source distinguishes certified submission rejection from observed rejection`, async () => {
    const { provider, control } = await fixture();
    await control("/_test/seed", {
      submissionId: "*",
      action: "create",
      behavior: "reject",
      rejectCode: "capacity",
    });
    const client = make(provider);
    const rejected = await client.sandboxes.submitCreate(input);
    await expect(rejected.wait()).rejects.toMatchObject({ code: "CAPACITY", effect: "none" });
    await expect(rejected.wait()).rejects.toMatchObject({ code: "CAPACITY", effect: "none" });
    await expect(rejected.observe()).rejects.toMatchObject({ code: "CAPACITY", effect: "none" });
    expect(createCount(await control("/_test/state"))).toBe(1);
    await client.close();

    const next = make(provider);
    const recovered = await next.recover(rejected.reference);
    await expect(recovered.wait()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(createCount(await control("/_test/state"))).toBe(1);
    await next.close();
  });

  test(`${name}: provider preflight read error maps to SDK error without dispatch`, async () => {
    const { provider, control } = await fixture();
    provider.driver.capabilities = async () => {
      throw new ProviderReadError("INVALID_RESPONSE", "bad capabilities");
    };

    const client = make(provider);
    await expect(client.sandboxes.submitCreate(input)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      effect: "none",
    });
    expect(createCount(await control("/_test/state"))).toBe(0);
    await client.close();
  });

  test(`${name}: created reference and scope are immutable snapshots`, async () => {
    const { provider } = await fixture();
    const client = make(provider);
    const operation = await client.sandboxes.submitCreate(input);
    expect(Object.isFrozen(operation.reference)).toBe(true);
    expect(Object.isFrozen(operation.reference.scope)).toBe(true);
    provider.scope.accountId = "changed-after-client-construction";
    expect(operation.reference.scope?.accountId).toBe("fake-local");
    expect(client.scope.accountId).toBe("fake-local");
    await client.close();
  });
}
