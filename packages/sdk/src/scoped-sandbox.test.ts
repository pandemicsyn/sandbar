import { expect, spyOn, test } from "bun:test";
import { defineAdapter, type AttemptContext, type DestroyValue } from "@sandbar-sdk/adapter";
import { z } from "zod";
import { Sandbar } from "./index";
import { Image, SandbarError } from "./resource";
import { SandboxCleanupError } from "./scoped-sandbox";

async function fixture(
  options: {
    destroy?: (
      input: { id: string; storage?: "require-durable" | "allow-unconfirmed" },
      ctx: AttemptContext,
    ) => Promise<DestroyValue | ReturnType<AttemptContext["pending"]>>;
    create?: () => Promise<{ id: string; state: "running" }>;
    storage?: "require-durable" | "allow-unconfirmed";
    onReference?: (
      reference: import("./adapter-direct").AdapterRecoveryReference,
    ) => void | Promise<void>;
  } = {},
) {
  let creates = 0;
  let destroys = 0;
  let closes = 0;
  const policies: unknown[] = [];

  const adapter = defineAdapter({
    name: "example.scope",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect({ host }) {
      host.onClose(() => {
        closes++;
      });

      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          creates++;

          return options.create ? options.create() : { id: "owned", state: "running" as const };
        },
        destroy: {
          recovery: { version: 1, token: z.object({ waiting: z.boolean() }) },
          async observe(attempt, ctx) {
            return ctx.pending(attempt.token!);
          },
          async submit(input, ctx) {
            destroys++;
            policies.push(input.storage);
            expect(input.id).toBe("owned");

            return options.destroy
              ? options.destroy(input, ctx)
              : { computeStopped: true as const, retainedResources: [] };
          },
        },
      };
    },
  });

  const client = await Sandbar.connect({
    adapter,
    config: {},
    credentials: {},
    cleanup: { storage: options.storage },
    onReference: options.onReference,
  });

  return { client, counts: () => ({ creates, destroys, closes }), policies };
}

const input = { environment: Image.prepared("fixture") };

test("scope creates once, returns callback value after destroy and leaves caller client open", async () => {
  const f = await fixture();
  const result = { answer: 42 };

  try {
    expect(
      await f.client.sandboxes.with(input, (sandbox) => {
        expect(sandbox.id).toBe("owned");
        expect(f.counts().destroys).toBe(0);

        return result;
      }),
    ).toBe(result);
    expect(f.counts()).toEqual({ creates: 1, destroys: 1, closes: 0 });
  } finally {
    await f.client.close();
  }
});

test("scope preserves arbitrary callback failures after successful cleanup", async () => {
  const f = await fixture();

  try {
    for (const failure of [undefined, null, "failure", { arbitrary: true }]) {
      let caught = false;

      try {
        await f.client.sandboxes.with(input, () => {
          throw failure;
        });
      } catch (error) {
        caught = true;
        expect(error).toBe(failure);
      }

      expect(caught).toBe(true);
    }

    expect(f.counts().destroys).toBe(4);
  } finally {
    await f.client.close();
  }
});

test("work cancellation uses a fresh cleanup signal and resolves configured storage policy/override", async () => {
  const controller = new AbortController();
  const retained: DestroyValue = { computeStopped: true, retainedResources: [] };

  const f = await fixture({
    storage: "allow-unconfirmed",
    destroy: async (_input, ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      expect(ctx.signal).not.toBe(controller.signal);

      return retained;
    },
  });

  try {
    await expect(
      f.client.sandboxes.with(
        input,
        () => {
          controller.abort();
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await f.client.sandboxes.with(input, () => {}, { storage: "require-durable" });
    expect(f.policies).toEqual(["allow-unconfirmed", "require-durable"]);
  } finally {
    await f.client.close();
  }
});

test("cleanup failure preserves completed result, both failures and operation recovery without retry", async () => {
  const f = await fixture({
    destroy: async () => {
      throw new Error("transport lost");
    },
  });

  try {
    for (const failed of [false, true]) {
      try {
        await f.client.sandboxes.with(input, () => {
          if (failed) throw undefined;

          return 42;
        });
        throw new Error("Expected cleanup failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SandboxCleanupError);

        if (!(error instanceof SandboxCleanupError)) throw error;
        expect(error.callbackOutcome).toEqual(
          failed ? { status: "failed", error: undefined } : { status: "completed", value: 42 },
        );
        expect(error.cleanupError).toBeDefined();
        expect(error.sandboxId).toBe("owned");
        expect(error.cleanupReference?.kind).toBe("destroy");
        expect(error.cleanupOperation?.reference).toEqual(error.cleanupReference);
      }
    }

    expect(f.counts().destroys).toBe(2);
  } finally {
    await f.client.close();
  }
});

test("cleanup budget bounds an unresponsive native destroy and retains owned identity", async () => {
  const f = await fixture({ destroy: async () => new Promise(() => {}) });

  try {
    await expect(
      f.client.sandboxes.with(input, () => 1, { cleanupTimeoutMs: 5 }),
    ).rejects.toMatchObject({
      code: "SANDBOX_CLEANUP_FAILED",
      callbackOutcome: { status: "completed", value: 1 },
      sandboxId: "owned",
    });
    expect(f.counts().destroys).toBe(1);
  } finally {
    await f.client.close();
  }
});

test("uncertain create never invokes callback or guesses an identity for destruction", async () => {
  const f = await fixture({
    create: async () => {
      throw new Error("create response lost");
    },
  });

  let callbacks = 0;

  try {
    await expect(
      f.client.sandboxes.with(input, () => {
        callbacks++;
      }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      reference: { kind: "create" },
    });
    expect(callbacks).toBe(0);
    expect(f.counts()).toEqual({ creates: 1, destroys: 0, closes: 0 });
  } finally {
    await f.client.close();
  }
});

test("scope validates cleanup options before allocation", async () => {
  const f = await fixture();

  try {
    for (const timeout of [0, -1, 0.5, 300_001, NaN]) {
      await expect(
        f.client.sandboxes.with(input, () => {}, { cleanupTimeoutMs: timeout }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }

    expect(f.counts().creates).toBe(0);
  } finally {
    await f.client.close();
  }
});

test("abort abandons a hanging callback and preserves cancellation plus cleanup failure", async () => {
  const f = await fixture({
    destroy: async () => {
      throw new Error("cleanup lost");
    },
  });

  const controller = new AbortController();
  const reason = new Error("work cancelled");
  let began!: () => void;

  const started = new Promise<void>((resolve) => {
    began = resolve;
  });

  try {
    const scope = f.client.sandboxes.with(
      input,
      () => {
        began();

        return new Promise<never>(() => {});
      },
      { signal: controller.signal },
    );

    await started;
    controller.abort(reason);
    await expect(scope).rejects.toMatchObject({
      callbackOutcome: { status: "failed", error: reason },
      cleanupReference: { kind: "destroy" },
    });
    expect(f.counts().destroys).toBe(1);
  } finally {
    await f.client.close();
  }
});

test("abort immediately after confirmed create skips callback and cleans the confirmed identity", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const create = f.client.sandboxes.create;

  const spy = spyOn(f.client.sandboxes, "create").mockImplementation(async (...args) => {
    const box = await create(...args);
    controller.abort();

    return box;
  });

  let callbacks = 0;

  try {
    await expect(
      f.client.sandboxes.with(
        input,
        () => {
          callbacks++;
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(callbacks).toBe(0);
    expect(f.counts().destroys).toBe(1);
  } finally {
    spy.mockRestore();
    await f.client.close();
  }
});

test("validated options are snapshotted before create can yield", async () => {
  let created!: () => void;
  let release!: () => void;

  const started = new Promise<void>((resolve) => {
    created = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const f = await fixture({
    create: async () => {
      created();
      await gate;

      return { id: "owned", state: "running" };
    },
  });

  const options = { storage: "allow-unconfirmed" as const, signal: new AbortController().signal };

  try {
    const scope = f.client.sandboxes.with(input, () => 42, options);
    await started;
    options.signal = AbortSignal.abort(new Error("replacement signal"));
    Object.assign(options, { storage: "invalid" });
    release();
    expect(await scope).toBe(42);
    expect(f.policies).toEqual(["allow-unconfirmed"]);
  } finally {
    await f.client.close();
  }
});

test("cleanup wrapper preserves checked outcome and retained-resource evidence", async () => {
  const f = await fixture();
  const sandbox = await f.client.sandboxes.create(input);
  const create = spyOn(f.client.sandboxes, "create").mockResolvedValue(sandbox);

  const original = new SandbarError(
    "STORAGE_UNCONFIRMED",
    "cleanup uncertain with retained storage",
    "possible",
    {
      kind: "destroy",
      status: "unknown",
      retainedVolumes: [
        {
          version: 1,
          kind: "volume",
          provider: "example.scope",
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          nativeId: "retained-volume",
          ownership: "verified-created",
        },
      ],
    },
  );

  const destroy = spyOn(sandbox, "submitDestroy").mockRejectedValue(original);

  try {
    await expect(f.client.sandboxes.with(input, () => "confirmed work")).rejects.toMatchObject({
      cleanupError: original,
      effect: "possible",
      outcome: original.outcome,
      callbackOutcome: { status: "completed", value: "confirmed work" },
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  } finally {
    create.mockRestore();
    destroy.mockRestore();
    await sandbox.destroy();
    await f.client.close();
  }
});

test("cleanup budget bounds a stalled reference hook and preserves the owned handle", async () => {
  const references: import("./adapter-direct").AdapterRecoveryReference[] = [];

  const f = await fixture({
    destroy: async (_input, ctx) => ctx.pending({ waiting: true }),
    onReference: async (reference) => {
      references.push(reference);

      if (reference.kind === "destroy" && reference.token) await new Promise(() => {});
    },
  });

  try {
    await expect(
      f.client.sandboxes.with(input, () => 42, { cleanupTimeoutMs: 10 }),
    ).rejects.toMatchObject({
      sandboxId: "owned",
      callbackOutcome: { status: "completed", value: 42 },
      cleanupError: { code: "TIMEOUT", effect: "possible" },
      effect: "possible",
    });
    expect(references.some((reference) => reference.kind === "destroy")).toBe(true);
  } finally {
    await f.client.close();
  }
});

test("pending cleanup preserves returned operation reference when observation budget expires", async () => {
  const f = await fixture({ destroy: async (_input, ctx) => ctx.pending({ waiting: true }) });

  try {
    await expect(
      f.client.sandboxes.with(input, () => 42, { cleanupTimeoutMs: 10 }),
    ).rejects.toMatchObject({
      cleanupReference: { kind: "destroy", token: { waiting: true } },
      effect: "possible",
      sandboxId: "owned",
    });
  } finally {
    await f.client.close();
  }
});

test("JavaScript malformed options and callbacks reject before create", async () => {
  const f = await fixture();

  try {
    for (const options of [
      null,
      1,
      [],
      { unknown: true },
      { signal: {} },
      { storage: "invalid" },
    ]) {
      await expect(
        // oxlint-disable-next-line anti-slop/no-reflect-apply -- Exercise malformed JavaScript input outside the public TypeScript contract.
        Reflect.apply(f.client.sandboxes.with, f.client.sandboxes, [input, () => {}, options]),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }

    await expect(
      // oxlint-disable-next-line anti-slop/no-reflect-apply -- Exercise a JavaScript caller supplying a non-callable callback.
      Reflect.apply(f.client.sandboxes.with, f.client.sandboxes, [input, null]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(f.counts().creates).toBe(0);
  } finally {
    await f.client.close();
  }
});
