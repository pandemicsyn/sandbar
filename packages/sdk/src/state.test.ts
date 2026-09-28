import { expect, test } from "bun:test";
import { z } from "zod";
import { AdapterError, defineAdapter, type SnapshotProfile } from "sandbar-adapter";
import { Sandbar, Image, UnsupportedFeatureError } from "./index";

const profile: SnapshotProfile = {
  id: "memory",
  preserve: "filesystem+memory",
  sourceStates: ["running"],
  interruption: "pause",
  sourceAfter: "unchanged",
  consistency: "crash-consistent",
  connections: "dropped",
  mountHandling: "none",
};

test("direct checks are read-only, required guarantees gate create, and minimal adapters still work", async () => {
  let creates = 0;
  let destroys = 0;
  let captures = 0;
  let status: "supported" | "unknown" | "unavailable" = "supported";

  const adapter = defineAdapter({
    name: "fixture.state",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          creates++;

          return { id: "box", state: "running" };
        },
        async destroy() {
          destroys++;

          return { computeStopped: true, retainedResources: [] };
        },
        async inspect(box) {
          return { id: box.id, state: "running" };
        },
        async snapshotProfiles() {
          return status === "supported"
            ? { status, value: { profiles: [profile] } }
            : { status, reason: "fixture evidence" };
        },
        async snapshotCapture() {
          captures++;
          throw new Error("future slice");
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });

  const input = {
    environment: Image.prepared("base"),
    requirements: { snapshot: { preserve: "filesystem" as const } },
  };

  expect((await client.sandboxes.checkCreate(input)).status).toBe("unsupported");
  await expect(client.sandboxes.create(input)).rejects.toMatchObject({
    code: "UNSUPPORTED",
    effect: "none",
    feature: "create",
  });
  expect(creates).toBe(0);
  const box = await client.sandboxes.create({ environment: input.environment });
  expect((await box.checkSnapshot({ preserve: "filesystem+memory" })).status).toBe("supported");
  expect((await client.capabilities()).snapshots.capture.status).toBe("supported");
  const caps = await box.capabilities();
  caps.network.push("all");
  expect((await box.capabilities()).network).toEqual(["blocked"]);

  for (const value of ["unknown", "unavailable"] as const) {
    status = value;

    const required = {
      environment: input.environment,
      requirements: { snapshot: { preserve: "filesystem+memory" as const } },
    };

    expect((await client.sandboxes.checkCreate(required)).status).toBe(value);
    await expect(client.sandboxes.create(required)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      effect: "none",
    });
  }

  expect(captures).toBe(0);
  expect(creates).toBe(1);
  expect(destroys).toBe(0);
  await box.destroy();
  expect(destroys).toBe(1);
  await client.close();
});

for (const status of ["unsupported", "unknown", "unavailable"] as const) {
  test(`capability drift to ${status} during preparation stays effect-free`, async () => {
    let reads = 0;
    let creates = 0;
    let references = 0;

    const adapter = defineAdapter({
      name: "fixture.drift",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          async snapshotProfiles() {
            reads++;

            return reads === 1
              ? { status: "supported" as const, value: { profiles: [profile] } }
              : { status, reason: "evidence changed" };
          },
          async snapshotCapture() {
            throw new Error("Must not capture");
          },
          async create() {
            creates++;

            return { id: "box", state: "running" };
          },
          async destroy() {
            throw new Error("Must not destroy");
          },
        };
      },
    });

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      onReference() {
        references++;
      },
    });

    try {
      let failure: Error | undefined;

      try {
        await client.sandboxes.create({
          environment: Image.prepared("base"),
          requirements: { snapshot: { preserve: "filesystem+memory" } },
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failure = error;
      }

      expect(failure).toMatchObject({
        code: status === "unsupported" ? "UNSUPPORTED" : "UNAVAILABLE",
        effect: "none",
      });

      if (status === "unsupported") expect(failure).toBeInstanceOf(UnsupportedFeatureError);
      expect(reads).toBe(2);
      expect(creates).toBe(0);
      expect(references).toBe(0);
    } finally {
      await client.close();
    }
  });
}

for (const mode of ["direct", "advanced"] as const) {
  test(`${mode} checks finish before the submission marker and cannot orphan native submission`, async () => {
    let marked = false;
    let reads = 0;
    let creates = 0;
    let observations = 0;

    const adapter = defineAdapter({
      name: "fixture.barrier",
      config: z.strictObject({}),
      credentials: z.strictObject({}),
      async connect() {
        return {
          scope: { authority: { kind: "account", id: "one" }, partition: {} },
          supports: { images: ["prepared"], network: ["blocked"] },
          async snapshotProfiles() {
            reads++;

            if (marked) throw new Error("Capability read after marker");

            return { status: "supported" as const, value: { profiles: [profile] } };
          },
          async snapshotCapture() {
            throw new Error("Must not capture");
          },
          create: {
            recovery: { version: 1, token: z.strictObject({ job: z.string() }) },
            async submit(_input, context) {
              expect(marked).toBe(true);
              creates++;

              return context.pending({ job: "one" }, { pollAfterMs: 0 });
            },
            async observe() {
              observations++;

              return { id: "box", state: "running" as const };
            },
          },
          async destroy() {
            throw new Error("Must not destroy");
          },
        };
      },
    });

    const client = await Sandbar.connect({
      adapter,
      config: {},
      credentials: {},
      onReference() {
        marked = true;
      },
    });

    try {
      if (mode === "direct") {
        const operation = await client.sandboxes.submitCreate({
          environment: Image.prepared("base"),
          requirements: { snapshot: { preserve: "filesystem+memory" } },
        });

        expect(creates).toBe(1);
        expect(await (await client.recover(operation.reference)).wait()).toMatchObject({
          id: "box",
        });
        expect(reads).toBe(3);
      } else {
        const prepared = await client.operations.prepare("create", {
          image: { kind: "prepared", value: "base" },
          networkPolicy: "blocked",
          requirements: { snapshot: { preserve: "filesystem+memory" } },
        });

        const result = await prepared.submit(
          { operationId: "op", submissionId: "submission", invocationKey: "invocation" },
          {
            beforeSubmit: async () => {
              marked = true;

              return true;
            },
          },
        );

        expect(result?.kind).toBe("pending");
        expect(reads).toBe(2);
        await expect(
          prepared.submit(
            { operationId: "op", submissionId: "submission", invocationKey: "invocation" },
            { beforeSubmit: async () => true },
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }

      expect(creates).toBe(1);
      expect(observations).toBe(mode === "direct" ? 1 : 0);
    } finally {
      await client.close();
    }
  });
}

test("create preflight observes caller abort and skips reads for pre-aborted calls", async () => {
  let reads = 0;
  let readSignal: AbortSignal | undefined;
  let started!: () => void;

  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });

  const adapter = defineAdapter({
    name: "fixture.abort-state",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async snapshotProfiles(_target, context) {
          reads++;
          readSignal = context.signal;
          started();

          return new Promise<never>(() => {});
        },
        async snapshotCapture() {
          throw new Error("Must not capture");
        },
        async create() {
          throw new Error("Must not create");
        },
        async destroy() {
          throw new Error("Must not destroy");
        },
      };
    },
  });

  const client = await Sandbar.connect({ adapter, config: {}, credentials: {} });
  const controller = new AbortController();

  const input = {
    environment: Image.prepared("base"),
    requirements: { snapshot: { preserve: "filesystem+memory" as const } },
  };

  try {
    const creating = client.sandboxes.create(input, { signal: controller.signal });
    await reading;
    controller.abort();
    await expect(creating).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    expect(readSignal?.aborted).toBe(true);
    await expect(
      client.sandboxes.submitCreate(input, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WAIT_ABORTED", effect: "none" });
    expect(reads).toBe(1);
  } finally {
    await client.close();
  }
});

for (const mode of ["direct", "advanced"] as const) {
  for (const failure of ["abort", "timeout"] as const) {
    test(`${mode} pre-marker revalidation ${failure} remains effect-free`, async () => {
      let reads = 0;
      let markers = 0;
      let creates = 0;
      let started!: () => void;

      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });

      const adapter = defineAdapter({
        name: "fixture.revalidation-failure",
        config: z.strictObject({}),
        credentials: z.strictObject({}),
        async connect() {
          return {
            scope: { authority: { kind: "account", id: "one" }, partition: {} },
            supports: { images: ["prepared"], network: ["blocked"] },
            async snapshotProfiles() {
              reads++;

              if (reads === (mode === "direct" ? 3 : 2)) {
                started();

                if (failure === "timeout")
                  throw new AdapterError("TIMEOUT", "Adapter capability deadline exceeded");

                return new Promise<never>(() => {});
              }

              return { status: "supported" as const, value: { profiles: [profile] } };
            },
            async snapshotCapture() {
              throw new Error("Must not capture");
            },
            async create() {
              creates++;

              return { id: "box", state: "running" };
            },
            async destroy() {
              throw new Error("Must not destroy");
            },
          };
        },
      });

      const client = await Sandbar.connect({
        adapter,
        config: {},
        credentials: {},
        onReference() {
          markers++;
        },
      });

      const controller = new AbortController();

      try {
        const creating =
          mode === "direct"
            ? client.sandboxes.submitCreate(
                {
                  environment: Image.prepared("base"),
                  requirements: { snapshot: { preserve: "filesystem+memory" } },
                },
                { signal: controller.signal },
              )
            : (
                await client.operations.prepare("create", {
                  image: { kind: "prepared", value: "base" },
                  networkPolicy: "blocked",
                  requirements: { snapshot: { preserve: "filesystem+memory" } },
                })
              ).submit(
                { operationId: "op", submissionId: "submission", invocationKey: "invocation" },
                {
                  signal: controller.signal,
                  beforeSubmit: async () => {
                    markers++;

                    return true;
                  },
                },
              );

        const failed = creating.catch((error) => error);

        await reading;

        if (failure === "abort") controller.abort();
        expect(await failed).toMatchObject({
          code: failure === "abort" ? "WAIT_ABORTED" : "TIMEOUT",
          effect: "none",
        });
        expect(markers).toBe(0);
        expect(creates).toBe(0);
      } finally {
        await client.close();
      }
    });
  }
}
