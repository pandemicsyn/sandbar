import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type HostContext } from "sandbar-adapter";
import { Sandbar, SandbarError, type ConnectOptions, type CloseOptions } from "./index";
import { bindAdapter } from "./bound";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

const session = () => ({
  scope: { authority: { kind: "account", id: "one" }, partition: {} },
  supports: { images: ["prepared" as const], network: ["blocked" as const] },
  async create() {
    return { id: "one", state: "running" as const };
  },
  async destroy() {
    throw new Error("Must not destroy remote compute");
  },
});

function fixture(connect: (host: HostContext) => Promise<ReturnType<typeof session>>) {
  const definition = defineAdapter({
    name: "example.wait",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    connect: ({ host }) => connect(host),
  });

  return {
    bound: bindAdapter(definition, {}, {}),
    advanced: { adapter: definition, config: {}, credentials: {} },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("preaborted setup never calls either adapter overload", async () => {
  let calls = 0;

  const adapter = fixture(async () => {
    calls++;

    return session();
  });

  const signal = AbortSignal.abort("stop");

  for (const connect of [
    () => Sandbar.connect(adapter.bound, { signal }),
    () => Sandbar.connect({ ...adapter.advanced, signal }),
  ]) {
    const pending = connect();
    await expect(pending).rejects.toMatchObject({
      code: "WAIT_ABORTED",
      effect: "none",
      cause: "stop",
    });
  }

  expect(calls).toBe(0);
});

test("hung setup is bounded; host receives cancellation and late resources release once", async () => {
  const setup = deferred<ReturnType<typeof session>>();
  let host!: HostContext;
  let releases = 0;

  const adapter = fixture(async (context) => {
    host = context;
    host.onClose(() => {
      releases++;
    });

    return setup.promise;
  });

  await expect(Sandbar.connect(adapter.bound, { timeoutMs: 10 })).rejects.toMatchObject({
    code: "TIMEOUT",
    effect: "none",
  });
  expect(host.signal.aborted).toBe(true);
  expect(releases).toBe(1);
  host.onClose(() => {
    releases++;
  });
  setup.resolve(session());
  await tick();
  expect(releases).toBe(2);
});

test("auth failure wins, cleanup and throwing diagnostics do not replace it", async () => {
  const failure = new Error("authentication rejected");

  const adapter = fixture(async (host) => {
    host.onClose(() => {
      throw new Error("cleanup");
    });
    throw failure;
  });

  await expect(
    Sandbar.connect({
      ...adapter.advanced,
      onDiagnostic() {
        throw new Error("sink");
      },
    }),
  ).rejects.toBe(failure);
  await tick();
});

test("failed setup does not wait for a hanging release", async () => {
  const adapter = fixture(async (host) => {
    host.onClose(() => new Promise(() => {}));
    throw new Error("auth");
  });

  await expect(Sandbar.connect(adapter.bound)).rejects.toThrow("auth");
});

test("successful connection disconnects setup abort and timeout", async () => {
  const controller = new AbortController();
  let host!: HostContext;
  let releases = 0;

  const adapter = fixture(async (context) => {
    host = context;
    host.onClose(() => {
      releases++;
    });

    return session();
  });

  const options: ConnectOptions = { signal: controller.signal, timeoutMs: 10 };
  const client = await Sandbar.connect(adapter.bound, options);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(host.signal.aborted).toBe(false);
  expect(releases).toBe(0);
  await client.close();
  expect(releases).toBe(1);
});

test("abort wins synchronous resolution triggered by setup cancellation; late rejection observed", async () => {
  for (const reject of [false, true]) {
    const setup = deferred<ReturnType<typeof session>>();
    const controller = new AbortController();
    const entered = deferred<void>();

    const adapter = fixture(async (host) => {
      host.signal.addEventListener("abort", () =>
        reject ? setup.reject(new Error("late")) : setup.resolve(session()),
      );
      entered.resolve();

      return setup.promise;
    });

    const pending = Sandbar.connect(adapter.bound, { signal: controller.signal });
    await entered.promise;
    controller.abort("race");
    await expect(pending).rejects.toMatchObject({ code: "WAIT_ABORTED", cause: "race" });
    await tick();
  }
});

test("close waits independently on one attempt and immediately blocks new work", async () => {
  const release = deferred<void>();
  const order: number[] = [];

  const adapter = fixture(async (host) => {
    host.onClose(() => {
      order.push(1);
    });
    host.onClose(async () => {
      order.push(2);
      await release.promise;
    });

    return session();
  });

  const client = await Sandbar.connect(adapter.bound);
  const options: CloseOptions = { timeoutMs: 10 };
  const first = client.close(options);
  await expect(client.sandboxes.get("one")).rejects.toThrow("closed");
  const controller = new AbortController();
  const second = client.close({ signal: controller.signal });
  controller.abort("close stop");
  await expect(second).rejects.toMatchObject({ code: "WAIT_ABORTED", cause: "close stop" });
  await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(order).toEqual([2]);
  const final = client.close();
  release.resolve();
  await final;
  await client.close();
  expect(order).toEqual([2, 1]);
});

test("failed release is diagnosed once, remaining cleanup runs, repeated close settles", async () => {
  const diagnostics: unknown[] = [];
  const failure = new Error("release failed");
  let released = 0;

  const adapter = fixture(async (host) => {
    host.onClose(() => {
      released++;
    });
    host.onClose(() => {
      throw failure;
    });

    return session();
  });

  const client = await Sandbar.connect(adapter.bound, {
    onDiagnostic(error) {
      diagnostics.push(error);
      throw new Error("sink");
    },
  });

  await client.close();
  await client.close();
  expect(diagnostics).toEqual([failure]);
  expect(released).toBe(1);
});

test("both overloads and close validate budgets including null and invalid signal", async () => {
  let calls = 0;

  const adapter = fixture(async () => {
    calls++;

    return session();
  });

  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null]) {
    // SAFETY: Exercise runtime option validation with an intentionally invalid value.
    const options = { timeoutMs } as ConnectOptions;
    await expect(Sandbar.connect(adapter.bound, options)).rejects.toBeInstanceOf(SandbarError);
    await expect(Sandbar.connect({ ...adapter.advanced, ...options })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }

  expect(calls).toBe(0);
  const client = await Sandbar.connect(adapter.bound, { timeoutMs: Number.MAX_SAFE_INTEGER });
  await expect(client.close({ timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  // SAFETY: Invalid runtime signal exercises the JavaScript API boundary.
  await expect(client.close({ signal: {} as AbortSignal })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await client.close();
});

test("preaborted close still initiates exactly one cleanup attempt", async () => {
  let releases = 0;

  const adapter = fixture(async (host) => {
    host.onClose(() => {
      releases++;
    });

    return session();
  });

  const client = await Sandbar.connect(adapter.bound);
  await expect(client.close({ signal: AbortSignal.abort("stop") })).rejects.toMatchObject({
    code: "WAIT_ABORTED",
  });
  await client.close();
  expect(releases).toBe(1);
});

test("success delivery wins an abort later in the same turn", async () => {
  const controller = new AbortController();
  let host!: HostContext;
  let releases = 0;

  const adapter = fixture(async (context) => {
    host = context;
    host.onClose(() => {
      releases++;
    });

    return session();
  });

  // This reaction runs in the same microtask checkpoint as successful delivery.
  const client = await Sandbar.connect(adapter.bound, { signal: controller.signal }).then(
    (value) => {
      controller.abort("after delivery");

      return value;
    },
  );

  expect(host.signal.aborted).toBe(false);
  expect(releases).toBe(0);
  await client.close();
  expect(releases).toBe(1);
});

test("schema validation failure wins over preaborted setup without calling adapter", async () => {
  let calls = 0;

  const adapter = fixture(async () => {
    calls++;

    return session();
  });

  // SAFETY: Invalid credentials exercise the schema boundary before setup dispatch.
  const credentials: z.input<typeof adapter.advanced.adapter.credentials> =
    JSON.parse('{"extra":"invalid"}');

  await expect(
    Sandbar.connect({ ...adapter.advanced, credentials, signal: AbortSignal.abort("cancel") }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(calls).toBe(0);
});

test("abort between session resolution and success exposure never returns a closed client", async () => {
  for (const depth of [2, 3]) {
    const controller = new AbortController();
    let releases = 0;

    const adapter = fixture((host) => {
      host.onClose(() => {
        releases++;
      });

      const schedule = (remaining: number) => {
        if (remaining === 0) controller.abort("resolution race");
        else queueMicrotask(() => schedule(remaining - 1));
      };

      schedule(depth);

      return Promise.resolve(session());
    });

    await expect(
      Sandbar.connect(adapter.bound, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED", cause: "resolution race" });
    expect(releases).toBe(1);
  }
});
