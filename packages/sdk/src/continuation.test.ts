import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "sandbar-adapter";
import { Sandbar, Image, type AdapterRecoveryReference } from "./index";

function fixture(
  onReference?: (reference: AdapterRecoveryReference) => Promise<void> | void,
  eagerAck = false,
) {
  let effects = 0;
  const token = z.strictObject({ stage: z.enum(["not-submitted", "uncertain", "completed"]) });
  const result = { computeStopped: true as const, retainedResources: [] };

  const adapter = defineAdapter({
    name: "fixture.continuation",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" };
        },
        destroy: {
          recovery: { version: 1, token },
          async submit(_input, ctx) {
            if (eagerAck) return ctx.pending({ stage: "completed" }, { pollAfterMs: 0 });
            await ctx.checkpoint({ stage: "not-submitted" });

            return ctx.pending({ stage: "not-submitted" }, { pollAfterMs: 0 });
          },
          async observe(attempt, ctx) {
            return token.parse(attempt.token).stage === "completed"
              ? result
              : ctx.unknown("Explicit continuation required");
          },
          async continue(attempt, ctx) {
            const saved = token.parse(attempt.token);

            if (saved.stage === "completed") return result;

            if (saved.stage !== "not-submitted")
              return ctx.unknown("Uncertain dispatch cannot be replayed");
            await ctx.checkpoint({ stage: "uncertain" });
            effects++;
            await ctx.checkpoint({ stage: "completed" });

            return result;
          },
        },
      };
    },
  });

  const connect = () => Sandbar.connect({ adapter, config: {}, credentials: {}, onReference });

  return { connect, effects: () => effects };
}

test("continuation awaits durable dispatch checkpoint and guards one handle against overlap", async () => {
  let release!: () => void;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  let started!: () => void;

  const checkpointStarted = new Promise<void>((resolve) => {
    started = resolve;
  });

  const f = fixture(async (reference) => {
    if (
      reference.token &&
      z.object({ stage: z.literal("uncertain") }).safeParse(reference.token).success
    ) {
      started();
      await blocked;
    }
  });

  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await box.submitDestroy();
    const identity = operation.reference.submissionId;
    const continuation = operation.continue();
    await checkpointStarted;
    expect(f.effects()).toBe(0);
    await expect(operation.continue()).rejects.toMatchObject({ code: "CONFLICT" });
    release();
    await continuation;
    expect(await operation.wait()).toMatchObject({ computeStopped: true });
    expect(operation.reference.submissionId).toBe(identity);
    expect(f.effects()).toBe(1);
    await (await operation.continue()).wait();
    expect(f.effects()).toBe(1);
  } finally {
    release();
    await client.close();
  }
});

for (const failure of ["uncertain", "completed"] as const) {
  test(`continuation checkpoint failure at ${failure} retains latest evidence without replay`, async () => {
    let storeAvailable = false;

    const f = fixture((reference) => {
      if (
        !storeAvailable &&
        z.object({ stage: z.literal(failure) }).safeParse(reference.token).success
      )
        throw new Error("Store failed");
    });

    const client = await f.connect();

    try {
      const box = await client.sandboxes.create({ environment: Image.prepared("base") });
      const operation = await box.submitDestroy();
      await expect(operation.continue()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        reference: { token: { stage: failure } },
      });
      expect(f.effects()).toBe(failure === "completed" ? 1 : 0);
      storeAvailable = true;
      const reference = JSON.parse(JSON.stringify(operation.reference));
      const recovered = await client.recover(reference);

      if (failure === "completed")
        expect(await recovered.wait()).toMatchObject({ computeStopped: true });
      else
        await expect((await recovered.continue()).wait()).rejects.toMatchObject({
          code: "OUTCOME_UNKNOWN",
        });
      expect(f.effects()).toBe(failure === "completed" ? 1 : 0);
    } finally {
      await client.close();
    }
  });
}

for (const persistenceFailure of [false, true]) {
  test(
    "returned pending acknowledgement persists before submit returns: " + persistenceFailure,
    async () => {
      let saved: AdapterRecoveryReference | undefined;
      let storeAvailable = !persistenceFailure;

      const f = fixture((reference) => {
        if (!z.object({ stage: z.literal("completed") }).safeParse(reference.token).success) return;
        saved = reference;

        if (!storeAvailable) throw Error("Persistence failed after effect");
      }, true);

      const client = await f.connect();

      try {
        const box = await client.sandboxes.create({ environment: Image.prepared("base") });

        if (persistenceFailure)
          await expect(box.submitDestroy()).rejects.toMatchObject({
            code: "OUTCOME_UNKNOWN",
            reference: { token: { stage: "completed" } },
          });
        else await box.submitDestroy();
        expect(saved?.token).toEqual({ stage: "completed" });
        storeAvailable = true;
        const fresh = await f.connect();

        try {
          expect(await (await fresh.recover(saved!)).wait()).toMatchObject({
            computeStopped: true,
          });
        } finally {
          await fresh.close();
        }
      } finally {
        await client.close();
      }
    },
  );
}
