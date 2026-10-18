import { z } from "zod";
import {
  AdapterError,
  assertResourceScope,
  ResourceReference,
  type AdapterSession,
  type AttemptContext,
  type ImageInfo,
  type RecoveryAttempt,
  type Scope,
} from "@sandbar-sdk/adapter";
import {
  E2BTemplateDeleteRejected,
  type E2BStateTransport,
  type E2BTemplateState,
  type E2BTransport,
} from "./transport";

const templateId = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_PAGES = 100;

const DeleteToken = z
  .strictObject({
    accepted: z.boolean(),
    stage: z.enum(["uncertain", "accepted", "rejected"]),
    rejection: z.enum(["before-dispatch", "native-response"]).optional(),
    resource: z.strictObject({
      kind: z.literal("image"),
      nativeId: z.string().min(1).max(512),
      generation: z.string().min(1).max(512).optional(),
    }),
  })
  .refine((token) => token.accepted === (token.stage === "accepted"));

type Fields = Pick<
  AdapterSession,
  "imageInspect" | "imageListCoverage" | "imageList" | "imageDelete"
>;

/** E2B templates as prepared images. Deletion follows the snapshot rules for one-build templates. */
export function e2bImages(input: { scope: Scope; transport: E2BTransport; teamId?: string }) {
  const { scope, transport } = input;

  const reference = (
    id: string,
    ownership: ResourceReference["ownership"],
    generation?: string,
  ): ResourceReference => {
    const ref: ResourceReference = {
      version: 1,
      kind: "image",
      provider: "e2b",
      scope: structuredClone(scope),
      nativeId: id,
      ownership,
    };

    if (generation) ref.generation = generation;

    return ref;
  };

  const check = (ref: ResourceReference) => {
    assertResourceScope(ref, { provider: "e2b", scope });

    if (ref.kind !== "image" || !templateId.test(ref.nativeId))
      throw new AdapterError("INVALID_ARGUMENT", "Image requires a raw E2B template identity");
  };

  const need = <K extends "templates" | "deleteTemplate">(
    name: K,
  ): E2BStateTransport & Required<Pick<E2BStateTransport, K>> => {
    const state = transport.state;

    if (!state?.[name])
      throw new AdapterError("UNSUPPORTED", "Native image transport is not installed");

    // SAFETY: the guard above proved the optional native method is present.
    return state as E2BStateTransport & Required<Pick<E2BStateTransport, K>>;
  };

  const template = async (id: string) => {
    const state = transport.state;

    if (!state) throw new AdapterError("UNSUPPORTED", "Native image transport is not installed");

    return state.template(id);
  };

  function stateOf(native: E2BTemplateState, generation?: string): ImageInfo["state"] {
    const builds = generation
      ? native.builds.filter((build) => build.buildId === generation)
      : native.builds;

    if (builds.some((build) => build.status === "ready")) return "ready";

    if (builds.some((build) => build.status === "building" || build.status === "waiting"))
      return "creating";

    return "unknown";
  }

  async function dependencies(id: string): Promise<ImageInfo["nativeDependencies"]> {
    try {
      const page = await transport.list({}, 100);

      if (page.nextToken) return null;

      return page.items
        .filter((box) => box.templateId === id)
        .map((box) => ({ kind: "e2b-sandbox", id: box.id }));
    } catch {
      return null;
    }
  }

  async function inspect(ref: ResourceReference): Promise<ImageInfo> {
    check(ref);
    const native = await template(ref.nativeId);

    if (!native) throw new AdapterError("NOT_FOUND", "Image template is unavailable");

    if (native.templateId !== ref.nativeId)
      throw new AdapterError("CONFLICT", "Image native template identity differs");

    if (ref.generation && !native.builds.some((build) => build.buildId === ref.generation))
      throw new AdapterError("NOT_FOUND", "Image build is no longer in the template");

    return {
      reference: structuredClone(ref),
      state: stateOf(native, ref.generation),
      createdAt: null,
      source: null,
      visibility: native.public ? "public" : "private",
      nativeDependencies: await dependencies(ref.nativeId),
    };
  }

  /** Read every page once with a bound; a repeated or unbounded cursor is never trusted. */
  async function everyPage<T>(
    read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let count = 0; count < MAX_PAGES; count++) {
      signal?.throwIfAborted();
      const page = await read(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;

      if (!cursor) return items;

      if (seen.has(cursor)) throw new AdapterError("CONFLICT", "E2B inventory repeated a cursor");
      seen.add(cursor);
    }

    throw new AdapterError("CONFLICT", "E2B inventory exceeds its page bound");
  }

  const local = (name: string) =>
    name
      .slice(name.lastIndexOf("/") + 1)
      .replace(/:default$/, "")
      .split(":")[0]!;

  /** Prove the DELETE path can only reach this one private, single-build, unused template. */
  async function deletePreflight(ref: ResourceReference, signal?: AbortSignal) {
    check(ref);
    const state = need("templates");
    signal?.throwIfAborted();
    const native = await state.template(ref.nativeId);

    if (!native) throw new AdapterError("NOT_FOUND", "Image template is unavailable");

    if (native.templateId !== ref.nativeId || native.public)
      throw new AdapterError("CONFLICT", "Image template identity or private visibility differs");

    if (ref.generation && !native.builds.some((build) => build.buildId === ref.generation))
      throw new AdapterError("CONFLICT", "Image build is no longer in the containing template");

    if (native.builds.length !== 1)
      throw new AdapterError(
        "CONFLICT",
        "Image deletion cannot expand into a shared multi-build template",
      );

    const templates = await everyPage((cursor) => state.templates({ limit: 100, cursor }), signal);

    if (
      templates.some(
        (value) =>
          value.templateId !== ref.nativeId &&
          value.names.some((name) => local(name) === ref.nativeId),
      )
    )
      throw new AdapterError("CONFLICT", "E2B template identity is shadowed by another alias");

    const snapshots = await everyPage((cursor) => state.snapshots({ limit: 100, cursor }), signal);

    if (snapshots.some((value) => value.snapshotId.split(":")[0] === ref.nativeId))
      throw new AdapterError(
        "CONFLICT",
        "This template is a captured sandbox snapshot; delete it with snapshots.delete()",
      );

    signal?.throwIfAborted();
    const boxes = await transport.list({}, 100);

    if (boxes.nextToken || boxes.items.some((box) => box.templateId === ref.nativeId))
      throw new AdapterError(
        "CONFLICT",
        "Image has native sandbox dependencies or incomplete inventory",
      );
  }

  const tokenResource = (ref: ResourceReference): z.infer<typeof DeleteToken>["resource"] => {
    const resource: z.infer<typeof DeleteToken>["resource"] = {
      kind: "image",
      nativeId: ref.nativeId,
    };

    if (ref.generation) resource.generation = ref.generation;

    return resource;
  };

  const sameResource = (
    saved: z.infer<typeof DeleteToken>["resource"],
    ref: ResourceReference | undefined,
  ): ref is ResourceReference =>
    !!ref &&
    ref.kind === "image" &&
    ref.nativeId === saved.nativeId &&
    ref.generation === saved.generation;

  async function rejectBeforeDispatch(ref: ResourceReference, ctx: AttemptContext) {
    await ctx.checkpoint({
      accepted: false,
      stage: "rejected",
      rejection: "before-dispatch",
      resource: tokenResource(ref),
    });

    return ctx.reject("UNAVAILABLE", "Image deletion cancelled before dispatch");
  }

  const fields: Fields = {
    imageInspect: (ref) => inspect(ref),
    imageListCoverage: "provider-scope",
    async imageList(page) {
      const values = await need("templates").templates({
        teamId: input.teamId,
        limit: page.limit,
        cursor: page.cursor,
      });

      return {
        items: values.items
          .filter((value) => templateId.test(value.templateId))
          .map((value) => ({
            reference: reference(value.templateId, "unknown", value.buildId),
            state:
              value.buildStatus === "ready"
                ? "ready"
                : value.buildStatus === "error"
                  ? "unknown"
                  : "creating",
            createdAt: null,
            source: null,
            visibility: "unknown",
            nativeDependencies: null,
          })),
        nextCursor: values.nextCursor,
        coverage: "provider-scope",
      };
    },
    imageDelete: {
      recovery: { version: 1, token: DeleteToken },
      async prepare(ref) {
        await deletePreflight(ref);

        return ref;
      },
      async submit(ref, ctx) {
        try {
          await deletePreflight(ref, ctx.signal);
        } catch (error) {
          if (!ctx.signal.aborted) throw error;

          return rejectBeforeDispatch(ref, ctx);
        }

        if (ctx.signal.aborted) return rejectBeforeDispatch(ref, ctx);
        const resource = tokenResource(ref);
        await ctx.checkpoint({ accepted: false, stage: "uncertain", resource });

        if (ctx.signal.aborted) return rejectBeforeDispatch(ref, ctx);

        let accepted: boolean;

        try {
          accepted = await need("deleteTemplate").deleteTemplate(ref.nativeId, ctx.signal);
        } catch (error) {
          if (!(error instanceof E2BTemplateDeleteRejected)) throw error;
          await ctx.checkpoint({
            accepted: false,
            stage: "rejected",
            rejection: "native-response",
            resource,
          });

          return ctx.reject("UNAVAILABLE", error.message);
        }

        // A 404 after a successful preflight is not a confirmed deletion by this request.
        const stage = accepted ? "accepted" : "uncertain";
        await ctx.checkpoint({ accepted, stage, resource });

        return ctx.pending({ accepted, stage, resource }, { pollAfterMs: 0 });
      },
      async observe(attempt, ctx) {
        const token = DeleteToken.safeParse(attempt.token);

        if (
          !token.success ||
          token.data.stage === "rejected" ||
          !sameResource(token.data.resource, attempt.resource)
        )
          return ctx.unknown("Image delete dispatch evidence is unavailable; no replay");
        check(attempt.resource);

        if (await template(attempt.resource.nativeId))
          return ctx.pending(token.data, { pollAfterMs: 500 });

        return { deleted: true, reference: attempt.resource };
      },
      async continue(attempt: RecoveryAttempt, ctx: AttemptContext) {
        const token = DeleteToken.safeParse(attempt.token);

        if (
          !token.success ||
          token.data.stage !== "rejected" ||
          !token.data.rejection ||
          !sameResource(token.data.resource, attempt.resource)
        )
          return ctx.unknown("Image deletion rejection evidence is unavailable; no replay");
        check(attempt.resource);

        return ctx.reject("UNAVAILABLE", "Image deletion was rejected; no replay");
      },
    },
  };

  return { fields, reference };
}
