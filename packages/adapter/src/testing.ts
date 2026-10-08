import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
  type AdapterDefinition,
  type CreateInput,
  type Guarantees,
  type RuntimeResult,
  type Scope,
  AdapterError,
} from "./index";
import type { z } from "zod";

type Counters = { create: number; destroy: number; release: number };

export type AdapterSuiteFixture<C extends z.ZodType, K extends z.ZodType> = {
  config: z.input<C>;
  credentials: z.input<K>;
  alternate: { config: z.input<C>; credentials: z.input<K> };
  /** Use another host-installed definition when endpoint is fixed in trusted host configuration. */
  alternateAdapter?: AdapterDefinition<C, K, { scope: Scope }>;
  createInput: CreateInput;
  counters(): Counters;
  /** Owned clients release once; borrowed transports have no close hook. */
  expectedReleasesPerConnection?: 0 | 1;
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

function canonicalScope(scope: Scope): string {
  return JSON.stringify([
    scope.authority.kind,
    scope.authority.id,
    Object.entries(scope.partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
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
  requireCondition(
    cases.has("create") && cases.has("destroy"),
    "managed adapters must test create and destroy",
  );

  for (const hook of [
    "loseNextCreateResponse",
    "holdNextCreateResponse",
    "releaseHeldCreateResponse",
    "assertNativeRetriesDisabled",
  ] as const)
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A conformance fixture may come from JavaScript; verify its required hook is callable.
    requireCondition(typeof fixture[hook] === "function", `fixture must implement ${hook}`);
  const scenarios: string[] = [];
  await fixture.assertNativeRetriesDisabled();
  scenarios.push("native single-attempt evidence");

  const before = fixture.counters();

  const connection = await connectAdapter(adapter, {
    config: fixture.config,
    credentials: fixture.credentials,
  });

  try {
    const alternate = await connectAdapter(fixture.alternateAdapter ?? adapter, {
      config: fixture.alternate.config,
      credentials: fixture.alternate.credentials,
    });

    try {
      requireCondition(
        canonicalScope(connection.scope) !== canonicalScope(alternate.scope),
        "alternate verified authority or endpoint must produce another scope",
      );
      scenarios.push("independent verified scopes");
    } finally {
      await alternate.close();
    }

    const invalidBefore = fixture.counters().create;

    try {
      await prepareOperation(
        connection.session,
        "create",
        {
          ...fixture.createInput,
          networkPolicy: "__sandbar_unsupported__",
        },
        connection.signal,
      );
      throw new Error("Unsupported create reached preparation");
    } catch (error) {
      requireCondition(
        error instanceof AdapterError && error.code === "UNSUPPORTED",
        "unsupported create must reject locally",
      );
    }

    requireCondition(
      fixture.counters().create === invalidBefore,
      "invalid create performed provider IO",
    );
    scenarios.push("unsupported preflight before mutation");

    const prepared = await prepareOperation(
      connection.session,
      "create",
      fixture.createInput,
      connection.signal,
    );

    const created = await submitOperation(prepared, identity(), connection.signal);
    requireCondition(
      created.kind === "completed" && "id" in created.value,
      "normal create must return a plain sandbox completion",
    );
    scenarios.push("plain create completion");
    const sandboxId = created.value.id;

    const destroy = await prepareOperation(
      connection.session,
      "destroy",
      { id: sandboxId },
      connection.signal,
    );

    const destroyed = await submitOperation(destroy, identity(), connection.signal);
    requireCondition(
      destroyed.kind === "completed" &&
        "computeStopped" in destroyed.value &&
        destroyed.value.computeStopped,
      "destroy must confirm compute termination",
    );
    scenarios.push("plain destroy completion");

    const beforeLost = fixture.counters().create;
    await fixture.loseNextCreateResponse();

    const lost = await prepareOperation(
      connection.session,
      "create",
      fixture.createInput,
      connection.signal,
    );

    const lostIdentity = identity();
    let lostResult: RuntimeResult | "threw";

    try {
      lostResult = await submitOperation(lost, lostIdentity, connection.signal);
    } catch {
      lostResult = "threw";
    }

    requireCondition(
      lostResult === "threw" || lostResult.kind === "unknown",
      "lost response cannot become a confirmed completion",
    );
    requireCondition(
      fixture.counters().create === beforeLost + 1,
      "lost response must apply exactly one native create effect",
    );
    await observeOperation(
      connection.session,
      "create",
      {
        operationId: lostIdentity.operationId,
        submissionId: lostIdentity.submissionId,
      },
      connection.signal,
    ).catch(() => null);
    requireCondition(
      fixture.counters().create === beforeLost + 1,
      "observation must never resubmit create",
    );
    scenarios.push("lost response unknown and observation without replay");

    await fixture.holdNextCreateResponse();

    const held = await prepareOperation(
      connection.session,
      "create",
      fixture.createInput,
      connection.signal,
    );

    const controller = new AbortController();
    const beforeHeld = fixture.counters().create;
    const heldResult = submitOperation(held, identity(), controller.signal);
    const deadline = Date.now() + 2_000;

    while (fixture.counters().create === beforeHeld && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1));
    requireCondition(
      fixture.counters().create === beforeHeld + 1,
      "held callback must apply its effect before abort",
    );
    controller.abort();
    await fixture.releaseHeldCreateResponse();
    await heldResult.catch(() => undefined);
    requireCondition(
      fixture.counters().create === beforeHeld + 1,
      "late response after abort must not replay",
    );
    scenarios.push("late response after local abort");
  } finally {
    await Promise.all([connection.close(), connection.close()]);
  }

  const after = fixture.counters();
  requireCondition(
    after.release === before.release + 2 * (fixture.expectedReleasesPerConnection ?? 1),
    "each verified connection must release once, including the alternate",
  );
  scenarios.push("close hooks exactly once");

  return { scenarios, counters: after };
}

/** Qualify an owned filesystem fixture; callers supply cleanup appropriate to their native boundary. */
export async function filesystemSuite(options: {
  session: import("./index").AdapterSession;
  sandbox: import("./index").Sandbox;
  directory: string;
  cleanup: (paths: readonly string[]) => Promise<void>;
}): Promise<{ bytes: number; scenarios: readonly string[] }> {
  const files = options.session.files;
  requireCondition(
    files?.readDirectory &&
      files.stat &&
      files.readStream &&
      files.writeStream &&
      files.copy &&
      files.move,
    "Filesystem hooks are required",
  );
  const base = options.directory.replace(/\/$/, "");
  const source = `${base}/conformance-${crypto.randomUUID()}`;
  const copy = `${source}-copy`;
  const destination = `${source}-moved`;
  const context = { signal: new AbortController().signal, deadline: Date.now() + 30_000 };
  const sandbox = options.sandbox;
  const expected = Uint8Array.of(0, 255, 128, 10);

  async function* chunks() {
    yield expected.subarray(0, 2);
    yield expected.subarray(2);
  }

  try {
    const written = await files.writeStream(
      { sandbox, path: source, bytes: chunks(), overwrite: false },
      context,
    );

    requireCondition(
      written.bytesWritten === expected.length,
      "Stream write must confirm exact bytes",
    );
    const listing = await files.readDirectory({ sandbox, path: options.directory }, context);
    requireCondition(
      listing.entries.some((entry) => entry.name === source.slice(base.length + 1)),
      "Directory must include written file",
    );
    requireCondition(
      listing.completeness === "complete" || listing.completeness === "unknown",
      "Directory completeness must be explicit",
    );
    const stat = await files.stat({ sandbox, path: source, followSymlinks: false }, context);
    requireCondition(stat.type === "file", "File metadata must identify regular file");
    await files.copy({ sandbox, source, destination: copy, overwrite: false }, context);
    let refused = false;

    try {
      await files.copy({ sandbox, source, destination: copy, overwrite: false }, context);
    } catch (error) {
      refused = error instanceof AdapterError && error.code === "CONFLICT";
    }

    requireCondition(refused, "Copy must refuse existing destination");
    await files.move({ sandbox, source: copy, destination, overwrite: false }, context);
    const reader = (await files.readStream({ sandbox, path: destination }, context)).getReader();
    let offset = 0;

    try {
      for (;;) {
        const part = await reader.read();

        if (part.done) break;

        for (const byte of part.value) {
          requireCondition(byte === expected[offset], "Stream bytes must match");
          offset++;
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }

    requireCondition(offset === expected.length, "Stream must deliver complete bytes");

    return {
      bytes: offset,
      scenarios: ["stream binary bytes", "directory metadata", "no-clobber copy", "native move"],
    };
  } finally {
    await options.cleanup([source, copy, destination]);
  }
}
