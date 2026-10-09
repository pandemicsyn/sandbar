import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { z } from "zod";
import {
  AdapterError,
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type NativeProcess,
  type Sandbox,
  type ProcessStartContext,
} from "sandbar-adapter";
import { Sandbar, Image, diagnosticContext, type StartProcessInput } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

async function fixture(
  options: {
    early?: string;
    late?: boolean;
    unsupported?: boolean;
    noncooperative?: boolean;
    verified?: boolean;
    interactive?: boolean;
    capture?: boolean;
  } = {},
) {
  const exit = deferred<{ exitCode: number }>();
  const outputEnd = deferred<void>();
  const capture = deferred<import("sandbar-adapter").ExecValue>();
  const writes: Uint8Array[] = [];
  let writeGate: Promise<void> | undefined;
  let closeGate: Promise<void> | undefined;
  let outputDetaches = 0;
  let closes = 0;
  const start = deferred<NativeProcess>();
  let ctx!: ProcessStartContext;
  let starts = 0;
  let detaches = 0;
  let confirmedExit: { exitCode: number } | undefined;
  let creates = 0;

  const scope = { authority: { kind: "fixture", id: "one" }, partition: {} };

  const reference = (id: string) =>
    sandboxReference("stream.fixture", scope, id, { operation: id, submission: id });

  const native: NativeProcess = {
    get confirmedExit() {
      return confirmedExit;
    },
    wait: () => exit.promise,
    detach: async () => {
      detaches++;

      if (options.noncooperative) await new Promise(() => {});
    },
  };

  if (options.interactive)
    Object.assign(native, {
      outputDone: outputEnd.promise,
      capture: options.capture ? capture.promise : undefined,
      detachOutput: async () => {
        outputDetaches++;
      },
      write: async (bytes: Uint8Array) => {
        writes.push(bytes);
        await writeGate;
      },
      closeStdin: async () => {
        closes++;
        await closeGate;
      },
      status: async () => ({ state: "running" as const, observedAt: new Date().toISOString() }),
      terminate: async () => ({ status: "requested" as const }),
    });

  const adapter = defineAdapter({
    name: "stream.fixture",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => {
          const id = ++creates === 1 ? "one" : "two";

          const sandbox: Sandbox = { id, state: "running" };

          if (options.verified) sandbox.reference = reference(id);

          return sandbox;
        },
        reopen: async (ref) => ({
          ...unknownSandboxFacts(),
          reference: ref,
          nativeState: "running",
          state: "running",
          observedAt: new Date().toISOString(),
        }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        processes: options.unsupported
          ? undefined
          : {
              supports: options.interactive
                ? {
                    sustainedOutput: true as const,
                    stdin: "bytes" as const,
                    status: true as const,
                    execCapture: options.capture ? ("bytes" as const) : undefined,
                  }
                : undefined,
              async start(_input, context) {
                starts++;
                ctx = context;

                if (options.early) context.onOutput({ stream: "stdout", text: options.early });

                return options.late ? start.promise : native;
              },
            },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const box = await client.sandboxes.create({ environment: Image.prepared("one") });

  return {
    client,
    box,
    exit,
    outputEnd,
    capture,
    writes,
    setWriteGate(gate?: Promise<void>) {
      writeGate = gate;
    },
    setCloseGate(gate?: Promise<void>) {
      closeGate = gate;
    },
    get outputDetaches() {
      return outputDetaches;
    },
    get closes() {
      return closes;
    },
    start,
    native,
    get ctx() {
      return ctx;
    },
    get starts() {
      return starts;
    },
    get detaches() {
      return detaches;
    },
    confirm(code: number) {
      confirmedExit = { exitCode: code };
    },
  };
}

const input = { command: { kind: "argv" as const, argv: ["job"] } };

test("runtime-cast process start input rejects finite stdin before native process start", async () => {
  const f = await fixture();

  // SAFETY: Deliberately bypass the public type to verify runtime rejection before native start.
  await expect(
    f.box.processes.start({ ...input, stdin: Uint8Array.of(1) } as never),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(f.starts).toBe(0);
  await f.client.close();
});

test("early text, separate streams, live delivery, ordinary nonzero and historical completeness", async () => {
  const f = await fixture({ early: "early" });
  const p = await f.box.processes.start(input);
  const out = p.output()[Symbol.asyncIterator]();
  expect(await out.next()).toMatchObject({ value: { stream: "stdout", text: "early" } });
  f.ctx.onOutput({ stream: "stderr", text: "error" });
  expect(await out.next()).toMatchObject({ value: { stream: "stderr", text: "error" } });
  expect(() => p.output()).toThrow();
  f.exit.resolve({ exitCode: 7 });
  const before = await p.wait();
  expect(before).toEqual({ exitCode: 7, outputComplete: false });
  expect(await out.next()).toMatchObject({ done: true });
  expect(await p.wait()).toEqual({ exitCode: 7, outputComplete: true });
  expect(before.outputComplete).toBe(false);
  await p.detach();
  expect(await p.wait()).toEqual({ exitCode: 7, outputComplete: true });
  expect(f.starts).toBe(1);
  await f.client.close();
});

test("wait abort affects only one waiter; start signal no longer controls established observation", async () => {
  const f = await fixture();
  const setup = new AbortController();
  const p = await f.box.processes.start(input, { signal: setup.signal });
  setup.abort();
  const cancel = new AbortController();
  const a = p.wait({ signal: cancel.signal });
  const b = p.wait();
  cancel.abort();
  await expect(a).rejects.toMatchObject({ code: "WAIT_ABORTED" });
  expect(f.detaches).toBe(0);
  f.exit.resolve({ exitCode: 0 });
  expect(await b).toMatchObject({ exitCode: 0 });
  await f.client.close();
});

test.each(["detach", "close", "break", "abort"])(
  "prompt local %s with noncooperative cleanup and no exit",
  async (mode) => {
    const f = await fixture({ noncooperative: true });
    const p = await f.box.processes.start(input);
    const cancel = new AbortController();
    const out = p.output({ signal: cancel.signal })[Symbol.asyncIterator]();
    const reading = out.next().catch((error) => ({ error }));
    const waiting = p.wait().catch((error) => error);

    if (mode === "abort") cancel.abort();

    if (mode === "close") await f.client.close();

    if (mode === "break") await out.return!();

    if (mode === "detach") await p.detach();

    if (mode === "abort") expect(await reading).toMatchObject({ error: { code: "WAIT_ABORTED" } });
    else expect(await reading).toMatchObject({ done: true });
    expect(await waiting).toMatchObject({
      code: mode === "abort" ? "WAIT_ABORTED" : "UNAVAILABLE",
    });
    await p.detach();
    expect(f.detaches).toBe(1);
    await f.client.close();
  },
);

test.each(["bytes", "chunks", "oversized", "cumulative"])(
  "bounded %s admission delivers prefix then failure",
  async (mode) => {
    const f = await fixture();

    const p = await f.box.processes.start({
      ...input,
      maxOutputBytes: mode === "cumulative" ? 3 : 1_048_576,
    });

    const out = p.output()[Symbol.asyncIterator]();
    f.ctx.onOutput({ stream: "stdout", text: "a" });

    if (mode === "cumulative") {
      expect((await out.next()).value?.text).toBe("a");
      f.ctx.onOutput({ stream: "stdout", text: "bb" });
      await out.next();
    }

    if (mode === "bytes") f.ctx.onOutput({ stream: "stdout", text: "b".repeat(65_535) });

    if (mode === "chunks")
      for (let i = 1; i < 256; i++) f.ctx.onOutput({ stream: "stderr", text: "b" });
    expect(() =>
      f.ctx.onOutput({
        stream: "stdout",
        text: mode === "oversized" ? "x".repeat(1_048_577) : "c",
      }),
    ).toThrow();
    const admitted: string[] = [];
    await expect(
      (async () => {
        while (true) {
          const next = await out.next();

          if (next.done) return;
          admitted.push(next.value.text);
        }
      })(),
    ).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });

    if (mode !== "cumulative") expect(admitted.join("")).toStartWith("a");
    await expect(p.wait()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
    expect(f.detaches).toBe(1);
    await f.client.close();
  },
);

test("code-point chunk boundaries and confirmed exit survive callback/transport failure", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  f.ctx.onOutput({ stream: "stdout", text: "😀".repeat(5000) });
  const out = p.output()[Symbol.asyncIterator]();
  const a = (await out.next()).value!;
  const b = (await out.next()).value!;
  expect(new TextEncoder().encode(a.text).length).toBe(16_384);
  expect(a.text + b.text).toBe("😀".repeat(5000));
  f.confirm(4);
  const waiting = p.wait();
  expect(() => f.ctx.onOutput({ stream: "stdout", text: "x".repeat(65_537) })).toThrow();
  f.exit.reject(
    Object.assign(new AdapterError("UNAVAILABLE", "decoder failed"), {
      confirmedExit: { exitCode: 4 },
    }),
  );
  expect(await waiting).toEqual({ exitCode: 4, outputComplete: false });
  await expect(out.next()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  const failure = await out.next().catch((error) => error);
  expect(diagnosticContext(failure)).toMatchObject({
    operationState: "completed",
    effect: "applied",
    recoveryAvailable: false,
  });
  expect(JSON.stringify(diagnosticContext(failure))).not.toContain("😀");
  expect(await p.wait()).toEqual({ exitCode: 4, outputComplete: false });
  await f.client.close();
});

test("early overflow rejects start and disposes late native handle once", async () => {
  const f = await fixture({ late: true });
  const starting = f.box.processes.start({ ...input, maxOutputBytes: 1 });
  await Promise.resolve();
  await Promise.resolve();
  expect(() => f.ctx.onOutput({ stream: "stdout", text: "xx" })).toThrow();
  f.start.resolve(f.native);
  await expect(starting).rejects.toMatchObject({ code: "OUTPUT_CAPACITY", effect: "possible" });
  expect(f.detaches).toBe(1);
  expect(f.starts).toBe(1);
  await f.client.close();
});

test("abandoned setup disposes late handle; lost ack never replays", async () => {
  const f = await fixture({ late: true });
  const cancel = new AbortController();
  const starting = f.box.processes.start(input, { signal: cancel.signal });
  await Promise.resolve();
  await Promise.resolve();
  cancel.abort();
  await expect(starting).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  f.start.resolve(f.native);
  await Bun.sleep(0);
  expect(f.detaches).toBe(1);
  expect(f.starts).toBe(1);
  await f.client.close();
  const lost = await fixture({ late: true });
  const unknown = lost.box.processes.start(input);
  await Promise.resolve();
  await Promise.resolve();
  lost.start.reject(new Error("secret response"));
  await expect(unknown).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(lost.starts).toBe(1);
  await lost.client.close();
});

test.each(["deadline", "cwd", "env", "nul", "zero", "preabort", "unsupported"])(
  "invalid/unsupported %s dispatches zero starts",
  async (mode) => {
    const f = await fixture({ unsupported: mode === "unsupported" });
    const value: StartProcessInput = { ...input };

    if (mode === "deadline") value.deadlineSeconds = 1;

    if (mode === "cwd") value.cwd = "relative";

    if (mode === "env") value.env = { bad: "\0" };

    if (mode === "zero") value.maxOutputBytes = 0;

    if (mode === "nul") value.command = { kind: "shell", script: "\0" };
    await expect(
      f.box.processes.start(value, mode === "preabort" ? { signal: AbortSignal.abort() } : {}),
    ).rejects.toBeInstanceOf(Error);
    expect(f.starts).toBe(0);
    await f.client.close();
  },
);

test.each(["detach", "close", "return", "abort"])(
  "failure prefix discarded by subsequent %s",
  async (mode) => {
    const f = await fixture();
    const p = await f.box.processes.start({ ...input, maxOutputBytes: 1 });
    const signal = new AbortController();
    const out = p.output({ signal: signal.signal })[Symbol.asyncIterator]();
    f.ctx.onOutput({ stream: "stdout", text: "a" });
    expect(() => f.ctx.onOutput({ stream: "stderr", text: "b" })).toThrow();

    if (mode === "detach") await p.detach();

    if (mode === "close") await f.client.close();

    if (mode === "return") await out.return!();

    if (mode === "abort") signal.abort();
    await expect(out.next()).rejects.toMatchObject({
      code: mode === "abort" ? "WAIT_ABORTED" : "OUTPUT_CAPACITY",
    });
    expect(f.detaches).toBe(1);
    await f.client.close();
  },
);

test("abort between start call and dispatch is a proven no-effect cancellation", async () => {
  const f = await fixture();
  const cancel = new AbortController();
  const pending = f.box.processes.start(input, { signal: cancel.signal });
  cancel.abort();
  await expect(pending).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "none",
    provider: "stream.fixture",
    sandboxId: "one",
  });
  expect(f.starts).toBe(0);
  await f.client.close();
});

test("setup deadline is 30 seconds and late handle cleanup is prompt", async () => {
  const f = await fixture({ late: true, noncooperative: true });
  const original = globalThis.setTimeout;
  let expire!: () => void;
  // SAFETY: Only intercept the declared setup timer; preserve its real timer handle for clearTimeout.
  globalThis.setTimeout = Object.assign(
    (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 30_000) {
        expect(handler).toBeInstanceOf(Function);
        expire = () => {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- TimerHandler is the platform's string/function union; invoke only its function branch.
          if (typeof handler === "function") handler();
        };

        return original(() => {}, 60_000);
      }

      return original(handler, ms, ...args);
    },
    original,
  );

  try {
    const pending = f.box.processes.start(input);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.ctx.deadline - Date.now()).toBeGreaterThan(29_000);
    expire();
    await expect(pending).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      provider: "stream.fixture",
      sandboxId: "one",
    });
    expect(f.ctx.signal.aborted).toBe(true);
    f.start.resolve(f.native);
    await Bun.sleep(0);
    expect(f.detaches).toBe(1);
    expect(f.starts).toBe(1);
  } finally {
    globalThis.setTimeout = original;
    await f.client.close();
  }
});

test("terminal output error releases caller abort listeners", async () => {
  const f = await fixture();
  const p = await f.box.processes.start(input);
  const cancel = new AbortController();
  const out = p.output({ signal: cancel.signal })[Symbol.asyncIterator]();
  expect(getEventListeners(cancel.signal, "abort")).toHaveLength(1);
  f.exit.reject(new AdapterError("UNAVAILABLE", "private transport error"));
  await expect(out.next()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(getEventListeners(cancel.signal, "abort")).toHaveLength(0);
  await f.client.close();
});

test("late confirmed evidence enriches latched output failure without changing its code", async () => {
  const f = await fixture();
  const p = await f.box.processes.start({ ...input, maxOutputBytes: 1 });
  const out = p.output()[Symbol.asyncIterator]();
  f.ctx.onOutput({ stream: "stdout", text: "a" });
  expect(() => f.ctx.onOutput({ stream: "stderr", text: "b" })).toThrow();
  f.exit.reject(
    Object.assign(new AdapterError("UNAVAILABLE", "native late flush failure"), {
      confirmedExit: { exitCode: 9 },
    }),
  );
  await Bun.sleep(0);
  expect((await out.next()).value?.text).toBe("a");
  const error = await out.next().catch((error) => error);
  expect(error).toMatchObject({
    code: "OUTPUT_CAPACITY",
    confirmedExit: { exitCode: 9, outputComplete: false },
  });
  expect(diagnosticContext(error)).toMatchObject({
    operationState: "completed",
    effect: "applied",
    recoveryAvailable: false,
  });
  expect(await p.wait()).toEqual({ exitCode: 9, outputComplete: false });
  await f.client.close();
});

test("termination shares one request and caller abort leaves other waiters and output active", async () => {
  const f = await fixture();
  const result = deferred<{ status: "requested" }>();
  let calls = 0;
  f.native.terminate = async (ctx) => {
    calls++;
    expect(ctx.deadline - Date.now()).toBeGreaterThan(29_000);
    expect(ctx.signal.aborted).toBe(false);

    return result.promise;
  };

  const p = await f.box.processes.start(input);
  await expect(p.terminate({ signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
    effect: "none",
  });
  expect(calls).toBe(0);
  const cancel = new AbortController();
  const a = p.terminate({ signal: cancel.signal });
  const b = p.terminate();
  cancel.abort();
  await expect(a).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  expect(f.detaches).toBe(0);
  const out = p.output()[Symbol.asyncIterator]();
  f.ctx.onOutput({ stream: "stdout", text: "still observed" });
  expect((await out.next()).value?.text).toBe("still observed");
  result.resolve({ status: "requested" });
  const acknowledged = await b;

  expect(acknowledged).toEqual({ status: "requested" });
  acknowledged.status = "not-found"; // Caller mutation must not corrupt cached native evidence.
  expect(await p.terminate()).toEqual({ status: "requested" });
  await p.detach();
  expect(await p.terminate()).toEqual({ status: "requested" });
  f.confirm(-1);
  expect(await p.terminate()).toEqual({ status: "exited" });
  expect(await p.wait()).toEqual({ exitCode: -1, outputComplete: false });
  expect(calls).toBe(1);
  await f.client.close();
});

test.each(["detach", "close", "lost", "overflow", "unsupported", "exit"])(
  "termination %s rejects or returns exit without dispatch",
  async (mode) => {
    const f = await fixture();
    let calls = 0;

    if (mode !== "unsupported")
      f.native.terminate = async () => {
        calls++;

        return { status: "requested" };
      };

    const p = await f.box.processes.start({ ...input, maxOutputBytes: 1 });

    if (mode === "detach") await p.detach();

    if (mode === "close") await f.client.close();

    if (mode === "lost") {
      f.exit.reject(new Error("lost"));
      await Bun.sleep(0);
    }

    if (mode === "overflow")
      expect(() => f.ctx.onOutput({ stream: "stdout", text: "too much" })).toThrow();

    if (mode === "exit") {
      f.confirm(7);
      await p.detach();
    }

    if (mode === "exit") expect(await p.terminate()).toEqual({ status: "exited" });
    else {
      let code = "UNAVAILABLE";

      if (mode === "close") code = "CLIENT_CLOSED";

      if (mode === "unsupported") code = "UNSUPPORTED";
      await expect(p.terminate()).rejects.toMatchObject({ code, effect: "none" });
    }

    expect(calls).toBe(0);
    await f.client.close();
  },
);

test("termination caches absence without manufacturing exit", async () => {
  const f = await fixture();
  let calls = 0;
  f.native.terminate = async () => {
    calls++;

    return { status: "not-found" };
  };

  const p = await f.box.processes.start(input);
  expect(await p.terminate()).toEqual({ status: "not-found" });
  expect(await p.terminate()).toEqual({ status: "not-found" });
  await expect(p.wait({ signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
  });
  expect(calls).toBe(1);
  await f.client.close();
});

test.each(["lost", "malformed", "close"])(
  "termination caches %s uncertainty without redispatch or erasing exit",
  async (mode) => {
    const f = await fixture();
    const result = deferred<{ status: "requested" }>();
    let calls = 0;
    f.native.terminate = async () => {
      calls++;

      if (mode === "lost") throw new AdapterError("UNAVAILABLE", "private remote error");

      if (mode === "malformed") return JSON.parse('{"status":"killed"}');

      return result.promise;
    };

    const p = await f.box.processes.start(input);
    const request = p.terminate();

    if (mode === "close") await f.client.close();
    await expect(request).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
    await expect(p.terminate()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    f.confirm(-1);
    expect(await p.terminate()).toEqual({ status: "exited" });
    expect(await p.wait()).toMatchObject({ exitCode: -1 });
    expect(calls).toBe(1);
    await f.client.close();
  },
);

test("shared termination deadline releases noncooperative IO and never retries", async () => {
  const f = await fixture();
  let calls = 0;
  let requestSignal!: AbortSignal;
  f.native.terminate = async (ctx) => {
    calls++;
    requestSignal = ctx.signal;

    return new Promise(() => {});
  };

  const p = await f.box.processes.start(input);
  const original = globalThis.setTimeout;
  let expire!: () => void;
  globalThis.setTimeout = Object.assign(
    (handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 30_000) {
        expire = () => {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Invoke only the function member of platform TimerHandler.
          if (typeof handler === "function") handler();
        };

        return original(() => {}, 60_000);
      }

      return original(handler, ms, ...args);
    },
    original,
  );

  try {
    const request = p.terminate();
    expire();
    await expect(request).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(requestSignal.aborted).toBe(true);
    await expect(p.terminate()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
    expect(f.detaches).toBe(0);
  } finally {
    globalThis.setTimeout = original;
    await f.client.close();
  }
});

test("confirmed exit with never-closing stream bounds drain by local observation abort", async () => {
  const f = await fixture();
  let calls = 0;
  f.native.terminate = async () => {
    calls++;

    return { status: "requested" };
  };

  const p = await f.box.processes.start(input);
  const observation = new AbortController();

  const drain = (async () => {
    for await (const chunk of p.output({ signal: observation.signal }))
      expect(chunk.text).toBe("early");
  })().catch((error) => error);

  f.confirm(0); // Native wait remains pending forever; output does not close.
  expect(await p.wait({ signal: observation.signal })).toMatchObject({ exitCode: 0 });
  expect(await p.terminate()).toEqual({ status: "exited" });
  observation.abort();
  expect(await drain).toMatchObject({ code: "WAIT_ABORTED" });
  await p.detach();
  expect(f.detaches).toBe(1);
  expect(calls).toBe(0);
  expect(await p.wait()).toEqual({ exitCode: 0, outputComplete: false });
  await f.client.close();
});

test("confirmed exit during termination is independent of pending request acknowledgement", async () => {
  const f = await fixture();
  const result = deferred<{ status: "requested" }>();
  let calls = 0;
  f.native.terminate = async () => {
    calls++;

    return result.promise;
  };

  const p = await f.box.processes.start(input);
  const request = p.terminate();
  f.confirm(-1);
  expect(await p.terminate()).toEqual({ status: "exited" });
  expect(await p.wait()).toMatchObject({ exitCode: -1 });
  result.resolve({ status: "requested" });
  expect(await request).toEqual({ status: "requested" });
  expect(calls).toBe(1);
  await f.client.close();
});

test.each(['{"signal":9}', '{"exitCode":null}'])(
  "adapter-only terminal evidence %s cannot fabricate an exit",
  async (value) => {
    const f = await fixture();
    const p = await f.box.processes.start(input);
    f.exit.resolve(JSON.parse(value));
    await expect(p.wait()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(p.terminate()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await f.client.close();
  },
);

test("same sandbox lifecycle submission fences old handles without detaching or signalling them", async () => {
  const f = await fixture();
  let calls = 0;
  f.native.terminate = async () => {
    calls++;

    return { status: "requested" };
  };

  const p = await f.box.processes.start(input);
  const older = await f.box.processes.start(input);

  await expect(f.box.destroy({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
  expect(await p.terminate()).toEqual({ status: "requested" });
  // A pre-aborted lifecycle call does not consume this handle's authority.
  expect(f.detaches).toBe(0);
  await f.box.destroy();
  await expect(older.terminate()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
  expect(await p.terminate()).toEqual({ status: "requested" });
  expect(f.detaches).toBe(0);
  expect(calls).toBe(1);
  f.confirm(0);
  expect(await p.terminate()).toEqual({ status: "exited" });
  await f.client.close();
});

test("same-client verified aliases share lifecycle fences without invalidating other sandboxes", async () => {
  const f = await fixture({ verified: true });
  let calls = 0;
  f.native.terminate = async () => {
    calls++;

    return { status: "requested" };
  };

  const alias = await f.client.sandboxes.get(f.box.reference!);
  const other = await f.client.sandboxes.create({ environment: Image.prepared("two") });
  const old = await f.box.processes.start(input);
  const oldContext = f.ctx;
  const cached = await f.box.processes.start(input);
  const unrelated = await other.processes.start(input);
  const output = old.output()[Symbol.asyncIterator]();
  expect(await cached.terminate()).toEqual({ status: "requested" });
  await alias.destroy();
  await expect(old.terminate()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
  expect(await cached.terminate()).toEqual({ status: "requested" });
  expect(await unrelated.terminate()).toEqual({ status: "requested" });
  oldContext.onOutput({ stream: "stdout", text: "still observing" });
  expect(await output.next()).toMatchObject({ value: { text: "still observing" } });
  // Lifecycle bookkeeping does not detach native observation.
  expect(f.detaches).toBe(0);
  const fresh = await f.box.processes.start(input);
  expect(await fresh.terminate()).toEqual({ status: "requested" });
  f.confirm(-1);
  expect(await old.terminate()).toEqual({ status: "exited" });
  expect(await old.wait()).toMatchObject({ exitCode: -1 });
  await output.return?.();
  expect(calls).toBe(3);
  await f.client.close();
});

test.each(["submitSuspend", "submitResume"] as const)(
  "%s fences same-client aliases before rejected submission and preserves observations/results",
  async (action) => {
    const f = await fixture({ verified: true });
    let calls = 0;
    f.native.terminate = async () => {
      calls++;

      return { status: "requested" };
    };

    try {
      const alias = await f.client.sandboxes.get(f.box.reference!);
      const other = await f.client.sandboxes.create({ environment: Image.prepared("two") });
      const old = await f.box.processes.start(input);
      const oldContext = f.ctx;
      const cached = await f.box.processes.start(input);
      const unrelated = await other.processes.start(input);
      const output = old.output()[Symbol.asyncIterator]();

      await expect(alias[action]({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
      expect(await cached.terminate()).toEqual({ status: "requested" });
      // This fixture has no lifecycle hook; submission still withdraws old local authority.
      await expect(alias[action]()).rejects.toMatchObject({ code: "UNSUPPORTED", effect: "none" });
      await expect(old.terminate()).rejects.toMatchObject({ code: "UNAVAILABLE", effect: "none" });
      expect(await cached.terminate()).toEqual({ status: "requested" });
      expect(await unrelated.terminate()).toEqual({ status: "requested" });
      oldContext.onOutput({ stream: "stdout", text: "still observing" });
      expect(await output.next()).toMatchObject({ value: { text: "still observing" } });
      expect(f.detaches).toBe(0);
      const fresh = await f.box.processes.start(input);
      expect(await fresh.terminate()).toEqual({ status: "requested" });
      f.confirm(-1);
      expect(await old.terminate()).toEqual({ status: "exited" });
      expect(await old.wait()).toMatchObject({ exitCode: -1 });
      await output.return?.();
      expect(calls).toBe(3);
    } finally {
      await f.client.close();
    }
  },
);

test("sustained output exceeds 32 MiB with bounded queue, independent final output and status", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, output: { mode: "stream" } });
  const out = p.output()[Symbol.asyncIterator]();
  let bytes = 0;

  for (let i = 0; i < 2049; i++) {
    f.ctx.onOutput({ stream: i % 2 ? "stderr" : "stdout", text: "x".repeat(16_384) });
    bytes += (await out.next()).value!.text.length;
  }

  expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
  expect(await p.status()).toMatchObject({ state: "running" });
  f.exit.resolve({ exitCode: 3 });
  expect(await p.wait()).toMatchObject({ exitCode: 3, outputComplete: false });
  f.ctx.onOutput({ stream: "stderr", text: "final" });
  expect((await out.next()).value!.text).toBe("final");
  f.outputEnd.resolve();
  expect((await out.next()).done).toBe(true);
  expect(await p.status()).toMatchObject({
    state: "exited",
    exit: { exitCode: 3, outputComplete: true },
  });
  await p.detach();
  await f.client.close();
});

test("sustained overflow preserves wait, stdin, status and termination", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe", output: { mode: "stream" } });
  const out = p.output()[Symbol.asyncIterator]();
  expect(() => f.ctx.onOutput({ stream: "stdout", text: "x".repeat(65_537) })).toThrow();
  await expect(out.next()).rejects.toMatchObject({ code: "OUTPUT_CAPACITY" });
  expect(f.outputDetaches).toBe(1);
  expect(f.detaches).toBe(0);
  const waiting = p.wait();
  await p.write(Uint8Array.of(0, 255));
  expect(await p.status()).toMatchObject({ state: "running" });
  expect(await p.terminate()).toEqual({ status: "requested" });
  f.exit.resolve({ exitCode: 9 });
  expect(await waiting).toEqual({ exitCode: 9, outputComplete: false });
  await p.detach();
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("input is bounded, snapshotted and ordered; EOF waits for admitted writes", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe" });
  const gate = deferred<void>();
  f.setWriteGate(gate.promise);
  const first = p.write("hello");
  const bytes = Uint8Array.of(0, 255, 128);
  const second = p.write(bytes);
  bytes.fill(42);
  const eof = p.closeStdin();
  await expect(p.write("late")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await Bun.sleep(0);
  expect(f.writes).toHaveLength(1);
  expect(f.closes).toBe(0);
  gate.resolve();
  await Promise.all([first, second, eof]);
  expect([...f.writes[1]!]).toEqual([0, 255, 128]);
  expect(f.closes).toBe(1);
  await p.closeStdin();
  expect(f.closes).toBe(1);
  await p.detach();
  await f.client.close();
});

test("input rejects capacity locally and queued abort is effect-free", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe" });
  await expect(p.write(new Uint8Array(65_537))).rejects.toMatchObject({ code: "INPUT_CAPACITY" });
  const gate = deferred<void>();
  f.setWriteGate(gate.promise);
  const writes = Array.from({ length: 4 }, () => p.write(new Uint8Array(65_536)));
  await expect(p.write("x")).rejects.toMatchObject({ code: "INPUT_CAPACITY" });
  gate.resolve();
  await Promise.all(writes);
  const gate2 = deferred<void>();
  f.setWriteGate(gate2.promise);
  const first = p.write("one");
  const cancel = new AbortController();
  const queued = p.write("two", { signal: cancel.signal });
  cancel.abort();
  await expect(queued).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
  gate2.resolve();
  await first;
  await p.closeStdin();
  expect(f.writes.map((b) => new TextDecoder().decode(b))).not.toContain("two");
  await p.detach();
  await f.client.close();
});

test("in-flight input abort poisons only input and never retries", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe", output: { mode: "stream" } });
  f.setWriteGate(new Promise(() => {}));
  const cancel = new AbortController();
  const pending = p.write("request", { signal: cancel.signal });
  await Bun.sleep(0);
  cancel.abort();
  await expect(pending).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  await expect(p.write("retry")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  await expect(p.closeStdin()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(f.writes).toHaveLength(1);
  expect(await p.status()).toMatchObject({ state: "running" });
  await p.detach();
  await f.client.close();
});

test("new modes fail before start on legacy adapters and incompatible output options", async () => {
  const f = await fixture();
  await expect(f.box.processes.start({ ...input, stdin: "pipe" })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  await expect(
    f.box.processes.start({ ...input, output: { mode: "stream" } }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(
    f.box.processes.start({ ...input, output: { mode: "stream" }, maxOutputBytes: 1 }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(f.starts).toBe(0);
  const p = await f.box.processes.start(input);
  expect(await p.status()).toMatchObject({ state: "unknown" });
  await p.detach();
  await f.client.close();
});

test("callback exec dispatches once, awaits callbacks and returns original bounded bytes", async () => {
  const f = await fixture({ interactive: true, capture: true, early: "initial" });
  const chunks: string[] = [];
  const callbackGate = deferred<void>();

  const running = f.box.exec(input, {
    onOutput: async (chunk) => {
      chunks.push(chunk.text);
      await callbackGate.promise;
    },
  });

  await Bun.sleep(0);
  expect(chunks).toEqual(["initial"]);
  f.ctx.onOutput({ stream: "stderr", text: "replacement �" });
  f.capture.resolve({
    exitCode: 0,
    stdout: Uint8Array.of(0, 255),
    stderr: Uint8Array.of(128),
    truncated: true,
  });
  f.exit.resolve({ exitCode: 0 });
  f.outputEnd.resolve();
  callbackGate.resolve();
  const result = await running;
  expect([...result.stdout]).toEqual([0, 255]);
  expect([...result.stderr]).toEqual([128]);
  expect(result.truncated).toBe(true);
  expect(chunks).toEqual(["initial", "replacement �"]);
  expect(f.starts).toBe(1);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback exec splits finite input and closes EOF without starting finite exec", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const bytes = new Uint8Array(131_073).fill(255);
  const running = f.box.exec({ ...input, stdin: bytes }, { onOutput() {} });
  await Bun.sleep(0);
  expect(f.writes.map((b) => b.byteLength)).toEqual([65_536, 65_536, 1]);
  expect(f.closes).toBe(1);
  f.capture.resolve({
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
  });
  f.exit.resolve({ exitCode: 0 });
  f.outputEnd.resolve();
  expect((await running).exitCode).toBe(0);
  expect(f.starts).toBe(1);
  await f.client.close();
});

test("callback failures preserve independently confirmed exit/capture and never replay", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const gate = deferred<void>();

  const running = f.box.exec(input, {
    onOutput: async () => {
      await gate.promise;
      throw new Error("private output contents");
    },
  });

  await Bun.sleep(0);
  f.ctx.onOutput({ stream: "stdout", text: "one" });
  f.exit.resolve({ exitCode: 7 });
  f.capture.resolve({
    exitCode: 7,
    stdout: Uint8Array.of(1),
    stderr: new Uint8Array(),
    truncated: false,
  });
  await Bun.sleep(0);
  gate.resolve();
  await expect(running).rejects.toMatchObject({
    code: "UNAVAILABLE",
    confirmedExit: { exitCode: 7 },
    output: { exitCode: 7, stdout: Uint8Array.of(1) },
  });
  expect(f.starts).toBe(1);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback exec preserves ordinary nonzero results and unsupported validation has no effects", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const running = f.box.exec(input, { onOutput() {} });
  await Bun.sleep(0);
  f.capture.resolve({
    exitCode: 4,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    truncated: false,
  });
  f.exit.resolve({ exitCode: 4 });
  f.outputEnd.resolve();
  await expect(running).rejects.toMatchObject({ code: "NONZERO_EXIT", result: { exitCode: 4 } });
  await expect(
    f.box.exec({ ...input, deadlineSeconds: 3 }, { onOutput() {} }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.starts).toBe(1);
  await f.client.close();
  const legacy = await fixture();
  await expect(legacy.box.exec(input, { onOutput() {} })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(legacy.starts).toBe(0);
  await legacy.client.close();
});

test.each(["closed", "pipe"] as const)(
  "finite %s output honors separate native output completion after exit",
  async (stdin) => {
    const f = await fixture({ interactive: true });
    const p = await f.box.processes.start({ ...input, stdin });
    const out = p.output()[Symbol.asyncIterator]();
    f.exit.resolve({ exitCode: 0 });
    expect(await p.wait()).toEqual({ exitCode: 0, outputComplete: false });
    const next = out.next();
    await Bun.sleep(0);
    f.ctx.onOutput({ stream: "stderr", text: "final after exit" });
    expect(await next).toMatchObject({ value: { text: "final after exit" } });
    expect(await p.wait()).toMatchObject({ outputComplete: false });
    f.outputEnd.resolve();
    expect(await out.next()).toMatchObject({ done: true });
    expect(await p.wait()).toMatchObject({ outputComplete: true });
    await p.detach();
    await f.client.close();
  },
);

test("client close releases stalled callback after independently confirmed capture and exit", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const entered = deferred<void>();

  const running = f.box.exec(input, {
    onOutput: async () => {
      entered.resolve();
      await new Promise(() => {});
    },
  });

  await Bun.sleep(0);
  f.ctx.onOutput({ stream: "stdout", text: "one" });
  await entered.promise;
  f.exit.resolve({ exitCode: 0 });
  f.capture.resolve({
    exitCode: 0,
    stdout: Uint8Array.of(1),
    stderr: new Uint8Array(),
    truncated: false,
  });
  f.outputEnd.resolve();
  await Bun.sleep(0);
  const result = running.catch((error) => error);
  await f.client.close();
  expect(await result).toMatchObject({
    code: "UNAVAILABLE",
    confirmedExit: { exitCode: 0 },
    output: { exitCode: 0 },
  });
  expect(f.detaches).toBe(1);
});

test("concurrent EOF caller abort cancels only its wait and does not replay shared close", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe" });
  const gate = deferred<void>();
  f.setCloseGate(gate.promise);
  const first = p.closeStdin();
  await Bun.sleep(0);
  const cancel = new AbortController();
  const second = p.closeStdin({ signal: cancel.signal });
  cancel.abort();
  await expect(second).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  expect(f.closes).toBe(1);
  gate.resolve();
  await first;
  await p.closeStdin();
  expect(f.closes).toBe(1);
  await expect(p.write("late")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await p.detach();
  await f.client.close();
});

test("detach cancels in-flight local input, queued input and native controls promptly without redispatch", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe", output: { mode: "stream" } });
  f.setWriteGate(new Promise(() => {}));
  const first = p.write("first").catch((error) => error);
  const second = p.write("second").catch((error) => error);
  const eof = p.closeStdin().catch((error) => error);
  let statusSignal: AbortSignal | undefined;
  let terminationSignal: AbortSignal | undefined;
  f.native.status = async (context) => {
    statusSignal = context.signal;

    return new Promise(() => {});
  };

  f.native.terminate = async (context) => {
    terminationSignal = context.signal;

    return new Promise(() => {});
  };

  const status = p.status().catch((error) => error);
  const termination = p.terminate().catch((error) => error);
  await Bun.sleep(0);
  expect(f.writes).toHaveLength(1);
  await p.detach();
  expect(await first).toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  expect(await second).toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
  expect(await eof).toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
  expect(await status).toMatchObject({ code: "UNAVAILABLE" });
  expect(await termination).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(statusSignal?.aborted).toBe(true);
  expect(terminationSignal?.aborted).toBe(true);
  expect(f.writes).toHaveLength(1);
  expect(f.closes).toBe(0);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("returning sustained output releases only output and preserves interactive control", async () => {
  const f = await fixture({ interactive: true });
  const p = await f.box.processes.start({ ...input, stdin: "pipe", output: { mode: "stream" } });
  const out = p.output()[Symbol.asyncIterator]();
  f.ctx.onOutput({ stream: "stdout", text: "one" });
  expect((await out.next()).value?.text).toBe("one");
  await out.return!();
  expect(f.outputDetaches).toBe(1);
  expect(f.detaches).toBe(0);
  await p.write("still usable");
  await p.closeStdin();
  expect(await p.status()).toMatchObject({ state: "running" });
  expect(await p.terminate()).toEqual({ status: "requested" });
  const waiting = p.wait();
  f.exit.resolve({ exitCode: 2 });
  expect(await waiting).toEqual({ exitCode: 2, outputComplete: false });
  await p.detach();
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback exec preserves uncertain input delivery code and effect without command replay", async () => {
  const f = await fixture({ interactive: true, capture: true });
  f.native.write = async () => {
    throw new Error("private transport input");
  };

  const running = f.box.exec({ ...input, stdin: "payload" }, { onOutput() {} });
  await expect(running).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  expect(f.starts).toBe(1);
  expect(f.closes).toBe(0);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback failure interrupts a stalled stdin write promptly without further chunks or EOF", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const writeStarted = deferred<void>();
  const gate = deferred<void>();
  let inputSignal: AbortSignal | undefined;
  f.native.write = async (bytes, context) => {
    f.writes.push(bytes);
    inputSignal = context.signal;
    writeStarted.resolve();
    await gate.promise;
  };

  const running = f.box.exec(
    { ...input, stdin: new Uint8Array(131_073) },
    {
      onOutput() {
        throw new Error("private callback failure");
      },
    },
  );

  const outcome = running.catch((error) => error);
  await writeStarted.promise;
  f.exit.resolve({ exitCode: 0 });
  f.capture.resolve({
    exitCode: 0,
    stdout: Uint8Array.of(1),
    stderr: new Uint8Array(),
    truncated: false,
  });
  await Bun.sleep(0);
  f.ctx.onOutput({ stream: "stdout", text: "progress" });
  const error = await outcome;
  expect(error).toMatchObject({
    code: "UNAVAILABLE",
    effect: "possible",
    confirmedExit: { exitCode: 0 },
    output: { exitCode: 0 },
  });
  expect(inputSignal?.aborted).toBe(true);
  expect(f.writes).toHaveLength(1);
  expect(f.closes).toBe(0);
  expect(f.detaches).toBe(1);
  expect(f.starts).toBe(1);
  gate.resolve();
  await Bun.sleep(0);
  expect(f.writes).toHaveLength(1);
  expect(f.closes).toBe(0);
  await f.client.close();
});

test("callback failure winning the stdin ACK race prevents later writes and EOF", async () => {
  const f = await fixture({ interactive: true, capture: true });
  const writeStarted = deferred<void>();
  const gate = deferred<void>();
  f.native.write = async (bytes) => {
    f.writes.push(bytes);
    writeStarted.resolve();
    await gate.promise;
  };

  const running = f.box.exec(
    { ...input, stdin: new Uint8Array(131_073) },
    {
      onOutput() {
        gate.resolve();
        throw new Error("private callback race");
      },
    },
  );

  const outcome = running.catch((error) => error);
  await writeStarted.promise;
  f.ctx.onOutput({ stream: "stdout", text: "progress" });
  expect(await outcome).toMatchObject({ code: "UNAVAILABLE", effect: "possible" });
  await Bun.sleep(0);
  expect(f.writes).toHaveLength(1);
  expect(f.closes).toBe(0);
  expect(f.starts).toBe(1);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback exec preserves initiating EOF uncertainty and stops output observation", async () => {
  const f = await fixture({ interactive: true, capture: true });
  f.native.closeStdin = async () => {
    throw new Error("private EOF acknowledgement");
  };

  const running = f.box.exec({ ...input, stdin: "payload" }, { onOutput() {} });
  await expect(running).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
  expect(f.writes).toHaveLength(1);
  expect(f.starts).toBe(1);
  expect(f.detaches).toBe(1);
  await f.client.close();
});

test("callback failure retains synchronous native exit evidence before wait settles", async () => {
  const f = await fixture({ interactive: true, capture: true });

  const running = f.box.exec(input, {
    onOutput() {
      f.confirm(17);
      throw new Error("private callback contents");
    },
  });

  const outcome = running.catch((error) => error);
  await Bun.sleep(0);
  f.ctx.onOutput({ stream: "stdout", text: "last" });
  expect(await outcome).toMatchObject({
    code: "UNAVAILABLE",
    confirmedExit: { exitCode: 17, outputComplete: false },
  });
  expect(f.starts).toBe(1);
  await f.client.close();
});
