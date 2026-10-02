import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { z } from "zod";
import {
  AdapterError,
  defineAdapter,
  type NativeProcess,
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
  options: { early?: string; late?: boolean; unsupported?: boolean; noncooperative?: boolean } = {},
) {
  const exit = deferred<{ exitCode: number }>();
  const start = deferred<NativeProcess>();
  let ctx!: ProcessStartContext;
  let starts = 0;
  let detaches = 0;
  let confirmedExit: { exitCode: number } | undefined;

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

  const adapter = defineAdapter({
    name: "stream.fixture",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        processes: options.unsupported
          ? undefined
          : {
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
