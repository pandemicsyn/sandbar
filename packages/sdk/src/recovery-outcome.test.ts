import { expect, test } from "bun:test";
import { z } from "zod";
import {
  checkpointBeforeDispatch,
  defineAdapter,
  type Json,
  type RecoveryFacts,
} from "sandbar-adapter";
import {
  Sandbar,
  Image,
  OutcomeUnknownError,
  ReferencePersistenceError,
  recoveryOutcome,
  type AdapterRecoveryReference,
} from "./index";
import { bindAdapter } from "./bound";

function gate() {
  let release!: () => void;

  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

function fixture(lostAck = false, heldObservation?: ReturnType<typeof gate>, largeScope = false) {
  const scope = {
    authority: { kind: "account", id: "one" },
    partition: Object.fromEntries(
      largeScope ? Array.from({ length: 5 }, (_, index) => [String(index), "x".repeat(1800)]) : [],
    ),
  };

  const retained = {
    version: 1 as const,
    kind: "volume" as const,
    provider: "fixture.facts",
    scope,
    nativeId: "volume",
    ownership: "verified-created" as const,
  };

  const token = z.strictObject({ stage: z.enum(["prepared", "uncertain", "completed"]) });
  let effects = 0;

  const facts = (input: Json): RecoveryFacts => {
    const { stage } = token.parse(input);
    let status: RecoveryFacts["continuation"]["status"] = "unavailable";

    if (stage === "prepared") status = "eligible";

    if (stage === "uncertain") status = "unknown";

    return {
      version: 1,
      retainedResources: [retained],
      completed: stage === "completed" ? [{ step: "compute-stop" }] : [],
      steps: [{ step: "compute-stop", status: stage === "prepared" ? "pending" : stage }],
      source: {
        state: stage === "completed" ? "destroyed" : "unknown",
        observedAt: "2026-09-29T12:00:00.000Z",
        provenance: "provider-read",
      },
      continuation: {
        supported: true,
        status,
        reason:
          stage === "prepared"
            ? "Proven unsubmitted stage"
            : "Observe only; never replay uncertain effects",
      },
    };
  };

  const adapter = defineAdapter({
    name: "fixture.facts",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        destroy: {
          recovery: { version: 1, token, facts },
          async submit(_box, ctx) {
            await ctx.checkpoint({ stage: "prepared" });

            return ctx.pending({ stage: "prepared" });
          },
          async observe(attempt, ctx) {
            await heldObservation?.promise;

            return token.parse(attempt.token).stage === "completed"
              ? { computeStopped: true, retainedResources: ["volume"] }
              : ctx.unknown("Completion is unconfirmed");
          },
          async continue(attempt, ctx) {
            const stage = token.parse(attempt.token).stage;

            if (stage === "prepared") {
              if (!(await checkpointBeforeDispatch(ctx, { stage: "uncertain" })))
                return ctx.pending({ stage: "prepared" });
              effects++;

              if (lostAck) throw new Error("Acknowledgement lost");
              await ctx.checkpoint({ stage: "completed" });
            }

            if (stage === "prepared")
              return { computeStopped: true, retainedResources: ["volume"] };

            return ctx.pending({ stage });
          },
        },
      };
    },
  });

  const connect = (onReference?: (reference: AdapterRecoveryReference) => Promise<void> | void) =>
    Sandbar.connect(bindAdapter(adapter, {}, {}), { onReference });

  return { connect, effects: () => effects, retained };
}

test("bound connection awaits initial persistence and dispatch checkpoints", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect(async (reference) => {
    saved = JSON.parse(JSON.stringify(reference));

    if (reference.facts?.steps[0]?.status === "uncertain") {
      entered.release();
      await held.promise;
    }
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });
    const operation = await box.submitDestroy();
    expect(operation.outcome.continuation).toMatchObject({ supported: true, status: "eligible" });
    expect(operation.outcome.retainedResources).toEqual([f.retained]);
    const continuing = operation.continue();
    await entered.promise;
    expect(f.effects()).toBe(0);
    expect(saved?.facts?.continuation.status).toBe("unknown");
    held.release();
    await continuing;
    await operation.wait();
    expect(f.effects()).toBe(1);
    expect(operation.outcome.completed).toContainEqual({ step: "compute-stop" });
    expect(operation.outcome.continuation.status).toBe("unavailable");
    expect(saved?.completion).toEqual(
      JSON.parse(JSON.stringify(operation.outcome.reference.completion)),
    );
  } finally {
    held.release();
    await client.close();
  }
});

for (const failure of ["before", "after"] as const) {
  test(`facts and authority survive ${failure}-effect checkpoint failure without mutation replay`, async () => {
    const f = fixture();
    let latest: AdapterRecoveryReference | undefined;

    const client = await f.connect((reference) => {
      latest = JSON.parse(JSON.stringify(reference));

      if (reference.facts?.steps[0]?.status === (failure === "before" ? "uncertain" : "completed"))
        throw new Error("Store offline");
    });

    try {
      const operation = await (
        await client.sandboxes.create({ environment: Image.prepared("base") })
      ).submitDestroy();

      const error = await operation.continue().then(
        () => undefined,
        (error: Error) => error,
      );

      expect(error).toBeInstanceOf(ReferencePersistenceError);

      if (!(error instanceof ReferencePersistenceError))
        throw new Error("Expected persistence error");
      expect(error.outcome?.retainedResources).toEqual([f.retained]);
      expect(error.outcome?.reference).toEqual(operation.reference);
      expect(f.effects()).toBe(failure === "before" ? 0 : 1);
      const fresh = await f.connect();

      try {
        const recovered = await fresh.recover(latest!);
        expect(recovered.kind).toBe("destroy");
        expect(recovered.outcome.retainedResources).toEqual([f.retained]);

        if (failure === "after")
          expect(await recovered.wait()).toMatchObject({ computeStopped: true });
        else
          await expect((await recovered.continue()).wait()).rejects.toMatchObject({
            code: "OUTCOME_UNKNOWN",
          });
        expect(f.effects()).toBe(failure === "before" ? 0 : 1);
      } finally {
        await fresh.close();
      }
    } finally {
      await client.close();
    }
  });
}

test("cancellation while saving a dispatch checkpoint prevents mutation and preserves facts", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();

  const client = await f.connect(async (reference) => {
    if (reference.facts?.steps[0]?.status === "uncertain") {
      entered.release();
      await held.promise;
    }
  });

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    const abort = new AbortController();
    const work = operation.continue({ signal: abort.signal });
    await entered.promise;
    abort.abort();
    held.release();
    await work;
    expect(f.effects()).toBe(0);
    expect(operation.outcome.retainedResources).toEqual([f.retained]);
  } finally {
    held.release();
    await client.close();
  }
});

test("missing facts stay unknown and public outcome data cannot alter dispatch authority", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    const legacy = { ...operation.reference, facts: undefined };
    const recovered = await client.recover(legacy);
    expect(recovered.outcome.completed).toEqual([]);
    expect(recovered.outcome.continuation.status).toBe("unknown");
    expect(recovered.outcome.source).toBeUndefined();
    expect(() => Reflect.set(operation, "reference", legacy)).not.toThrow();
    expect(Reflect.set(operation, "reference", legacy)).toBe(false);
    expect(Reflect.set(operation.outcome.continuation, "status", "eligible")).toBe(false);
    expect(recoveryOutcome(operation.reference)).toEqual(operation.outcome);
    await (await operation.continue()).wait();
    expect(f.effects()).toBe(1);
    const invalid = JSON.parse(JSON.stringify(operation.reference));
    invalid.facts.version = 2;
    await expect(client.recover(invalid)).rejects.toThrow();
  } finally {
    await client.close();
  }
});

test("lost acknowledgement stays uncertain across fresh recovery and cannot replay", async () => {
  const f = fixture(true);
  const client = await f.connect();

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    await expect(operation.continue()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(operation.outcome.steps).toContainEqual({ step: "compute-stop", status: "uncertain" });
    expect(operation.outcome.completed).toEqual([]);
    const fresh = await f.connect();

    try {
      const recovered = await fresh.recover(JSON.parse(JSON.stringify(operation.reference)));
      await expect((await recovered.continue()).wait()).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
      });
      expect(recovered.outcome.continuation.status).toBe("unknown");
      expect(f.effects()).toBe(1);
    } finally {
      await fresh.close();
    }
  } finally {
    await client.close();
  }
});

test("a stale read cannot install old facts after a newer continuation checkpoint", async () => {
  const held = gate();
  const f = fixture(false, held);
  const client = await f.connect();

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    expect(await operation.observe()).toBeNull();
    const stale = operation.observe();
    await operation.continue();
    held.release();
    expect(await stale).toBeNull();
    expect(operation.outcome.completed).toContainEqual({ step: "compute-stop" });
    expect(operation.outcome.continuation.status).toBe("unavailable");
    await operation.wait();
    expect(f.effects()).toBe(1);
  } finally {
    held.release();
    await client.close();
  }
});

test("acknowledged facts with a nine KiB scope persist and recover through the SDK", async () => {
  const f = fixture(false, undefined, true);
  let saved: AdapterRecoveryReference | undefined;

  const client = await f.connect((reference) => {
    saved = JSON.parse(JSON.stringify(reference));
  });

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    await (await operation.continue()).wait();
    expect(f.effects()).toBe(1);
    expect(operation.outcome.retainedResources).toEqual([f.retained]);
    expect(new TextEncoder().encode(JSON.stringify(saved!.facts)).length).toBeGreaterThan(8192);
    const fresh = await f.connect();

    try {
      const recovered = await fresh.recover(saved!);
      expect(await recovered.wait()).toMatchObject({ computeStopped: true });
      expect(recovered.outcome.retainedResources).toEqual([f.retained]);
      expect(f.effects()).toBe(1);
    } finally {
      await fresh.close();
    }
  } finally {
    await client.close();
  }
});

test("partial failure distinguishes eligible continuation from manual action", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const operation = await (
      await client.sandboxes.create({ environment: Image.prepared("base") })
    ).submitDestroy();

    const base = operation.reference;

    const facts: RecoveryFacts = {
      version: 1,
      retainedResources: [f.retained],
      completed: [{ step: "capture" }],
      steps: [
        { step: "capture", status: "completed" },
        {
          step: "restart",
          status: "failed",
          reason:
            "Restart definitively rejected; restart source manually or restore the retained snapshot",
        },
      ],
      continuation: { supported: true, status: "unavailable", reason: "Manual recovery required" },
    };

    const error = new OutcomeUnknownError({ ...base, facts });
    expect(error.outcome?.nextAction).toBe("manual");
    expect(error.outcome?.continuation.supported).toBe(true);
    expect(error.outcome?.retainedResources).toEqual([f.retained]);
    expect(error.outcome?.completed).toEqual([{ step: "capture" }]);

    const eligible = recoveryOutcome({
      ...base,
      facts: {
        ...facts,
        continuation: { supported: true, status: "eligible", reason: "Restart proven unsubmitted" },
      },
    });

    expect(eligible.nextAction).toBe("continue");

    const uncertain = recoveryOutcome({
      ...base,
      facts: {
        ...facts,
        steps: [{ step: "restart", status: "uncertain" }],
        continuation: { supported: true, status: "unknown", reason: "Restart response lost" },
      },
    });

    expect(uncertain.nextAction).toBe("observe");

    for (const status of ["pending", "uncertain"] as const) {
      const unavailable = recoveryOutcome({
        ...base,
        facts: {
          ...facts,
          steps: [{ step: "restart", status }],
          continuation: { supported: true, status: "unavailable", reason: "Observe only" },
        },
      });

      expect(unavailable.nextAction).toBe("observe");
      expect(
        recoveryOutcome({
          ...unavailable.reference,
          facts: {
            ...facts,
            steps: [{ step: "restart", status }],
            continuation: { ...unavailable.continuation, action: "manual" },
          },
        }).nextAction,
      ).toBe("manual");
    }

    const rich = { ...f.retained, history: { revision: "confirmed" }, receipt: "saved" };

    const mounted = recoveryOutcome({
      ...base,
      facts: { ...facts, retainedResources: [rich] },
      mounts: [
        { volume: { ...f.retained, ownership: "unknown" }, path: "/data", access: "read-write" },
      ],
    });

    expect(mounted.retainedResources).toEqual([rich]);

    const explicitNullHistory = recoveryOutcome({
      ...base,
      facts: { ...facts, retainedResources: [rich] },
      completion: {
        version: 1,
        resources: [{ kind: rich.kind, nativeId: rich.nativeId, history: null }],
      },
    });

    expect(explicitNullHistory.retainedResources[0]?.history).toBeNull();
    expect(explicitNullHistory.reference.facts?.retainedResources[0]?.history).toEqual(
      rich.history,
    );
  } finally {
    await client.close();
  }
});
