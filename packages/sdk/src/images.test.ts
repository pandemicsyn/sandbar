import { expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  ResourceReference,
  type AdapterSession,
  type ImageInfo,
} from "@sandbar-sdk/adapter";
import {
  AdapterImage,
  Image,
  OutcomeUnknownError,
  Sandbar,
  SandbarError,
  UnsupportedFeatureError,
  type RecoveryReference,
} from "./index";

const scope = { authority: { kind: "account", id: "one" }, partition: { region: "test" } };

const name = "fixture.images";

function imageRef(
  nativeId: string,
  ownership: ResourceReference["ownership"] = "unknown",
): ResourceReference {
  return ResourceReference.parse({
    version: 1,
    kind: "image",
    provider: name,
    scope,
    nativeId,
    ownership,
  });
}

function info(ref: ResourceReference): ImageInfo {
  return {
    reference: ref,
    state: "ready",
    createdAt: null,
    source: { kind: "oci", value: "node:24" },
    visibility: "private",
    nativeDependencies: [],
  };
}

type Hooks = Partial<
  Pick<
    AdapterSession,
    "imageBuild" | "imageInspect" | "imageList" | "imageListCoverage" | "imageDelete"
  >
>;

async function connect(hooks: Hooks, onReference?: (ref: RecoveryReference) => void) {
  const adapter = defineAdapter({
    name,
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        supports: { images: ["prepared", "oci"], network: ["blocked"] },
        async create() {
          throw Error("No allocation in this fixture");
        },
        async destroy() {
          throw Error("No compute deletion in this fixture");
        },
        ...hooks,
      };
    },
  });

  return Sandbar.connect({ adapter, config: {}, credentials: {}, onReference });
}

test("a built image exposes its adapter reference and can be inspected and deleted", async () => {
  const calls = { build: 0, inspect: 0, delete: 0 };
  const built = imageRef("img-1", "verified-created");
  const deleted = new Set<string>();

  const client = await connect({
    imageBuild: async () => {
      calls.build++;

      return { preparedId: "img-1", retainedResources: [], image: built };
    },
    async imageInspect(ref) {
      calls.inspect++;

      if (deleted.has(ref.nativeId)) throw new Error("gone");

      return info(ref);
    },
    imageDelete: async (ref) => {
      calls.delete++;
      deleted.add(ref.nativeId);

      return { deleted: true, reference: ref };
    },
  });

  try {
    const result = await client.images.build({ source: Image.oci("node:24") });
    expect(result.prepared.value).toBe("img-1");
    expect(result.reference).toEqual(built);
    expect(Object.isFrozen(result.reference)).toBe(true);

    const handle = await client.images.get(result.reference);
    expect(handle).toBeInstanceOf(AdapterImage);
    expect(handle.id).toBe("img-1");
    expect(handle.prepared).toEqual(result.prepared);
    expect((await handle.inspect()).source).toEqual({ kind: "oci", value: "node:24" });

    const outcome = await client.images.delete(result.reference);
    expect(outcome).toEqual({ deleted: true, reference: built });
    expect(calls).toEqual({ build: 1, inspect: 2, delete: 1 });

    const caps = await client.capabilities();
    expect(caps.imageManagement).toEqual({
      inspect: { status: "supported", value: {} },
      list: { status: "unsupported", reason: "Operation is not implemented" },
      delete: { status: "supported", value: {} },
    });
  } finally {
    await client.close();
  }
});

test("a build without an adapter reference reports unknown ownership, never verified", async () => {
  const client = await connect({
    imageBuild: async () => ({ preparedId: "img-2", retainedResources: [] }),
  });

  try {
    const result = await client.images.build({ source: Image.oci("node:24") });
    expect(result.reference).toEqual(imageRef("img-2", "unknown"));
  } finally {
    await client.close();
  }
});

test("a build reference naming another image or scope is an unknown outcome", async () => {
  for (const image of [
    imageRef("other", "verified-created"),
    { ...imageRef("img-3"), scope: { authority: { kind: "account", id: "two" }, partition: {} } },
  ]) {
    const client = await connect({
      imageBuild: async () => ({ preparedId: "img-3", retainedResources: [], image }),
    });

    try {
      await expect(client.images.build({ source: Image.oci("node:24") })).rejects.toBeInstanceOf(
        OutcomeUnknownError,
      );
    } finally {
      await client.close();
    }
  }
});

test("missing image hooks report clear unsupported errors before provider I/O", async () => {
  const client = await connect({});

  try {
    const ref = imageRef("img");

    for (const action of [
      () => client.images.get(ref),
      () => client.images.list({ limit: 10 }),
      () => client.images.delete(ref),
      () => client.images.submitDelete(ref),
    ]) {
      const error = await action().catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(UnsupportedFeatureError);
      expect(error).toMatchObject({ code: "UNSUPPORTED", effect: "none" });
    }

    expect((await client.capabilities()).imageManagement).toEqual({
      inspect: { status: "unsupported", reason: "Operation is not implemented" },
      list: { status: "unsupported", reason: "Operation is not implemented" },
      delete: { status: "unsupported", reason: "Operation is not implemented" },
    });
  } finally {
    await client.close();
  }
});

test("image reference validation rejects other kinds and scopes before provider I/O", async () => {
  let calls = 0;

  const client = await connect({
    async imageInspect() {
      calls++;
      throw new Error("Must not inspect");
    },
    imageDelete: async () => {
      calls++;
      throw new Error("Must not delete");
    },
  });

  const valid = imageRef("img");

  const cases = [
    { ref: { ...valid, kind: "snapshot" as const }, code: "INVALID_ARGUMENT" },
    { ref: { ...valid, provider: "foreign" }, code: "CONFLICT" },
    {
      ref: { ...valid, scope: { authority: { kind: "account", id: "two" }, partition: {} } },
      code: "CONFLICT",
    },
  ];

  try {
    for (const { ref, code } of cases)
      for (const action of [
        () => client.images.get(ref),
        () => client.images.delete(ref),
        async () => new AdapterImage(client, ref),
      ])
        await expect(action()).rejects.toMatchObject({ code, effect: "none" });

    expect(calls).toBe(0);
  } finally {
    await client.close();
  }
});

test("image inventory validates coverage, bounds and scope", async () => {
  const pages: { limit: number; cursor?: string }[] = [];
  let foreign = false;

  const client = await connect({
    imageListCoverage: "provider-scope",
    async imageList(input) {
      pages.push(input);

      return {
        items: [
          info(
            foreign
              ? { ...imageRef("x"), scope: { authority: { kind: "a", id: "b" }, partition: {} } }
              : imageRef("img-a"),
          ),
        ],
        nextCursor: "next",
        coverage: "provider-scope",
      };
    },
  });

  try {
    const page = await client.images.list({ limit: 5, cursor: "c1" });
    expect(page.items.map((item) => item.reference.nativeId)).toEqual(["img-a"]);
    expect(page).toMatchObject({ nextCursor: "next", coverage: "provider-scope" });
    expect(pages).toEqual([{ limit: 5, cursor: "c1" }]);

    expect((await client.capabilities()).imageManagement.list).toEqual({
      status: "supported",
      value: { coverage: "provider-scope" },
    });

    await expect(client.images.list({ limit: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    foreign = true;
    await expect(client.images.list({ limit: 5 })).rejects.toBeInstanceOf(SandbarError);
  } finally {
    await client.close();
  }
});

test("an uncertain image delete is outcome-unknown, recoverable and never replayed", async () => {
  const saved: RecoveryReference[] = [];
  let dispatches = 0;
  let observed: "pending" | "gone" = "pending";
  const ref = imageRef("img-u", "borrowed");

  const client = await connect(
    {
      imageDelete: {
        recovery: { version: 1, token: z.strictObject({ stage: z.literal("uncertain") }) },
        async submit(_ref, ctx) {
          await ctx.checkpoint({ stage: "uncertain" });
          dispatches++;

          return ctx.unknown("Native delete response was lost");
        },
        async observe(attempt, ctx) {
          if (observed === "pending") return ctx.unknown("Still unknown; no replay");

          return { deleted: true, reference: attempt.resource! };
        },
      },
    },
    (reference) => void saved.push(reference),
  );

  try {
    const error = await client.images.delete(ref).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(error).toMatchObject({ code: "OUTCOME_UNKNOWN", effect: "possible" });
    expect(dispatches).toBe(1);

    const reference = saved.at(-1)!;
    expect(reference.kind).toBe("image_delete");
    expect(reference.resource).toEqual(ref);

    const recovered = await client.recover(reference);
    await expect(recovered.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    observed = "gone";
    expect(await (await client.recover(reference)).wait()).toEqual({
      deleted: true,
      reference: ref,
    });
    expect(dispatches).toBe(1);

    await expect(
      client.recover({ ...reference, resource: { ...ref, kind: "snapshot" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await client.close();
  }
});

test("a completed delete for another image is not reported as success", async () => {
  const client = await connect({
    imageDelete: async () => ({ deleted: true, reference: imageRef("other") }),
  });

  try {
    await expect(client.images.delete(imageRef("img"))).rejects.toBeInstanceOf(SandbarError);
  } finally {
    await client.close();
  }
});
