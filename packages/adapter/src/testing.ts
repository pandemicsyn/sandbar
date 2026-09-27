import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type AdapterDefinition,
  type CreateInput,
  type Guarantees,
  type Scope,
  AdapterError,
} from "./index";
import type { z } from "zod";

type Counters = { create: number; destroy: number; release: number };

export type AdapterSuiteFixture<C extends z.ZodType, K extends z.ZodType> = {
  config: z.input<C>;
  credentials: z.input<K>;
  alternate: { config: z.input<C>; credentials: z.input<K> };
  createInput: CreateInput;
  counters(): Counters;
  /** Fault is injected after a real native effect, before its response reaches the adapter. */
  loseNextCreateResponse(): void | Promise<void>;
  /** Pause a response after the native effect so the local wait can be aborted. */
  holdNextCreateResponse(): void | Promise<void>;
  releaseHeldCreateResponse(): void | Promise<void>;
  /** Provider-specific proof that its native mutation transport performs one outbound attempt. */
  assertNativeRetriesDisabled(): void | Promise<void>;
};

export type AdapterSuiteReport = {
  readonly scenarios: readonly string[];
  readonly counters: Counters;
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Adapter conformance: ${message}`);
}

function identity() {
  const id = () => `suite_${crypto.randomUUID().replaceAll("-", "")}`;
  return { operationId: id(), submissionId: id(), invocationKey: id() };
}

export async function adapterSuite<
  C extends z.ZodType,
  K extends z.ZodType,
  S extends { scope: Scope; supports: Guarantees; create: unknown; destroy: unknown },
>(options: {
  adapter: AdapterDefinition<C, K, S>;
  fixture: AdapterSuiteFixture<C, K>;
  cases?: readonly ("create" | "destroy")[];
}): Promise<AdapterSuiteReport> {
  const { adapter, fixture } = options;
  const cases = new Set(options.cases ?? ["create", "destroy"]);
  requireCondition(cases.has("create") && cases.has("destroy"), "managed adapters must test create and destroy");
  for (const hook of ["loseNextCreateResponse", "holdNextCreateResponse",
    "releaseHeldCreateResponse", "assertNativeRetriesDisabled"] as const)
    requireCondition(typeof fixture[hook] === "function", `fixture must implement ${hook}`);
  const scenarios: string[] = [];
  await fixture.assertNativeRetriesDisabled();
  scenarios.push("native single-attempt evidence");

  const before = fixture.counters();
  const connection = await connectAdapter(adapter, {
    config: fixture.config, credentials: fixture.credentials,
  });
  try {
    const alternate = await connectAdapter(adapter, {
      config: fixture.alternate.config, credentials: fixture.alternate.credentials,
    });
    try {
      requireCondition(
        JSON.stringify(connection.scope) !== JSON.stringify(alternate.scope),
        "alternate verified authority or endpoint must produce another scope",
      );
      scenarios.push("independent verified scopes");
    } finally {
      await alternate.close();
    }

    const invalidBefore = fixture.counters().create;
    try {
      await prepareOperation(connection.session, "create", {
        ...fixture.createInput,
        networkPolicy: "__sandbar_unsupported__",
      }, connection.signal);
      throw new Error("Unsupported create reached preparation");
    } catch (error) {
      requireCondition(error instanceof AdapterError && error.code === "UNSUPPORTED",
        "unsupported create must reject locally");
    }
    requireCondition(fixture.counters().create === invalidBefore, "invalid create performed provider IO");
    scenarios.push("unsupported preflight before mutation");

    const prepared = await prepareOperation(
      connection.session, "create", fixture.createInput, connection.signal,
    );
    const created = await submitOperation(prepared, identity(), connection.signal);
    requireCondition(created.kind === "completed" && "id" in created.value,
      "normal create must return a plain sandbox completion");
    scenarios.push("plain create completion");
    const sandboxId = created.value.id;

    const destroy = await prepareOperation(
      connection.session, "destroy", { id: sandboxId }, connection.signal,
    );
    const destroyed = await submitOperation(destroy, identity(), connection.signal);
    requireCondition(destroyed.kind === "completed" && "computeStopped" in destroyed.value &&
      destroyed.value.computeStopped, "destroy must confirm compute termination");
    scenarios.push("plain destroy completion");

    const beforeLost = fixture.counters().create;
    await fixture.loseNextCreateResponse();
    const lost = await prepareOperation(
      connection.session, "create", fixture.createInput, connection.signal,
    );
    const lostIdentity = identity();
    let lostResult: unknown;
    try {
      lostResult = await submitOperation(lost, lostIdentity, connection.signal);
    } catch {
      lostResult = "threw";
    }
    requireCondition(lostResult === "threw" ||
      (typeof lostResult === "object" && lostResult !== null && "kind" in lostResult &&
        lostResult.kind === "unknown"), "lost response cannot become a confirmed completion");
    requireCondition(fixture.counters().create === beforeLost + 1,
      "lost response must apply exactly one native create effect");
    await observeOperation(connection.session, "create", {
      operationId: lostIdentity.operationId,
      submissionId: lostIdentity.submissionId,
    }, connection.signal).catch(() => null);
    requireCondition(fixture.counters().create === beforeLost + 1,
      "observation must never resubmit create");
    scenarios.push("lost response unknown and observation without replay");

    await fixture.holdNextCreateResponse();
    const held = await prepareOperation(
      connection.session, "create", fixture.createInput, connection.signal,
    );
    const controller = new AbortController();
    const beforeHeld = fixture.counters().create;
    const heldResult = submitOperation(held, identity(), controller.signal);
    const deadline = Date.now() + 2_000;
    while (fixture.counters().create === beforeHeld && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1));
    requireCondition(fixture.counters().create === beforeHeld + 1,
      "held callback must apply its effect before abort");
    controller.abort();
    await fixture.releaseHeldCreateResponse();
    await heldResult.catch(() => undefined);
    requireCondition(fixture.counters().create === beforeHeld + 1,
      "late response after abort must not replay");
    scenarios.push("late response after local abort");
  } finally {
    await Promise.all([connection.close(), connection.close()]);
  }
  const after = fixture.counters();
  requireCondition(after.release === before.release + 2,
    "each verified connection must release once, including the alternate");
  scenarios.push("close hooks exactly once");
  return { scenarios, counters: after };
}
