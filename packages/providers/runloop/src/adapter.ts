import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  assertResourceIdentity,
  assertResourceScope,
  defaultLifetime,
  defineAdapter,
  resolveSnapshot,
  ResourceMinimums,
  ResourceReference,
  sandboxReference,
  smallestSize,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type RestoreOptions,
  type ExecInput,
  type Fact,
  type FileWriteInput,
  type Json,
  type ObserveContext,
  type ReadContext,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type SandboxResources,
  type SandboxState,
  type SnapshotInfo,
  type SnapshotProfile,
} from "@sandbar-sdk/adapter";
import { filesResult, parseWrapper, quote, wrapperScript, type WrapperResult } from "./exec";
import {
  createRunloopClient,
  Id,
  nativeFailure,
  refusedBeforeEffect,
  RUNLOOP_API,
  type CreateDevboxBody,
  type Devbox,
  type Execution,
  type Fetch,
  type LaunchParameters,
  type NetworkPolicy,
  type RunloopClient,
  type Snapshot,
} from "./transport";
import { startRunloopProcess } from "./process";

/** Prepared image value for Runloop's default Devbox image (no blueprint). */
export const BASE_IMAGE = "runloop-default";

/** Longest command deadline the adapter waits for; the SDK accepts up to an hour. */
export const MAX_EXEC_SECONDS = 3600;

/** Per-stream output bound collected through the guest wrapper. */
export const MAX_OUTPUT_BYTES = 1_048_576;

/** Bound for file reads and writes, which move through memory. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Runloop's documented maximum keep-alive (48 hours). */
const MAX_LIFETIME_SECONDS = 172_800;

/** Devbox and snapshot metadata keys that record the Sandbar attempt that created them. */
const MARK = {
  operation: "sandbar_operation",
  submission: "sandbar_submission",
  /** Requested egress (`blocked` or `internet`), so recovery can check the policy without the token. */
  network: "sandbar_network",
} as const;

/** Name of the account network policy the adapter uses for `network: "blocked"`. */
export const BLOCKED_POLICY_NAME = "sandbar-blocked";

/** Runloop tunnel URLs are `https://{port}-{tunnel_key}.tunnel.runloop.ai`. */
const TUNNEL_DOMAIN = "tunnel.runloop.ai";

const Configuration = z
  .strictObject({
    /** Default egress: `blocked` attaches a deny-all network policy; `internet` attaches none. */
    network: z.enum(["blocked", "internet"]).default("blocked"),
    /** Default prepared image: a blueprint name or id, or the default Devbox image. */
    image: z.string().min(1).max(256).default(BASE_IMAGE),
    /** Minimum size; the smallest Runloop resource size that meets it is used. */
    resources: ResourceMinimums.optional(),
    lifecycle: z
      .strictObject({
        /** Shut down this many seconds after creation. Runloop ignores it once an idle window is set. */
        lifetimeSeconds: z.number().int().min(60).max(MAX_LIFETIME_SECONDS).optional(),
        /** Suspend after this many idle seconds instead of a fixed lifetime. */
        idleSeconds: z.number().int().min(60).max(MAX_LIFETIME_SECONDS).optional(),
      })
      .refine(
        (value) => value.lifetimeSeconds === undefined || value.idleSeconds === undefined,
        "Runloop applies either a lifetime or an idle window, not both",
      )
      .default({}),
    preview: z
      .strictObject({
        /** `protected` tunnels need the returned header; `public` URLs are open to anyone with them. */
        access: z.enum(["protected", "public"]).default("protected"),
      })
      .default({ access: "protected" }),
  })
  .transform(({ lifecycle: { idleSeconds, lifetimeSeconds }, ...value }) => ({
    ...value,
    lifecycle:
      idleSeconds === undefined
        ? { lifetimeSeconds: lifetimeSeconds ?? defaultLifetime(MAX_LIFETIME_SECONDS) }
        : { idleSeconds },
  }));

type Configuration = z.output<typeof Configuration>;

const Credentials = z.strictObject({ apiKey: z.string().min(1) });

/** Runloop resource sizes, smallest first; the last two use CUSTOM_SIZE. */
const SIZES = [
  { request: "X_SMALL", vcpus: 0.5, memoryMiB: 1024 },
  { request: "SMALL", vcpus: 1, memoryMiB: 2048 },
  { request: "MEDIUM", vcpus: 2, memoryMiB: 4096 },
  { request: "LARGE", vcpus: 2, memoryMiB: 8192 },
  { request: "X_LARGE", vcpus: 4, memoryMiB: 16384 },
  { request: "XX_LARGE", vcpus: 8, memoryMiB: 32768 },
  { request: "CUSTOM_SIZE", vcpus: 16, memoryMiB: 32768 },
  { request: "CUSTOM_SIZE", vcpus: 16, memoryMiB: 65536 },
] as const;

type Size = (typeof SIZES)[number];

function launchParameters(
  config: Configuration,
  size: Size | undefined,
  policy: string | null,
  lifetimeOverride?: number,
): LaunchParameters {
  const launch: LaunchParameters = {};
  const { idleSeconds } = config.lifecycle;
  const lifetimeSeconds = lifetimeOverride ?? config.lifecycle.lifetimeSeconds;

  if (size?.request === "CUSTOM_SIZE") {
    launch.resource_size_request = size.request;
    launch.custom_cpu_cores = size.vcpus;
    launch.custom_gb_memory = size.memoryMiB / 1024;
  } else if (size) launch.resource_size_request = size.request;

  if (idleSeconds === undefined) launch.keep_alive_time_seconds = lifetimeSeconds ?? 900;
  else launch.lifecycle = { after_idle: { idle_time_seconds: idleSeconds, on_idle: "suspend" } };

  if (policy !== null) launch.network_policy_id = policy;

  return launch;
}

function devboxSize(devbox: Devbox): Fact<SandboxResources> {
  const launch = devbox.launch_parameters;
  // Runloop documents SMALL as the size used when none is requested.
  const request = launch?.resource_size_request ?? "SMALL";

  if (request === "CUSTOM_SIZE") {
    const vcpus = launch?.custom_cpu_cores ?? 0;
    const memory = launch?.custom_gb_memory ?? 0;

    return vcpus > 0 && memory > 0
      ? { status: "known", value: { vcpus, memoryMiB: Math.round(memory * 1024) } }
      : { status: "unknown", reason: "Runloop did not report the custom size" };
  }

  const size = SIZES.find((value) => value.request === request);

  return size
    ? { status: "known", value: { vcpus: size.vcpus, memoryMiB: size.memoryMiB } }
    : { status: "unknown", reason: `Runloop reported an unrecognized size ${request}` };
}

function state(status: string): SandboxState {
  switch (status) {
    case "scheduled":
    case "queued":
    case "provisioning":
    case "initializing":
      return "creating";
    case "running":
      return "running";
    case "suspended":
      return "suspended";
    case "resuming":
      return "restoring";
    case "shutdown":
      return "destroyed";
    default:
      return "unknown";
  }
}

function isDenyAll(policy: NetworkPolicy): boolean {
  const egress = policy.egress;

  return (
    !egress.allow_all &&
    egress.allowed_hostnames.length === 0 &&
    egress.allowed_cidrs.length === 0 &&
    !egress.allow_devbox_to_devbox &&
    !egress.allow_agent_gateway &&
    !egress.allow_mcp_gateway &&
    !egress.allow_runloop_mirrors
  );
}

/** RFC 9562 UUIDv7, which Runloop requires for command ids. */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;

  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }

  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readContext(signal: AbortSignal, seconds = 30): ReadContext {
  return { signal, deadline: Date.now() + seconds * 1000 };
}

function signalFor(ctx: ReadContext): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.max(1, ctx.deadline - Date.now()))]);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The devbox id and the network policy id the create requested (null for internet). */
const CreateToken = z.strictObject({ id: Id, policy: Id.nullable() });

const DestroyToken = z.strictObject({ id: Id });

const LifecycleToken = z.strictObject({ id: Id });

const CaptureToken = z.strictObject({ snapshot: Id, source: Id });

const DeleteToken = z.strictObject({ snapshot: Id });

type ImagePlan =
  | { blueprint_id: string }
  | { blueprint_name: string }
  | { snapshot_id: string }
  | {};

type PreparedCreate = CreateInput & {
  plan: { image: ImagePlan; policy: string | null };
};

type PreparedDestroy = Sandbox & { alreadyShutdown: boolean };

const profile: SnapshotProfile = {
  id: "runloop-disk",
  preserve: "filesystem",
  sourceStates: ["running"],
  // Runloop does not document whether a disk snapshot pauses the source; claim no less.
  interruption: "pause",
  sourceAfter: "unchanged",
  connections: "unknown",
  consistency: "unknown",
  restoreExecution: "fresh",
  mountHandling: "none",
};

const snapshotSupport = {
  status: "supported" as const,
  value: { profiles: [profile], defaultProfileId: profile.id },
};

export type RunloopAdapterOptions = {
  /** Native fetch used by the REST client; tests inject a deterministic fixture. */
  fetch?: Fetch;
  /** Poll interval while waiting for provisioning, suspension, shutdown or capture. */
  pollIntervalMs?: number;
  /** Longest a create, lifecycle change or capture waits in-call before returning a pending result. */
  settleSeconds?: number;
};

/** Constructing a definition performs no provider IO. */
export function createRunloopAdapter(options: RunloopAdapterOptions = {}) {
  const pollMs = options.pollIntervalMs ?? 1000;
  const settleSeconds = options.settleSeconds ?? 180;

  return defineAdapter({
    name: "runloop",
    displayName: "Runloop",
    config: Configuration,
    credentials: Credentials,
    async connect({ config, credentials, host }) {
      // Unmet minimums reject before any provider IO.
      const size = config.resources ? smallestSize("Runloop", SIZES, config.resources) : undefined;
      const native: RunloopClient = createRunloopClient(credentials.apiKey, options.fetch);
      const secrets = [credentials.apiKey];
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native client throws are normalized at this boundary.
      const failure = (error: unknown) => nativeFailure(error, secrets);

      const read = async <T>(ctx: ReadContext, run: (signal: AbortSignal) => Promise<T>) => {
        try {
          return await run(signalFor(ctx));
        } catch (error) {
          throw failure(error).error;
        }
      };

      return session(config, size, native, failure, read, host.signal);
    },
  });

  async function session(
    config: Configuration,
    size: Size | undefined,
    native: RunloopClient,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native client throws are normalized at this boundary.
    failure: (error: unknown) => ReturnType<typeof nativeFailure>,
    read: <T>(ctx: ReadContext, run: (signal: AbortSignal) => Promise<T>) => Promise<T>,
    hostSignal: AbortSignal,
  ) {
    const account = await read(readContext(hostSignal), (signal) => native.me(signal));
    const accountId = Id.safeParse(account.id);

    if (!accountId.success)
      throw new AdapterError("UNSUPPORTED", "Runloop did not return a stable account id");

    if (account.account_status !== "ACCOUNT_STATUS_ENABLED")
      throw new AdapterError("FORBIDDEN", "The Runloop account is not enabled");

    const scope = {
      authority: { kind: "account", id: accountId.data },
      partition: { endpoint: RUNLOOP_API },
    };

    let blockedPolicy: string | undefined;

    const checkedRef = (ref: SandboxReference) => {
      assertResourceScope(ref, { provider: "runloop", scope });

      if (
        ref.kind !== "sandbox" ||
        ref.generation !== undefined ||
        !Id.safeParse(ref.nativeId).success
      )
        throw new AdapterError("CONFLICT", "Invalid Runloop devbox identity");
    };

    const find = async (id: string, ctx: ReadContext): Promise<Devbox | null> => {
      Id.parse(id);

      try {
        const devbox = await native.getDevbox(id, signalFor(ctx));

        if (devbox.id !== id)
          throw new AdapterError("CONFLICT", "Runloop returned a different devbox identity");

        return devbox;
      } catch (error) {
        if (error instanceof AdapterError) throw error;
        const native = failure(error);

        if (native.status === 404) return null;
        throw native.error;
      }
    };

    const requireDevbox = async (box: Sandbox, ctx: ReadContext) => {
      if (box.reference) checkedRef(box.reference);
      const devbox = await find(box.id, ctx);

      if (!devbox || devbox.status === "shutdown")
        throw new AdapterError(
          "NOT_FOUND",
          "Runloop devbox is unavailable in the verified account",
        );

      return devbox;
    };

    const requireRunning = async (box: Sandbox, ctx: ReadContext) => {
      const devbox = await requireDevbox(box, ctx);

      if (devbox.status !== "running")
        throw new AdapterError(
          "CONFLICT",
          `Runloop devbox is ${devbox.status}; commands and files need a running devbox`,
        );

      return devbox;
    };

    const observation = (devbox: Devbox, ref: SandboxReference | null): SandboxInfo => {
      const launch = devbox.launch_parameters;
      const idle = launch?.lifecycle?.after_idle ?? launch?.after_idle;
      const keepAlive = launch?.keep_alive_time_seconds;
      const live = ["creating", "running"].includes(state(devbox.status));

      return {
        reference: ref,
        state: state(devbox.status),
        nativeState: devbox.status,
        observedAt: new Date().toISOString(),
        expires: idle
          ? { status: "none" }
          : live && keepAlive && devbox.create_time_ms
            ? {
                status: "known",
                at: new Date(devbox.create_time_ms + keepAlive * 1000).toISOString(),
                action: "destroy",
                scope: "sandbox",
              }
            : { status: "unknown", reason: "Runloop reported no active keep-alive deadline" },
        idleStop: {
          status: "known",
          value: idle
            ? {
                seconds: idle.idle_time_seconds,
                action: idle.on_idle === "suspend" ? "suspend" : "stop",
              }
            : null,
        },
        retention: { status: "unknown", reason: "Runloop does not document shutdown retention" },
        execution: { status: "unknown", reason: "Runloop exposes no execution identity" },
        resources: devboxSize(devbox),
      };
    };

    const partialCreate = (
      id: string,
      identity: { operationId: string; submissionId: string },
    ) => ({
      kind: "create" as const,
      status: "partial" as const,
      sandbox: sandboxReference("runloop", scope, id, {
        operation: identity.operationId,
        submission: identity.submissionId,
      }),
      setup: { expiry: "acknowledged" as const, readiness: "unconfirmed" as const },
    });

    /** Poll a read until it settles, the local wait ends, or the caller aborts. */
    const settle = async <T>(
      signal: AbortSignal,
      check: (ctx: ReadContext) => Promise<T | undefined>,
    ): Promise<T | undefined> => {
      const until = Date.now() + settleSeconds * 1000;

      for (;;) {
        const value = await check(readContext(signal));

        if (value !== undefined || Date.now() + pollMs > until) return value;
        await delay(pollMs, signal);
      }
    };

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native client throws are normalized at this boundary.
    const rejection = (ctx: AttemptContext, error: unknown, reason: string) => {
      const native = failure(error);

      return refusedBeforeEffect(native)
        ? ctx.reject(native.error.code, native.error.message)
        : ctx.unknown(`${reason}; do not replay`);
    };

    /** A deny-all policy named for Sandbar, found read-only; null when none exists yet. */
    const findBlockedPolicy = async (ctx: ReadContext): Promise<string | null> => {
      if (blockedPolicy) {
        let current: NetworkPolicy | null = null;

        try {
          current = await read(ctx, (signal) =>
            native.getNetworkPolicy(blockedPolicy ?? "", signal),
          );
        } catch (error) {
          // A deleted policy is looked up again by name; other failures stop the create.
          if (!(error instanceof AdapterError && error.code === "NOT_FOUND")) throw error;
        }

        if (current?.id === blockedPolicy && isDenyAll(current)) return blockedPolicy;
        blockedPolicy = undefined;
      }

      const page = await read(ctx, (signal) =>
        native.listNetworkPolicies({ name: BLOCKED_POLICY_NAME, limit: 100 }, signal),
      );

      const match = page.items.find(
        (policy) => policy.name === BLOCKED_POLICY_NAME && isDenyAll(policy),
      );

      blockedPolicy = match?.id;

      return match?.id ?? null;
    };

    const resolveImage = async (value: string, ctx: ReadContext): Promise<ImagePlan> => {
      if (value === BASE_IMAGE) return {};

      if (Id.safeParse(value).success)
        try {
          const blueprint = await native.getBlueprint(value, signalFor(ctx));

          if (blueprint.id === value) return { blueprint_id: value };
        } catch (error) {
          const native = failure(error);

          // A name is not an id; Runloop resolves names to their latest successful build.
          if (native.status !== 404 && native.status !== 400) throw native.error;
        }

      return { blueprint_name: value };
    };

    const prepareCreate = async (
      input: CreateInput,
      image: ImagePlan | undefined,
      ctx: ReadContext,
    ): Promise<PreparedCreate> => {
      if (input.image.kind !== "prepared")
        throw new AdapterError(
          "UNSUPPORTED",
          "Runloop starts from a blueprint or the default Devbox image; OCI images are unavailable",
        );

      if (input.networkPolicy !== "blocked" && input.networkPolicy !== "internet")
        throw new AdapterError(
          "UNSUPPORTED",
          'Runloop network policy must be "blocked" or "internet"',
        );

      if (
        input.region !== undefined ||
        (input.labels && Object.keys(input.labels).length) ||
        input.mounts?.length
      )
        throw new AdapterError(
          "UNSUPPORTED",
          "Runloop has no region selection, labels or volume mounts",
        );

      if (input.requirements) {
        const plan = resolveSnapshot(snapshotSupport, input.requirements.snapshot, "running");

        if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);
      }

      return {
        ...input,
        plan: {
          image: image ?? (await resolveImage(input.image.value, ctx)),
          policy: input.networkPolicy === "blocked" ? await findBlockedPolicy(ctx) : null,
        },
      };
    };

    /** Find or create the deny-all policy. The policy is a shared account resource. */
    const ensureBlockedPolicy = async (
      known: string | null,
      ctx: AttemptContext,
    ): Promise<{ policy: string } | { refused: ReturnType<AttemptContext["reject"]> }> => {
      if (known) return { policy: known };

      try {
        const created = await native.createNetworkPolicy(
          {
            name: BLOCKED_POLICY_NAME,
            description: "Deny-all egress for Sandbar sandboxes created with network: blocked",
            allow_all: false,
            allowed_hostnames: [],
            allowed_cidrs: [],
            allow_devbox_to_devbox: false,
            allow_agent_gateway: false,
            allow_mcp_gateway: false,
            allow_runloop_mirrors: false,
          },
          signalFor(readContext(ctx.signal)),
        );

        if (isDenyAll(created)) {
          blockedPolicy = created.id;

          return { policy: created.id };
        }
      } catch (error) {
        const native = failure(error);

        if (refusedBeforeEffect(native))
          return { refused: ctx.reject(native.error.code, native.error.message) };
      }

      // A lost or unexpected policy response is resolved by reading, never by resending.
      const found = await findBlockedPolicy(readContext(ctx.signal)).catch(() => null);

      return found
        ? { policy: found }
        : {
            refused: ctx.reject(
              "UNAVAILABLE",
              "Runloop did not confirm the deny-all network policy; no devbox was created",
            ),
          };
    };

    const created = async (
      id: string,
      creation: { operation: string; submission: string },
      policy: string | null,
      ctx: ReadContext,
    ) => {
      const devbox = await find(id, ctx);

      if (!devbox || devbox.status !== "running") return { devbox };

      if ((devbox.launch_parameters?.network_policy_id ?? null) !== policy)
        return { devbox, mismatch: true as const };

      return {
        devbox,
        value: {
          id,
          reference: sandboxReference("runloop", scope, id, creation),
          state: "running" as const,
        },
      };
    };

    const stopped = new Set(["failure", "shutdown"]);

    const finishCreate = async (
      id: string,
      ctx: { operationId: string; submissionId: string; signal: AbortSignal },
      policy: string | null,
      pending: (token: z.infer<typeof CreateToken>) => ReturnType<AttemptContext["pending"]>,
      unknown: AttemptContext["unknown"],
    ) => {
      const creation = { operation: ctx.operationId, submission: ctx.submissionId };

      try {
        const result = await settle(ctx.signal, async (read) => {
          const current = await created(id, creation, policy, read);

          return current.value ||
            current.mismatch ||
            !current.devbox ||
            stopped.has(current.devbox.status)
            ? current
            : undefined;
        });

        if (result?.value) return result.value;

        if (result?.mismatch)
          return unknown(
            "Runloop started the devbox without the requested network policy; destroy it",
            partialCreate(id, ctx),
          );

        if (result && (!result.devbox || stopped.has(result.devbox.status)))
          return unknown(
            `Runloop devbox ${result.devbox ? `entered ${result.devbox.status}` : "disappeared"} before it was running; inspect without replay`,
            partialCreate(id, ctx),
          );
      } catch {
        /* A failed readiness read is not evidence; continue through observation. */
      }

      return pending({ id, policy });
    };

    /**
     * The policy a create requested, read back from its egress marker when the token was lost:
     * null for internet, the attached policy id when it is deny-all, or undefined when neither holds.
     */
    const requestedPolicy = async (devbox: Devbox, ctx: ReadContext) => {
      const marker = devbox.metadata?.[MARK.network];
      const attached = devbox.launch_parameters?.network_policy_id ?? null;

      if (marker === "internet") return null;

      if (marker !== "blocked" || attached === null) return undefined;
      const policy = await read(ctx, (signal) => native.getNetworkPolicy(attached, signal));

      return isDenyAll(policy) ? attached : undefined;
    };

    /** Read-only search for a devbox whose metadata names this create attempt. */
    const findBySubmission = async (submission: string, ctx: ReadContext) => {
      let cursor: string | undefined;

      for (let pages = 0; pages < 5; pages++) {
        const page = await read(ctx, (signal) =>
          native.listDevboxes({ limit: 100, starting_after: cursor }, signal),
        );

        const match = page.items.find(
          (devbox) => devbox.metadata?.[MARK.submission] === submission,
        );

        if (match) return match;

        if (!page.hasMore || !page.items.length) return null;
        cursor = page.items.at(-1)?.id;
      }

      return null;
    };

    const makeCreation = (snapshotId?: string) => ({
      recovery: { version: 1, token: CreateToken },
      async submit(input: PreparedCreate, ctx: AttemptContext<z.infer<typeof CreateToken>>) {
        let policy: string | null = null;

        if (input.networkPolicy === "blocked") {
          const ensured = await ensureBlockedPolicy(input.plan.policy, ctx);

          if ("refused" in ensured) return ensured.refused;
          policy = ensured.policy;
        }

        const body: CreateDevboxBody = {
          ...(snapshotId === undefined ? input.plan.image : { snapshot_id: snapshotId }),
          metadata: {
            [MARK.operation]: ctx.operationId,
            [MARK.submission]: ctx.submissionId,
            [MARK.network]: input.networkPolicy,
          },
          launch_parameters: launchParameters(config, size, policy, input.lifetimeSeconds),
          tunnel: { auth_mode: config.preview.access === "public" ? "open" : "authenticated" },
        };

        if (input.env && Object.keys(input.env).length) body.environment_variables = input.env;

        let id: string;

        try {
          id = (await native.createDevbox(body, signalFor(readContext(ctx.signal)))).id;
        } catch (error) {
          if (error instanceof AdapterError && error.code === "INTERNAL")
            return ctx.unknown("Runloop create acknowledgement has no usable devbox id");

          return rejection(ctx, error, "Runloop create response was not confirmed");
        }

        try {
          await ctx.checkpoint({ id, policy });
        } catch (error) {
          if (error instanceof AdapterCheckpointError) error.outcome = partialCreate(id, ctx);
          throw error;
        }

        return finishCreate(
          id,
          ctx,
          policy,
          (token) => ctx.pending(token, { pollAfterMs: pollMs }),
          ctx.unknown,
        );
      },
      async observe(
        attempt: { operationId: string; submissionId: string; token?: Json },
        ctx: ObserveContext<z.infer<typeof CreateToken>>,
      ) {
        const token = CreateToken.safeParse(attempt.token);

        const id = token.success
          ? token.data.id
          : (await findBySubmission(attempt.submissionId, ctx))?.id;

        if (!id)
          return ctx.unknown(
            "Runloop create response was lost and no devbox carries this attempt; inspect inventory without replay",
          );

        const devbox = await find(id, ctx);
        const creation = { operation: attempt.operationId, submission: attempt.submissionId };

        if (devbox && devbox.metadata?.[MARK.submission] !== attempt.submissionId)
          return ctx.unknown("Runloop devbox does not carry this create attempt; do not replay");

        const policy = token.success
          ? token.data.policy
          : devbox
            ? await requestedPolicy(devbox, ctx)
            : null;

        if (policy === undefined)
          return ctx.unknown(
            "Runloop devbox does not show the requested network policy; destroy it or inspect without replay",
            partialCreate(id, attempt),
          );

        const current = await created(id, creation, policy, ctx);

        if (current.value) return current.value;

        if (current.mismatch)
          return ctx.unknown(
            "Runloop started the devbox without the requested network policy; destroy it",
            partialCreate(id, attempt),
          );

        if (!current.devbox || stopped.has(current.devbox.status))
          return ctx.unknown(
            `Runloop devbox ${current.devbox ? current.devbox.status : "is gone"}; inspect without replay`,
            partialCreate(id, attempt),
          );

        return ctx.pending({ id, policy }, { pollAfterMs: pollMs });
      },
    });

    const snapshotReference = (
      id: string,
      ownership: ResourceReference["ownership"] = "unknown",
    ): ResourceReference & { kind: "snapshot" } => ({
      version: 1,
      kind: "snapshot",
      provider: "runloop",
      scope,
      nativeId: id,
      ownership,
    });

    const checkSnapshot = (ref: ResourceReference) => {
      assertResourceScope(ref, { provider: "runloop", scope });

      if (
        ref.kind !== "snapshot" ||
        ref.generation !== undefined ||
        !Id.safeParse(ref.nativeId).success
      )
        throw new AdapterError("CONFLICT", "Invalid Runloop snapshot identity");
    };

    const restore = {
      networkPolicies: ["blocked", "internet"],
      resources: false,
      mounts: false,
      independentLifecycle: true,
    };

    const snapshotInfo = (
      snapshot: Snapshot,
      ready: boolean,
      ownership: ResourceReference["ownership"] = "unknown",
    ): SnapshotInfo => ({
      reference: snapshotReference(snapshot.id, ownership),
      preserve: "filesystem",
      restoreExecution: "fresh",
      consistency: "unknown",
      source: { id: snapshot.source_devbox_id, class: "runloop-devbox" },
      state: ready ? "ready" : "creating",
      createdAt: snapshot.create_time_ms ? new Date(snapshot.create_time_ms).toISOString() : null,
      expiration: "unknown",
      excludedPaths: null,
      mounts: [],
      mountHandling: ownership === "verified-created" ? "none" : "unknown",
      restore,
      dependencies: [],
      nativeDependencies: null,
    });

    /** Snapshot status, or null once Runloop no longer has it. */
    const snapshotStatus = async (id: string, ctx: ReadContext) => {
      try {
        const status = await native.snapshotStatus(id, signalFor(ctx));

        return status.status === "deleted" ? null : status;
      } catch (error) {
        const native = failure(error);

        if (native.status === 404) return null;
        throw native.error;
      }
    };

    const captured = async (token: z.infer<typeof CaptureToken>, ctx: ReadContext) => {
      const status = await snapshotStatus(token.snapshot, ctx);

      if (status?.snapshot && status.snapshot.source_devbox_id !== token.source)
        throw new AdapterError("CONFLICT", "Runloop snapshot belongs to another devbox");

      return status;
    };

    const captureValue = (snapshot: Snapshot) => ({
      snapshot: snapshotInfo(snapshot, true, "verified-created"),
      capture: {
        preserve: "filesystem" as const,
        interruption: profile.interruption,
        restoreExecution: "fresh" as const,
      },
      source: { state: "running" as const, connections: profile.connections },
      retainedResources: [snapshotReference(snapshot.id, "verified-created")],
    });

    const captureOutcome = (token: z.infer<typeof CaptureToken>) => ({
      kind: "snapshot_capture" as const,
      status: "unknown" as const,
      snapshot: snapshotReference(token.snapshot, "verified-created"),
    });

    const lifecycleObservation = (
      box: Sandbox,
      devbox: Devbox,
    ): SandboxInfo & { reference: SandboxReference } => {
      if (!box.reference)
        throw new AdapterError("CONFLICT", "Runloop lifecycle change needs a reference");

      return { ...observation(devbox, box.reference), reference: box.reference };
    };

    const suspended = (box: Sandbox & { reference: SandboxReference }, devbox: Devbox) => ({
      reference: box.reference,
      preserve: "filesystem" as const,
      processes: "terminated" as const,
      connections: "dropped" as const,
      observation: lifecycleObservation(box, devbox),
    });

    const resumed = (box: Sandbox & { reference: SandboxReference }, devbox: Devbox) => ({
      reference: box.reference,
      execution: "fresh" as const,
      executionIdentity: {
        status: "unknown" as const,
        reason: "Runloop exposes no execution identity",
      },
      connections: "dropped" as const,
      observation: lifecycleObservation(box, devbox),
    });

    /** Run one command once and collect its result, or explain why the outcome is unknown. */
    const runCommand = async (
      input: ExecInput,
      ctx: AttemptContext,
    ): Promise<
      WrapperResult | ReturnType<AttemptContext["unknown"]> | ReturnType<AttemptContext["reject"]>
    > => {
      const id = input.sandbox.id;
      let stdinPath: string | undefined;

      if (input.stdin !== undefined) {
        stdinPath = `/tmp/sandbar-stdin-${crypto.randomUUID()}`;

        try {
          await native.uploadFile(
            id,
            stdinPath,
            input.stdin,
            signalFor(readContext(ctx.signal, 120)),
          );
        } catch (error) {
          return rejection(
            ctx,
            error,
            "Runloop stdin upload was not confirmed; the command did not run",
          );
        }
      }

      const until = Date.now() + input.deadlineSeconds * 1000;
      let execution: Execution;

      try {
        execution = await native.execute(
          id,
          {
            command: wrapperScript({ ...input, stdinPath, maxBytes: input.maxOutputBytes }),
            command_id: uuidv7(),
            optimistic_timeout: Math.max(1, Math.min(25, input.deadlineSeconds)),
          },
          signalFor(readContext(ctx.signal, 60)),
        );
      } catch (error) {
        return rejection(ctx, error, "Runloop command response was not confirmed");
      }

      while (execution.status !== "completed") {
        const remaining = until - Date.now();

        if (remaining <= 0) {
          const killed = await native
            .killExecution(id, execution.execution_id, signalFor(readContext(ctx.signal, 10)))
            .then(
              (ended) =>
                ended.execution_id === execution.execution_id && ended.status === "completed",
            )
            .catch(() => false);

          return ctx.unknown(
            killed
              ? `Runloop command passed its ${input.deadlineSeconds}s deadline and was killed; output is unavailable`
              : `Runloop command passed its ${input.deadlineSeconds}s deadline and Runloop did not confirm killing it; it may still be running`,
          );
        }

        try {
          const next = await native.waitForCommand(
            id,
            execution.execution_id,
            Math.max(1, Math.min(25, Math.ceil(remaining / 1000))),
            signalFor(readContext(ctx.signal, 60)),
          );

          if (next.execution_id !== execution.execution_id)
            return ctx.unknown("Runloop returned a different execution; do not replay");
          execution = next;
        } catch (error) {
          // 408 ends one long-poll window while the command keeps running.
          if (failure(error).status !== 408)
            return ctx.unknown("Runloop command is running but its result could not be read");
        }
      }

      const record = execution.stdout_truncated ? null : parseWrapper(execution.stdout ?? "");

      if (!record)
        return ctx.unknown("Runloop ran the command but its result record could not be decoded");

      if ("stdout" in record) return record;

      const signal = signalFor(readContext(ctx.signal, 120));

      // The exit code is already confirmed; a stream that cannot be downloaded is reported as
      // truncated, never by discarding the result.
      const download = (stream: "stdout" | "stderr") =>
        native
          .downloadFile(id, `${record.directory}/${stream}`, input.maxOutputBytes, signal)
          .catch(() => null);

      const stdout = await download("stdout");
      const stderr = await download("stderr");

      if (!stdout || !stderr)
        // The directory is left in /tmp so its output can still be read from the guest.
        return {
          exitCode: record.exitCode,
          stdout: stdout ?? new Uint8Array(),
          stderr: stderr ?? new Uint8Array(),
          truncated: true,
        };

      // Best effort: the directory holds only this command's bounded output under /tmp.
      await native
        .execute(
          id,
          {
            command: `rm -rf -- ${quote(record.directory)}`,
            command_id: uuidv7(),
            optimistic_timeout: 5,
          },
          signalFor(readContext(ctx.signal, 15)),
        )
        .catch(() => undefined);

      return (
        filesResult(record, stdout, stderr, input.maxOutputBytes) ??
        ctx.unknown("Runloop command output does not match its recorded length")
      );
    };

    // A restore boots fresh from the disk snapshot, so env applies as on create.
    const restoreOptions: RestoreOptions = { env: true };

    const result: AdapterSession<
      PreparedCreate,
      PreparedDestroy,
      ExecInput,
      FileWriteInput,
      "argv" | "shell",
      z.infer<typeof CreateToken>
    > = {
      scope,
      defaultImage: { kind: "prepared", value: config.image },
      defaultNetworkPolicy: config.network,
      supports: {
        images: ["prepared"],
        network: ["blocked", "internet"],
        exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
        fileWrite: { overwrite: true, noClobber: false },
        createEnv: true,
      },
      create: {
        ...makeCreation(),
        prepare: (input, ctx) => prepareCreate(input, undefined, ctx),
      },
      async inspect(box, ctx) {
        if (box.reference) checkedRef(box.reference);
        const devbox = await find(box.id, ctx);

        return devbox ? { id: devbox.id, ...observation(devbox, box.reference ?? null) } : null;
      },
      async reopen(ref, ctx) {
        checkedRef(ref);

        return observation(await requireDevbox({ id: ref.nativeId, reference: ref }, ctx), ref);
      },
      async inventory(input, ctx) {
        const page = await read(ctx, (signal) =>
          native.listDevboxes(
            { limit: Math.min(100, input.limit), starting_after: input.cursor },
            signal,
          ),
        );

        return {
          items: page.items.map((devbox) => ({
            id: devbox.id,
            state:
              devbox.status === "shutdown"
                ? ("destroyed" as const)
                : devbox.status === "running"
                  ? ("running" as const)
                  : ("unknown" as const),
          })),
          nextCursor: page.hasMore ? page.items.at(-1)?.id : undefined,
        };
      },
      async sandboxList(input, ctx) {
        const page = await read(ctx, (signal) =>
          native.listDevboxes({ limit: input.limit, starting_after: input.cursor }, signal),
        );

        return {
          // Runloop lists every devbox in the verified account. Metadata markers are not
          // proof of ownership, so listed references claim none.
          coverage: "provider-scope" as const,
          items: page.items.map((devbox) => ({
            id: devbox.id,
            state: state(devbox.status),
            reference: {
              version: 1 as const,
              kind: "sandbox" as const,
              provider: "runloop",
              scope,
              nativeId: devbox.id,
              ownership: "unknown" as const,
            },
          })),
          nextCursor: page.hasMore ? page.items.at(-1)?.id : undefined,
        };
      },
      destroy: {
        recovery: { version: 1, token: DestroyToken },
        async prepare(input, ctx) {
          if (input.reference) checkedRef(input.reference);
          const devbox = await find(input.id, ctx);

          if (!devbox)
            throw new AdapterError(
              "NOT_FOUND",
              "Runloop devbox is unavailable in the verified account",
            );

          return { ...input, alreadyShutdown: devbox.status === "shutdown" };
        },
        async submit(input, ctx) {
          if (input.alreadyShutdown) return { computeStopped: true, retainedResources: [] };
          const token = { id: Id.parse(input.id) };
          await ctx.checkpoint(token);

          try {
            const devbox = await native.shutdown(token.id, signalFor(readContext(ctx.signal)));

            if (devbox.id === token.id && devbox.status === "shutdown")
              return { computeStopped: true, retainedResources: [] };
          } catch (error) {
            const native = failure(error);

            if (refusedBeforeEffect(native))
              return ctx.reject(native.error.code, native.error.message);

            return ctx.pending(token, { pollAfterMs: pollMs });
          }

          try {
            const done = await settle(ctx.signal, async (read) =>
              (await find(token.id, read))?.status === "shutdown" ? true : undefined,
            );

            if (done) return { computeStopped: true, retainedResources: [] };
          } catch {
            /* Shutdown is acknowledged; completion continues through observation. */
          }

          return ctx.pending(token, { pollAfterMs: pollMs });
        },
        async observe(attempt, ctx) {
          const token = DestroyToken.safeParse(attempt.token);

          if (!token.success || token.data.id !== attempt.sandbox?.id)
            return ctx.unknown("Runloop shutdown identity is unavailable; do not replay");
          const devbox = await find(token.data.id, ctx);

          if (devbox?.status === "shutdown") return { computeStopped: true, retainedResources: [] };

          if (!devbox || devbox.status === "failure")
            return ctx.unknown(
              `Runloop devbox ${devbox ? "failed" : "disappeared"} during shutdown; teardown is unconfirmed`,
            );

          return ctx.pending(token.data, { pollAfterMs: pollMs });
        },
      },
      processes: {
        supports: { sustainedOutput: true },
        async start(input, ctx) {
          await requireRunning(input.sandbox, ctx);

          return startRunloopProcess(
            {
              native,
              commandId: () => uuidv7(),
              bounded: (signal, seconds) => signalFor(readContext(signal, seconds)),
            },
            input,
            ctx,
          );
        },
      },
      exec: {
        finiteStdin: "bytes",
        async prepare(input, ctx) {
          if (input.deadlineSeconds > MAX_EXEC_SECONDS)
            throw new AdapterError(
              "INVALID_ARGUMENT",
              `Runloop commands run for at most ${MAX_EXEC_SECONDS} seconds`,
            );
          // Validates argv, env names and NUL bytes before any effect.
          wrapperScript({ ...input, maxBytes: input.maxOutputBytes });
          await requireRunning(input.sandbox, ctx);

          return input;
        },
        submit: (input, ctx) => runCommand(input, ctx),
      },
      files: {
        maxBytes: MAX_FILE_BYTES,
        async read(input, ctx) {
          await requireRunning(input.sandbox, ctx);

          return read(ctx, (signal) =>
            native.downloadFile(
              input.sandbox.id,
              input.path,
              Math.min(input.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES),
              signal,
            ),
          );
        },
        write: {
          async prepare(input, ctx) {
            if (!input.overwrite)
              throw new AdapterError(
                "UNSUPPORTED",
                "Runloop file uploads always replace the target; no-clobber creation is unavailable",
              );

            if (input.bytes.byteLength > MAX_FILE_BYTES)
              throw new AdapterError("CAPACITY", "Runloop file exceeds the write bound");
            await requireRunning(input.sandbox, ctx);

            return input;
          },
          async submit(input, ctx) {
            try {
              await native.uploadFile(
                input.sandbox.id,
                input.path,
                input.bytes,
                signalFor(readContext(ctx.signal, 120)),
              );

              return { bytesWritten: input.bytes.byteLength };
            } catch (error) {
              return rejection(ctx, error, "Runloop file upload was not confirmed");
            }
          },
        },
      },
      async preview(input, ctx) {
        const devbox = await requireRunning(input.sandbox, ctx);
        const tunnel = devbox.tunnel;

        if (!tunnel || !/^[A-Za-z0-9-]{1,256}$/.test(tunnel.tunnel_key))
          throw new AdapterError(
            "UNAVAILABLE",
            "This Runloop devbox has no tunnel; Sandbar enables one only on devboxes it creates",
          );
        const url = `https://${input.port}-${tunnel.tunnel_key}.${TUNNEL_DOMAIN}`;

        if (tunnel.auth_mode === "open") return { access: "public", url };

        if (!tunnel.auth_token || !/^[^\r\n]{1,4096}$/.test(tunnel.auth_token))
          throw new AdapterError("UNAVAILABLE", "Runloop did not return the tunnel token");

        return {
          access: "protected",
          url,
          headers: { "X-Runloop-Tunnel-Authorization": `Bearer ${tunnel.auth_token}` },
        };
      },
      async suspensionCapabilities() {
        return {
          status: "supported",
          value: { preserve: "filesystem", processes: "terminated", connections: "dropped" },
        };
      },
      async resumeCapabilities() {
        return {
          status: "supported",
          value: { sourceStates: ["suspended"], setsSessionTimeout: false },
        };
      },
      suspend: {
        recovery: { version: 1, token: LifecycleToken },
        async prepare(input, ctx) {
          const devbox = await requireDevbox(input.sandbox, ctx);

          if (devbox.status !== "running")
            throw new AdapterError(
              "CONFLICT",
              `Runloop can suspend only a running devbox, not ${devbox.status}`,
            );

          return { ...input, intent: { action: "suspend", preserve: "filesystem" } };
        },
        async submit(input, ctx) {
          const token = { id: Id.parse(input.sandbox.id) };
          await ctx.checkpoint(token);

          try {
            await native.suspend(token.id, signalFor(readContext(ctx.signal)));
          } catch (error) {
            return rejection(ctx, error, "Runloop suspend response was not confirmed");
          }

          try {
            const devbox = await settle(ctx.signal, async (read) => {
              const devbox = await find(token.id, read);

              return devbox?.status === "suspended" ? devbox : undefined;
            });

            if (devbox) return suspended(input.sandbox, devbox);
          } catch {
            /* Suspend is acknowledged; it continues through observation. */
          }

          return ctx.pending(token, { pollAfterMs: pollMs });
        },
        async observe(attempt, ctx) {
          const token = LifecycleToken.safeParse(attempt.token);
          const box = attempt.sandbox;

          if (!token.success || !box?.reference || token.data.id !== box.id)
            return ctx.unknown("Runloop suspend identity is unavailable; do not replay");
          const devbox = await find(token.data.id, ctx);

          if (!devbox) return ctx.unknown("Runloop devbox disappeared while suspending");

          if (devbox.status === "suspended")
            return suspended({ ...box, reference: box.reference }, devbox);

          return ["running", "suspending"].includes(devbox.status)
            ? ctx.pending(token.data, { pollAfterMs: pollMs })
            : ctx.unknown(
                `Runloop devbox is ${devbox.status} after suspend; inspect without replay`,
              );
        },
      },
      resume: {
        recovery: { version: 1, token: LifecycleToken },
        async prepare(input, ctx) {
          const devbox = await requireDevbox(input.sandbox, ctx);

          if (devbox.status !== "suspended")
            throw new AdapterError(
              "CONFLICT",
              `Runloop can resume only a suspended devbox, not ${devbox.status}`,
            );

          return { ...input, intent: { action: "resume" } };
        },
        async submit(input, ctx) {
          const token = { id: Id.parse(input.sandbox.id) };
          await ctx.checkpoint(token);

          try {
            await native.resume(token.id, signalFor(readContext(ctx.signal)));
          } catch (error) {
            return rejection(ctx, error, "Runloop resume response was not confirmed");
          }

          try {
            const devbox = await settle(ctx.signal, async (read) => {
              const devbox = await find(token.id, read);

              return devbox?.status === "running" ? devbox : undefined;
            });

            if (devbox) return resumed(input.sandbox, devbox);
          } catch {
            /* Resume is acknowledged; readiness continues through observation. */
          }

          return ctx.pending(token, { pollAfterMs: pollMs });
        },
        async observe(attempt, ctx) {
          const token = LifecycleToken.safeParse(attempt.token);
          const box = attempt.sandbox;

          if (!token.success || !box?.reference || token.data.id !== box.id)
            return ctx.unknown("Runloop resume identity is unavailable; do not replay");
          const devbox = await find(token.data.id, ctx);

          if (!devbox) return ctx.unknown("Runloop devbox disappeared while resuming");

          if (devbox.status === "running")
            return resumed({ ...box, reference: box.reference }, devbox);

          return ["suspended", "resuming"].includes(devbox.status)
            ? ctx.pending(token.data, { pollAfterMs: pollMs })
            : ctx.unknown(
                `Runloop devbox is ${devbox.status} after resume; inspect without replay`,
              );
        },
      },
      snapshotProfiles: async () => snapshotSupport,
      resourceCapabilities: async () => ({
        restore: { status: "supported" as const, value: restore },
        volumes: {
          status: "unsupported" as const,
          reason: "Runloop storage objects are not exposed as Sandbar volumes yet",
        },
        mounts: {
          status: "unsupported" as const,
          reason: "Runloop object mounts are not exposed as Sandbar mounts yet",
        },
      }),
      snapshotCapture: {
        recovery: { version: 1, token: CaptureToken },
        async prepare(input, ctx) {
          if (input.sandbox.reference) checkedRef(input.sandbox.reference);
          const devbox = await requireDevbox(input.sandbox, ctx);
          const plan = resolveSnapshot(snapshotSupport, input.request, state(devbox.status));

          if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

          if (input.request.retention?.cleanupAfterSeconds !== undefined)
            throw new AdapterError("UNSUPPORTED", "Runloop has no scheduled snapshot deletion");

          return input;
        },
        async submit(input, ctx) {
          let snapshot: Snapshot;

          try {
            snapshot = await native.snapshotDiskAsync(
              input.sandbox.id,
              { [MARK.operation]: ctx.operationId, [MARK.submission]: ctx.submissionId },
              signalFor(readContext(ctx.signal)),
            );
          } catch (error) {
            return rejection(ctx, error, "Runloop snapshot response was not confirmed");
          }

          const token = { snapshot: snapshot.id, source: Id.parse(input.sandbox.id) };

          if (snapshot.source_devbox_id !== token.source)
            return ctx.unknown(
              "Runloop snapshot names another source devbox; do not replay",
              captureOutcome(token),
            );
          await ctx.checkpoint(token);

          return finishCapture(
            token,
            ctx.signal,
            (value) => ctx.pending(value, { pollAfterMs: pollMs }),
            ctx.unknown,
          );
        },
        async observe(attempt, ctx) {
          const box = attempt.sandbox;

          if (!box) return ctx.unknown("Runloop capture source is unavailable; do not replay");
          let token = CaptureToken.safeParse(attempt.token).data;

          if (!token) {
            const page = await read(ctx, (signal) =>
              native.listSnapshots(
                {
                  devbox_id: box.id,
                  [`metadata[${MARK.submission}]`]: attempt.submissionId,
                  limit: 10,
                },
                signal,
              ),
            );

            const match = page.items.find(
              (snapshot) =>
                snapshot.metadata?.[MARK.submission] === attempt.submissionId &&
                snapshot.source_devbox_id === box.id,
            );

            if (!match)
              return ctx.unknown(
                "Runloop snapshot response was lost and no snapshot carries this attempt; list snapshots without replay",
              );
            token = { snapshot: match.id, source: box.id };
          }

          if (token.source !== box.id)
            return ctx.unknown("Runloop capture source identity differs");
          const status = await captured(token, ctx);

          if (status?.status === "complete" && status.snapshot)
            return captureValue(status.snapshot);

          if (status?.status === "in_progress") return ctx.pending(token, { pollAfterMs: pollMs });

          return ctx.unknown(
            status
              ? `Runloop snapshot failed: ${status.error_message ?? "no reason given"}`
              : "Runloop snapshot disappeared",
            captureOutcome(token),
          );
        },
      },
      snapshotRestore: {
        recovery: { version: 1, token: CreateToken },
        options: restoreOptions,
        async prepare(input, ctx) {
          checkSnapshot(input.snapshot);

          if (input.request.resources || input.request.mounts?.length)
            throw new AdapterError(
              "UNSUPPORTED",
              "Runloop restores keep the configured size and take no mounts",
            );

          if (!restore.networkPolicies.includes(input.request.networkPolicy))
            throw new AdapterError(
              "UNSUPPORTED",
              'Runloop network policy must be "blocked" or "internet"',
            );
          const status = await snapshotStatus(input.snapshot.nativeId, ctx);

          if (!status) throw new AdapterError("NOT_FOUND", "Runloop snapshot is unavailable");

          if (status.status !== "complete")
            throw new AdapterError("CONFLICT", `Runloop snapshot is ${status.status}`);

          return input;
        },
        async submit(input, ctx) {
          const prepared = await prepareCreate(
            {
              image: { kind: "prepared", value: config.image },
              networkPolicy: input.request.networkPolicy,
              env: input.request.env,
              lifetimeSeconds: input.request.lifetimeSeconds,
            },
            { snapshot_id: input.snapshot.nativeId },
            readContext(ctx.signal),
          );

          return makeCreation(input.snapshot.nativeId).submit(prepared, ctx);
        },
        async observe(attempt, ctx) {
          if (attempt.resource) checkSnapshot(attempt.resource);

          return makeCreation(attempt.resource?.nativeId).observe(attempt, ctx);
        },
      },
      snapshotDelete: {
        recovery: { version: 1, token: DeleteToken },
        async prepare(ref, ctx) {
          checkSnapshot(ref);

          if (!(await snapshotStatus(ref.nativeId, ctx)))
            throw new AdapterError("NOT_FOUND", "Runloop snapshot is unavailable");

          return ref;
        },
        async submit(ref, ctx) {
          const token = { snapshot: Id.parse(ref.nativeId) };
          await ctx.checkpoint(token);

          try {
            await native.deleteSnapshot(token.snapshot, signalFor(readContext(ctx.signal)));
          } catch (error) {
            return rejection(ctx, error, "Runloop snapshot deletion was not confirmed");
          }

          try {
            if (!(await snapshotStatus(token.snapshot, readContext(ctx.signal))))
              return { deleted: true as const, reference: ref };
          } catch {
            /* Deletion is acknowledged; confirmation continues through observation. */
          }

          return ctx.pending(token, { pollAfterMs: pollMs });
        },
        async observe(attempt, ctx) {
          const token = DeleteToken.safeParse(attempt.token);

          if (!token.success || !attempt.resource)
            return ctx.unknown("Runloop snapshot deletion identity is unavailable; do not replay");
          checkSnapshot(attempt.resource);
          assertResourceIdentity(
            snapshotReference(token.data.snapshot, attempt.resource.ownership),
            attempt.resource,
          );

          return (await snapshotStatus(token.data.snapshot, ctx))
            ? ctx.pending(token.data, { pollAfterMs: pollMs })
            : { deleted: true as const, reference: attempt.resource };
        },
      },
      async snapshotInspect(ref, ctx) {
        checkSnapshot(ref);
        const status = await snapshotStatus(ref.nativeId, ctx);

        if (!status?.snapshot) {
          if (status?.status === "in_progress")
            throw new AdapterError("CONFLICT", "Runloop snapshot is still being captured");
          throw new AdapterError("NOT_FOUND", "Runloop snapshot is unavailable");
        }

        if (status.snapshot.id !== ref.nativeId)
          throw new AdapterError("CONFLICT", "Runloop returned a different snapshot identity");

        return snapshotInfo(status.snapshot, status.status === "complete", ref.ownership);
      },
      snapshotListCoverage: "provider-scope",
      async snapshotList(input, ctx) {
        const page = await read(ctx, (signal) =>
          native.listSnapshots({ limit: input.limit, starting_after: input.cursor }, signal),
        );

        return {
          items: page.items.map((snapshot) => snapshotInfo(snapshot, true)),
          nextCursor: page.hasMore ? page.items.at(-1)?.id : undefined,
          coverage: "provider-scope" as const,
        };
      },
    };

    // An idle window replaces the lifetime natively, so a per-create lifetime needs none set.
    if (config.lifecycle.idleSeconds === undefined) {
      result.supports.lifetime = { minSeconds: 60, maxSeconds: MAX_LIFETIME_SECONDS };
      restoreOptions.lifetime = result.supports.lifetime;
    }

    async function finishCapture(
      token: z.infer<typeof CaptureToken>,
      signal: AbortSignal,
      pending: (token: z.infer<typeof CaptureToken>) => ReturnType<AttemptContext["pending"]>,
      unknown: AttemptContext["unknown"],
    ) {
      try {
        const status = await settle(signal, async (read) => {
          const status = await captured(token, read);

          return status?.status === "in_progress" ? undefined : (status ?? null);
        });

        if (status?.status === "complete" && status.snapshot) return captureValue(status.snapshot);

        if (status !== undefined)
          return unknown(
            status
              ? `Runloop snapshot failed: ${status.error_message ?? "no reason given"}; delete it if it remains`
              : "Runloop snapshot disappeared before it completed",
            captureOutcome(token),
          );
      } catch {
        /* Capture is acknowledged; completion continues through observation. */
      }

      return pending(token);
    }

    return result;
  }
}

export const runloopAdapter = createRunloopAdapter();
