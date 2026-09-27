import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ExecCommand, canonicalJson, intentSha256 } from "@sandbar/contracts";
import {
  DriverResult,
  NativeRef,
  NativeScope,
  type InvocationIdentity,
} from "@sandbar/provider-spi";

const CommandFixture = z.strictObject({
  command: ExecCommand,
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  deadlineSeconds: z.number().int().min(1).max(3600).optional(),
  exitCode: z.number().int(),
  stdoutBase64: z.base64().default(""),
  stderrBase64: z.base64().default(""),
});
export const FakeScenario = z.strictObject({
  submissionId: z.string().min(1),
  action: z.enum(["create", "exec", "destroy", "file_write"]),
  behavior: z
    .enum(["normal", "lost_after_effect", "reject", "ambiguous_before_effect"])
    .default("normal"),
  delayObservations: z.number().int().min(0).max(100).default(0),
  rejectCode: z.enum(["capacity", "unsupported", "conflict"]).default("capacity"),
  command: CommandFixture.optional(),
});
export type FakeScenario = z.infer<typeof FakeScenario>;
export const FakeProfile = z.strictObject({
  nativeIdempotency: z.strictObject({
    create: z.boolean(),
    exec: z.boolean(),
    destroy: z.boolean(),
    writeFile: z.boolean().default(true),
  }),
  discoveryBySubmission: z.boolean(),
});
export const FakeEvent = z.strictObject({
  eventId: z.string().min(1),
  ref: z.object({
    scope: z.object({
      provider: z.string(),
      connectionId: z.string(),
      accountId: z.string(),
      region: z.string().optional(),
    }),
    nativeId: z.string(),
    kind: z.literal("sandbox"),
  }),
  sequence: z.number().int().nonnegative(),
  state: z.enum(["running", "destroyed"]),
  occurredAt: z.iso.datetime({ offset: true }),
});
const MAX_RESOURCES = 128,
  MAX_LEDGER = 512,
  MAX_INVOCATIONS = 512,
  MAX_FILE_BYTES = 1024 * 1024,
  MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ResourceSchema = z.strictObject({
  ref: NativeRef,
  state: z.enum(["running", "destroyed"]),
  image: z.string(),
  networkPolicy: z.string(),
  labels: z.record(z.string(), z.string()),
  files: z.record(z.string(), z.base64().max(1_398_104)),
  sequence: z.number().int().nonnegative(),
});
const LedgerEntrySchema = z
  .strictObject({
    submissionId: z.string().min(1),
    projectId: z.string().min(1),
    scope: NativeScope,
    action: FakeScenario.shape.action,
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    result: DriverResult.refine(
      (value) => value.status === "completed",
      "Persisted effect must be completed",
    ),
    remaining: z.number().int(),
    discoverable: z.boolean(),
  })
  .superRefine((entry, context) => {
    if (entry.result.status !== "completed") return;
    const value = entry.result.value;
    const expectedKind = {
      create: "sandbox",
      exec: "execution",
      destroy: "destroy",
      file_write: "file_write",
    }[entry.action];
    const effectScope =
      value.kind === "sandbox" ? value.observation.ref.scope : value.observation.sandbox.scope;
    if (value.kind !== expectedKind || scopeKey(effectScope) !== scopeKey(entry.scope)) {
      context.addIssue({
        code: "custom",
        message: "Persisted effect does not match its action or scope",
      });
    }
  });
const StateSchema = z.strictObject({
  version: z.literal(1),
  nextId: z.number().int().min(1),
  tick: z.number().int().nonnegative(),
  profile: FakeProfile,
  resources: z.array(ResourceSchema).max(MAX_RESOURCES),
  ledger: z.array(LedgerEntrySchema).max(MAX_LEDGER),
  scenarios: z.array(FakeScenario).max(512),
  events: z.array(FakeEvent).max(512),
  invocations: z
    .array(
      z.strictObject({
        submissionId: z.string().min(1),
        projectId: z.string().min(1),
        action: FakeScenario.shape.action,
      }),
    )
    .max(MAX_INVOCATIONS),
});
type State = z.infer<typeof StateSchema>;
type Resource = z.infer<typeof ResourceSchema>;
const empty = (): State => ({
  version: 1,
  nextId: 1,
  tick: 0,
  profile: {
    nativeIdempotency: { create: true, exec: true, destroy: true, writeFile: true },
    discoveryBySubmission: true,
  },
  resources: [],
  ledger: [],
  scenarios: [],
  events: [],
  invocations: [],
});
const scopeKey = (scope: NativeScope) =>
  `${scope.provider}\0${scope.connectionId}\0${scope.accountId}\0${scope.region ?? ""}`;
const sameScope = (a: NativeScope, b: NativeScope) => scopeKey(a) === scopeKey(b);
const iso = (tick: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
const bytesLength = (b64: string) => Buffer.from(b64, "base64").length;
class FakeCapacityError extends Error {}

export class FakeProviderEngine {
  private state: State = empty();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    readonly statePath: string,
    readonly testMode: boolean,
  ) {}

  async load(): Promise<void> {
    try {
      if ((await stat(this.statePath)).size > MAX_TOTAL_BYTES)
        throw new Error("Invalid fake provider state size");
      const parsed = StateSchema.safeParse(JSON.parse(await readFile(this.statePath, "utf8")));
      if (!parsed.success) throw new Error("Invalid fake provider state version or shape");
      this.state = parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof SyntaxError) throw new Error("Invalid fake provider state JSON");
      throw error;
    }
  }
  private async save(): Promise<void> {
    const json = JSON.stringify(this.state);
    if (Buffer.byteLength(json) > MAX_TOTAL_BYTES)
      throw new FakeCapacityError("Fake provider state limit reached");
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, json, { mode: 0o600 });
    await rename(temp, this.statePath);
  }
  private async mutate<T>(fn: () => T, capacityResult?: () => T): Promise<T> {
    const work = this.pending.then(async () => {
      const previous = structuredClone(this.state);
      try {
        const value = fn();
        await this.save();
        return value;
      } catch (error) {
        this.state = previous;
        if (error instanceof FakeCapacityError && capacityResult) return capacityResult();
        throw error;
      }
    });
    this.pending = work.catch(() => undefined);
    return work;
  }
  private scenario(submissionId: string, action: FakeScenario["action"]): FakeScenario {
    const exact = this.state.scenarios.find(
      (x) => x.submissionId === submissionId && x.action === action,
    );
    if (exact) return exact;
    const queued = this.state.scenarios.findIndex(
      (x) => x.submissionId === "*" && x.action === action,
    );
    if (queued >= 0) return { ...this.state.scenarios.splice(queued, 1)[0]!, submissionId };
    return FakeScenario.parse({ submissionId, action });
  }
  private ref(scope: NativeScope, kind: "sandbox" | "execution"): NativeRef {
    return { scope, kind, nativeId: `fake_${kind}_${this.state.nextId++}` };
  }
  private recordInvocation(
    submissionId: string,
    projectId: string,
    action: FakeScenario["action"],
  ) {
    this.state.invocations.push({ submissionId, projectId, action });
    if (this.state.invocations.length > MAX_INVOCATIONS) this.state.invocations.shift();
  }
  private find(ref: NativeRef): Resource | undefined {
    return this.state.resources.find(
      (x) =>
        sameScope(x.ref.scope, ref.scope) &&
        x.ref.nativeId === ref.nativeId &&
        ref.kind === "sandbox",
    );
  }
  private rejection(code: "capacity" | "unsupported" | "conflict"): z.infer<typeof DriverResult> {
    return {
      status: "rejected",
      effect: "none",
      error: { code, message: `Fake fixture rejected ${code}`, effect: "none", retry: "never" },
    };
  }
  async reset(): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    await this.mutate(() => {
      this.state = empty();
    });
  }
  async seed(scenario: unknown): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    const parsed = FakeScenario.parse(scenario);
    await this.mutate(() => {
      if (this.state.scenarios.length >= 512) throw new Error("Fake scenario limit reached");
      if (parsed.submissionId !== "*")
        this.state.scenarios = this.state.scenarios.filter(
          (x) => !(x.submissionId === parsed.submissionId && x.action === parsed.action),
        );
      this.state.scenarios.push(parsed);
    });
  }
  async setProfile(profile: unknown): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    const parsed = FakeProfile.parse(profile);
    await this.mutate(() => {
      this.state.profile = parsed;
    });
  }
  async seedEvents(events: unknown): Promise<void> {
    if (!this.testMode) throw new Error("Test mode required");
    const parsed = z.array(FakeEvent).max(512).parse(events);
    await this.mutate(() => {
      this.state.events = [...this.state.events, ...parsed].slice(-512);
    });
  }
  events(scope: NativeScope) {
    return this.state.events.filter((x) => sameScope(x.ref.scope, scope));
  }
  profile() {
    return structuredClone(this.state.profile);
  }
  snapshot(): Omit<State, "scenarios"> {
    if (!this.testMode) throw new Error("Test mode required");
    const { scenarios: _scenarios, ...rest } = this.state;
    return structuredClone(rest);
  }
  async create(input: {
    scope: NativeScope;
    identity: InvocationIdentity;
    image: string;
    networkPolicy: string;
    labels?: Record<string, string>;
  }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    const requestHash = await intentSha256(input);
    return this.mutate(
      () => {
        const { submissionId } = input.identity;
        const prior = this.state.ledger.find(
          (x) =>
            x.submissionId === submissionId &&
            x.projectId === input.identity.projectId &&
            sameScope(x.scope, input.scope),
        );
        if (prior?.action !== undefined && prior.action !== "create")
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && prior.requestHash !== requestHash)
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && this.state.profile.nativeIdempotency.create)
          return { result: prior.result, loseResponse: false };
        if (this.state.ledger.length >= MAX_LEDGER)
          return { result: this.rejection("capacity"), loseResponse: false };
        const scenario = this.scenario(submissionId, "create");
        this.recordInvocation(submissionId, input.identity.projectId, "create");
        if (scenario.behavior === "reject")
          return { result: this.rejection(scenario.rejectCode), loseResponse: false };
        if (scenario.behavior === "ambiguous_before_effect")
          return {
            result: {
              status: "unknown",
              effect: "possible",
              submissionId,
              reason: "Submission acknowledgement lost",
            } as const,
            loseResponse: true,
          };
        if (this.state.resources.length >= MAX_RESOURCES)
          return { result: this.rejection("capacity"), loseResponse: false };
        const ref = this.ref(input.scope, "sandbox");
        this.state.resources.push({
          ref,
          state: "running",
          image: input.image,
          networkPolicy: input.networkPolicy,
          labels: input.labels ?? {},
          files: {},
          sequence: 1,
        });
        const result: z.infer<typeof DriverResult> = {
          status: "completed",
          effect: "applied",
          value: {
            kind: "sandbox",
            observation: {
              ref,
              state: "running",
              observedAt: iso(this.state.tick++),
              sourceSequence: 1,
            },
          },
        };
        this.state.ledger.push({
          submissionId,
          projectId: input.identity.projectId,
          scope: input.scope,
          action: "create",
          requestHash,
          result,
          remaining: scenario.delayObservations,
          discoverable: this.state.profile.discoveryBySubmission,
        });
        return {
          result: scenario.delayObservations
            ? ({ status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const)
            : result,
          loseResponse: scenario.behavior === "lost_after_effect",
        };
      },
      () => ({ result: this.rejection("capacity"), loseResponse: false }),
    );
  }
  async exec(input: {
    sandbox: NativeRef;
    identity: InvocationIdentity;
    command: z.infer<typeof ExecCommand>;
    cwd?: string;
    env?: Record<string, string>;
    deadlineSeconds: number;
    maxOutputBytes: number;
  }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    const requestHash = await intentSha256(input);
    return this.mutate(
      () => {
        const { submissionId } = input.identity;
        const prior = this.state.ledger.find(
          (x) =>
            x.submissionId === submissionId &&
            x.projectId === input.identity.projectId &&
            sameScope(x.scope, input.sandbox.scope),
        );
        if (prior?.action !== undefined && prior.action !== "exec")
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && prior.requestHash !== requestHash)
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && this.state.profile.nativeIdempotency.exec)
          return { result: prior.result, loseResponse: false };
        if (this.state.ledger.length >= MAX_LEDGER)
          return { result: this.rejection("capacity"), loseResponse: false };
        const scenario = this.scenario(submissionId, "exec");
        this.recordInvocation(submissionId, input.identity.projectId, "exec");
        if (scenario.behavior === "reject")
          return { result: this.rejection(scenario.rejectCode), loseResponse: false };
        if (scenario.behavior === "ambiguous_before_effect")
          return {
            result: {
              status: "unknown",
              effect: "possible",
              submissionId,
              reason: "Submission acknowledgement lost",
            } as const,
            loseResponse: true,
          };
        const resource = this.find(input.sandbox);
        if (!resource || resource.state !== "running")
          return {
            result: {
              status: "rejected",
              effect: "none",
              error: {
                code: "not_found",
                message: "Fake sandbox not found",
                effect: "none",
                retry: "never",
              },
            } as const,
            loseResponse: false,
          };
        const fixture = scenario.command;
        if (
          !fixture ||
          canonicalJson(fixture.command) !== canonicalJson(input.command) ||
          fixture.cwd !== input.cwd ||
          canonicalJson(fixture.env ?? {}) !== canonicalJson(input.env ?? {}) ||
          (fixture.deadlineSeconds !== undefined &&
            fixture.deadlineSeconds !== input.deadlineSeconds)
        )
          return { result: this.rejection("unsupported"), loseResponse: false };
        const stdout = Buffer.from(fixture.stdoutBase64, "base64"),
          stderr = Buffer.from(fixture.stderrBase64, "base64");
        const cap = Math.min(input.maxOutputBytes, 1048576);
        const stdoutKept = stdout.subarray(0, cap),
          stderrKept = stderr.subarray(0, Math.max(0, cap - stdoutKept.length));
        const ref = this.ref(input.sandbox.scope, "execution");
        const result: z.infer<typeof DriverResult> = {
          status: "completed",
          effect: "applied",
          value: {
            kind: "execution",
            observation: {
              ref,
              sandbox: input.sandbox,
              completed: true,
              exitCode: fixture.exitCode,
              stdoutBase64: stdoutKept.toString("base64"),
              stderrBase64: stderrKept.toString("base64"),
              truncated: stdoutKept.length < stdout.length || stderrKept.length < stderr.length,
              observedAt: iso(this.state.tick++),
            },
          },
        };
        this.state.ledger.push({
          submissionId,
          projectId: input.identity.projectId,
          scope: input.sandbox.scope,
          action: "exec",
          requestHash,
          result,
          remaining: scenario.delayObservations,
          discoverable: this.state.profile.discoveryBySubmission,
        });
        return {
          result: scenario.delayObservations
            ? ({ status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const)
            : result,
          loseResponse: scenario.behavior === "lost_after_effect",
        };
      },
      () => ({ result: this.rejection("capacity"), loseResponse: false }),
    );
  }
  async destroy(input: {
    sandbox: NativeRef;
    identity: InvocationIdentity;
  }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    const requestHash = await intentSha256(input);
    return this.mutate(
      () => {
        const { submissionId } = input.identity;
        const prior = this.state.ledger.find(
          (x) =>
            x.submissionId === submissionId &&
            x.projectId === input.identity.projectId &&
            sameScope(x.scope, input.sandbox.scope),
        );
        if (prior?.action !== undefined && prior.action !== "destroy")
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && prior.requestHash !== requestHash)
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && this.state.profile.nativeIdempotency.destroy)
          return { result: prior.result, loseResponse: false };
        if (this.state.ledger.length >= MAX_LEDGER)
          return { result: this.rejection("capacity"), loseResponse: false };
        const scenario = this.scenario(submissionId, "destroy");
        this.recordInvocation(submissionId, input.identity.projectId, "destroy");
        if (scenario.behavior === "reject")
          return { result: this.rejection(scenario.rejectCode), loseResponse: false };
        if (scenario.behavior === "ambiguous_before_effect")
          return {
            result: {
              status: "unknown",
              effect: "possible",
              submissionId,
              reason: "Submission acknowledgement lost",
            } as const,
            loseResponse: true,
          };
        const resource = this.find(input.sandbox);
        if (!resource)
          return {
            result: {
              status: "rejected",
              effect: "none",
              error: {
                code: "not_found",
                message: "Fake sandbox not found",
                effect: "none",
                retry: "never",
              },
            } as const,
            loseResponse: false,
          };
        resource.state = "destroyed";
        resource.files = {};
        resource.sequence++;
        const result: z.infer<typeof DriverResult> = {
          status: "completed",
          effect: "applied",
          value: {
            kind: "destroy",
            observation: { sandbox: input.sandbox, computeStopped: true, retainedResources: [] },
          },
        };
        this.state.ledger.push({
          submissionId,
          projectId: input.identity.projectId,
          scope: input.sandbox.scope,
          action: "destroy",
          requestHash,
          result,
          remaining: scenario.delayObservations,
          discoverable: this.state.profile.discoveryBySubmission,
        });
        return {
          result: scenario.delayObservations
            ? ({ status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const)
            : result,
          loseResponse: scenario.behavior === "lost_after_effect",
        };
      },
      () => ({ result: this.rejection("capacity"), loseResponse: false }),
    );
  }
  async observe(
    scope: NativeScope,
    submissionId: string,
  ): Promise<z.infer<typeof DriverResult> | null> {
    return this.mutate(() => {
      const entry = this.state.ledger.find(
        (x) => x.submissionId === submissionId && x.discoverable && sameScope(x.scope, scope),
      );
      if (!entry) return null;
      const ref =
        entry.result.status === "completed"
          ? entry.result.value.kind === "sandbox"
            ? entry.result.value.observation.ref
            : entry.result.value.kind === "execution"
              ? entry.result.value.observation.sandbox
              : entry.result.value.observation.sandbox
          : undefined;
      if (!ref || !sameScope(ref.scope, scope)) return null;
      if (entry.remaining-- > 0)
        return { status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const;
      return entry.result;
    });
  }
  inspect(ref: NativeRef) {
    const r = this.find(ref);
    return r
      ? { ref: r.ref, state: r.state, observedAt: iso(this.state.tick), sourceSequence: r.sequence }
      : null;
  }
  inventory(scope: NativeScope, cursor: string | undefined, limit: number) {
    const start = cursor ? Number(cursor) : 0;
    const resources = this.state.resources.filter((x) => sameScope(x.ref.scope, scope));
    const items = resources.slice(start, start + limit).map((x) => ({
      ref: x.ref,
      state: x.state,
      observedAt: iso(this.state.tick),
      sourceSequence: x.sequence,
    }));
    return {
      items,
      nextCursor: start + limit < resources.length ? String(start + limit) : undefined,
    };
  }
  readFile(ref: NativeRef, path: string): string | null {
    const resource = this.find(ref);
    return resource?.state === "running" ? (resource.files[path] ?? null) : null;
  }
  async writeFile(input: {
    sandbox: NativeRef;
    identity: InvocationIdentity;
    path: string;
    bytesBase64: string;
    overwrite: boolean;
  }): Promise<{ result: z.infer<typeof DriverResult>; loseResponse: boolean }> {
    const requestHash = await intentSha256(input);
    return this.mutate(
      () => {
        const { sandbox, identity, path, bytesBase64, overwrite } = input;
        const { submissionId } = identity;
        const prior = this.state.ledger.find(
          (x) =>
            x.submissionId === submissionId &&
            x.projectId === identity.projectId &&
            sameScope(x.scope, sandbox.scope),
        );
        if (prior?.action !== undefined && prior.action !== "file_write")
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && prior.requestHash !== requestHash)
          return { result: this.rejection("conflict"), loseResponse: false };
        if (prior && this.state.profile.nativeIdempotency.writeFile)
          return { result: prior.result, loseResponse: false };
        if (this.state.ledger.length >= MAX_LEDGER)
          return { result: this.rejection("capacity"), loseResponse: false };
        const scenario = this.scenario(submissionId, "file_write");
        this.recordInvocation(submissionId, identity.projectId, "file_write");
        if (scenario.behavior === "reject")
          return { result: this.rejection(scenario.rejectCode), loseResponse: false };
        if (scenario.behavior === "ambiguous_before_effect")
          return {
            result: {
              status: "unknown",
              effect: "possible",
              submissionId,
              reason: "Submission acknowledgement lost",
            } as const,
            loseResponse: true,
          };
        const resource = this.find(sandbox);
        if (!resource || resource.state !== "running")
          return {
            result: {
              status: "rejected",
              effect: "none",
              error: {
                code: "not_found",
                message: "Fake sandbox not found",
                effect: "none",
                retry: "never",
              },
            } as const,
            loseResponse: false,
          };
        if (!overwrite && path in resource.files)
          return { result: this.rejection("conflict"), loseResponse: false };
        if (bytesLength(bytesBase64) > MAX_FILE_BYTES)
          return { result: this.rejection("capacity"), loseResponse: false };
        resource.files[path] = bytesBase64;
        const result: z.infer<typeof DriverResult> = {
          status: "completed",
          effect: "applied",
          value: {
            kind: "file_write",
            observation: { sandbox, path, bytesWritten: bytesLength(bytesBase64), complete: true },
          },
        };
        this.state.ledger.push({
          submissionId,
          projectId: identity.projectId,
          scope: sandbox.scope,
          action: "file_write",
          requestHash,
          result,
          remaining: scenario.delayObservations,
          discoverable: this.state.profile.discoveryBySubmission,
        });
        return {
          result: scenario.delayObservations
            ? ({ status: "pending", effect: "possible", submissionId, observeAfterMs: 0 } as const)
            : result,
          loseResponse: scenario.behavior === "lost_after_effect",
        };
      },
      () => ({ result: this.rejection("capacity"), loseResponse: false }),
    );
  }
}
