import { expect, test, spyOn } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  unknownSandboxFacts,
  type AdapterSession,
  type Sandbox,
} from "sandbar-adapter";
import { Sandbar, Image, SandbarError } from "./index";

function fixture(reopening: boolean) {
  const scope = { authority: { kind: "fixture", id: "account" }, partition: {} };

  const reference = sandboxReference("reopen-fixture", scope, "native", {
    operation: "op",
    submission: "submission",
  });

  let hold = false;
  let inspected = 0;
  const dispatched: { operation: string; sandbox: Sandbox }[] = [];

  const record = (operation: string, sandbox: Sandbox) => {
    dispatched.push({ operation, sandbox });
  };

  const adapter = defineAdapter({
    name: "reopen-fixture",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      const session: AdapterSession = {
        scope,
        supports: {
          images: ["prepared"],
          network: ["blocked"],
          exec: { commands: ["argv", "shell"], maxOutputBytes: 1_048_576 },
          fileWrite: { overwrite: true, noClobber: true },
        },
        async create() {
          if (reopening) return { id: "native", state: "running", reference };

          return { id: "native", state: "running" };
        },
        async snapshotProfiles(target) {
          if (target.sandbox) record("snapshotProfiles", target.sandbox);

          return {
            status: "supported",
            value: {
              defaultProfileId: "fixture",
              profiles: [
                {
                  id: "fixture",
                  preserve: "filesystem",
                  sourceStates: ["running"],
                  interruption: "none",
                  sourceAfter: "unchanged",
                  consistency: "crash-consistent",
                  connections: "dropped",
                  mountHandling: "none",
                  restoreExecution: "fresh",
                },
              ],
            },
          };
        },
        async snapshotCapture(input, ctx) {
          record("snapshotCapture", input.sandbox);

          return ctx.reject("UNSUPPORTED", "fixture");
        },
        async resourceCapabilities(target) {
          if (target.sandbox) record("capabilities", target.sandbox);
          const unsupported = { status: "unsupported" as const, reason: "fixture" };

          return { restore: unsupported, volumes: unsupported, mounts: unsupported };
        },
        exec: {
          recovery: { version: 1, token: z.strictObject({}) },
          async submit(input, ctx) {
            record("exec", input.sandbox);

            return ctx.pending({}, { pollAfterMs: 1 });
          },
          async observe(attempt) {
            if (attempt.sandbox) record("observeExec", attempt.sandbox);

            return {
              exitCode: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
              truncated: false,
            };
          },
        },
        files: {
          maxBytes: 1024,
          async read(input) {
            record("read", input.sandbox);

            return new Uint8Array();
          },
          async write(input) {
            record("write", input.sandbox);

            return { bytesWritten: input.bytes.length };
          },
        },
        async destroy(input) {
          record("destroy", input);

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(input) {
          record("inspect", input);

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
    dispatched,
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

test("reopened handles retain verified reference in every sandbox dispatch and execution observation", async () => {
  const f = fixture(true);
  const client = await f.connect();

  try {
    const box = await client.sandboxes.get(f.reference);
    await box.inspect();
    await box.capabilities();
    await box.checkSnapshot();
    await expect(box.snapshot()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await box.exec(["true"]);
    await box.readFile("/fixture");
    await box.writeFile("/fixture", new Uint8Array([1]));
    await box.destroy();
    expect(new Set(f.dispatched.map((call) => call.operation))).toEqual(
      new Set([
        "inspect",
        "capabilities",
        "snapshotProfiles",
        "snapshotCapture",
        "exec",
        "observeExec",
        "read",
        "write",
        "destroy",
      ]),
    );

    for (const call of f.dispatched)
      expect(call.sandbox).toEqual({ id: "native", reference: f.reference });
  } finally {
    await client.close();
  }
});

test("invalid sandbox references surface SandbarError with no effect before reopening", async () => {
  const f = fixture(true);
  const client = await f.connect();

  try {
    for (const reference of [
      { ...f.reference, nativeId: "" },
      { ...f.reference, provider: "other" },
      { ...f.reference, scope: { ...f.reference.scope, partition: { region: "other" } } },
    ]) {
      const error = await client.sandboxes.get(reference).catch((error) => error);
      expect(error).toBeInstanceOf(SandbarError);
      expect(error).toMatchObject({ effect: "none" });
    }

    expect(f.inspected()).toBe(0);
  } finally {
    await client.close();
  }
});

test("SDK reopen timeout normalizes a non-cooperative hook", async () => {
  const f = fixture(true);
  const client = await f.connect();
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);

  try {
    f.hold();
    const opening = client.sandboxes.get(f.reference);
    expect(timeout).toHaveBeenCalledWith(30000);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    const error = await opening.catch((error) => error);
    expect(error).toBeInstanceOf(SandbarError);
    expect(error).toMatchObject({ code: "TIMEOUT", effect: "none" });
  } finally {
    timeout.mockRestore();
    await client.close();
  }
});
