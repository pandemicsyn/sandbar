import { ReferenceSchema } from "./adapter-reference";
import packageMetadata from "../package.json";
/* oxlint-disable anti-slop/no-runtime-typeof -- This bounded allowlist helper checks primitives in memory without serializing arbitrary values or allocating a schema per span. */
/* oxlint-disable anti-slop/no-unknown-returns -- The heterogeneous instance wrapper is internal and preserves the target method's existing generic return type. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Telemetry boundaries accept arbitrary thrown values and heterogeneous SDK results without serializing them. */
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  SpanKind,
  type Context,
  type Span,
  type SpanContext,
  type TracerProvider,
  type Attributes,
} from "@opentelemetry/api";
import {
  SandbarError,
  NonzeroExitError,
  NoExitCodeError,
  validateReference,
  type RecoveryReference,
} from "./resource";

export interface ObservabilityOptions {
  /** Omission uses the application provider. Sandbar never owns provider shutdown. */
  tracing?: false | { tracerProvider?: TracerProvider };
}

export interface DiagnosticContext {
  errorCode?: string;
  effect?: "none" | "possible" | "applied" | "partial" | "unknown";
  operationId?: string;
  submissionId?: string;
  operationState?: "pending" | "completed" | "rejected" | "failed" | "unknown";
  recoveryAvailable: boolean;
}

const retainedCounts = new WeakMap<object, number>();

export function noteRetainedResources<T extends object>(value: T, count: number): void {
  retainedCounts.set(value, Math.min(count, 100));
}

const operationFacts = new WeakMap<
  object,
  { state: NonNullable<DiagnosticContext["operationState"]>; effect: DiagnosticContext["effect"] }
>();

export function noteOperation<T extends object>(
  value: T,
  state: NonNullable<DiagnosticContext["operationState"]>,
  effect: DiagnosticContext["effect"],
): void {
  const facts = operationFacts.get(value);

  if (facts) {
    facts.state = state;
    facts.effect = effect;
  } else operationFacts.set(value, { state, effect });
}

const codes = new Set([
  "INVALID_ARGUMENT",
  "INVALID_RESPONSE",
  "UNSUPPORTED",
  "UNAVAILABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CONFLICT",
  "NOT_FOUND",
  "CAPACITY",
  "RATE_LIMIT",
  "OUTPUT_CAPACITY",
  "OUTPUT_UNAVAILABLE",
  "INVOCATION_EXPIRED",
  "CLIENT_CLOSED",
  "WAIT_ABORTED",
  "OUTCOME_UNKNOWN",
  "NONZERO_EXIT",
  "EXIT_STATUS_UNKNOWN",
  "TIMEOUT",
  "HTTP_ERROR",
  "OPERATION_FAILED",
  "INTERNAL",
]);

// Only Sandbar-generated identities, never native locators, are eligible for telemetry.
export function safeIdentity(value: unknown): string | undefined {
  return typeof value === "string" && /^(sdk|op|sub)_[0-9a-f]{32}$/.test(value) ? value : undefined;
}

// oxlint-disable anti-slop/no-unsafe-dictionary-type -- This private snapshot copies own data descriptors within a fixed budget, then immediately validates the detached values against the existing recovery schemas.
function recoverySnapshot(value: unknown): unknown {
  let remaining = 16_384;
  const visiting = new WeakSet<object>();

  const copy = (input: unknown): unknown => {
    remaining--;

    if (typeof input === "string") remaining -= input.length;

    if (remaining < 0) throw new Error("Diagnostic reference exceeds its budget");

    if (!input || typeof input !== "object") {
      if (["string", "number", "boolean", "undefined"].includes(typeof input) || input === null)
        return input;
      throw new Error("Diagnostic reference contains a non-data value");
    }

    if (visiting.has(input)) throw new Error("Diagnostic reference contains a cycle");
    visiting.add(input);
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);

    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Diagnostic reference contains a non-JSON container");
    const result: Record<string, unknown> | unknown[] = array ? [] : {};

    const copyProperty = (key: string) => {
      if (!array) remaining -= key.length;

      if (remaining < 0) throw new Error("Diagnostic reference exceeds its budget");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (!descriptor || !("value" in descriptor))
        throw new Error("Diagnostic reference contains a non-data entry");
      Object.defineProperty(result, key, {
        value: copy(descriptor.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    };

    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, "length")?.value;

      if (!Number.isSafeInteger(length) || length < 0 || length > remaining)
        throw new Error("Diagnostic reference contains an oversized array");

      for (let index = 0; index < length; index++) copyProperty(String(index));
    } else {
      for (const key in input) {
        if (Object.prototype.hasOwnProperty.call(input, key)) copyProperty(key);
      }
    }

    visiting.delete(input);

    return result;
  };

  return copy(value);
}
// oxlint-enable anti-slop/no-unsafe-dictionary-type

function remoteRecoveryAvailable(value: unknown): boolean {
  // SAFETY: The detached snapshot is fully validated by the existing public remote contract.
  return !!attempt(() => validateReference(recoverySnapshot(value) as RecoveryReference));
}

function directRecoveryAvailable(value: unknown): boolean {
  return (
    attempt(() => {
      const reference = ReferenceSchema.parse(recoverySnapshot(value));

      if (JSON.stringify(reference).length > 16_384) return false;

      if ((reference.kind === "file_write") !== !!reference.file) return false;
      const createsResource = reference.kind === "create" || reference.kind === "image_build";

      return createsResource ? !reference.sandboxId : !!reference.sandboxId;
    }) ?? false
  );
}

/** Pure correlation data; the original handle/error retains recovery authority. */
export function diagnosticContext(value: unknown): Readonly<DiagnosticContext> {
  const record: DiagnosticContext = { recoveryAvailable: false };

  try {
    if (value instanceof SandbarError) {
      const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
      const effect = Object.getOwnPropertyDescriptor(value, "effect")?.value;

      record.errorCode = typeof code === "string" && codes.has(code) ? code : "INTERNAL";

      if (
        effect === "none" ||
        effect === "possible" ||
        effect === "applied" ||
        effect === "partial" ||
        effect === "unknown"
      )
        record.effect = effect;

      if (code === "OUTCOME_UNKNOWN") record.operationState = "unknown";
    }

    if (value && typeof value === "object") {
      const state = operationFacts.get(value);

      if (state) {
        record.operationState = state.state;
        record.effect = state.effect;
      }

      // Data properties only: diagnostic collection never invokes application accessors.
      const ref = Object.getOwnPropertyDescriptor(value, "reference")?.value;

      if (ref && typeof ref === "object") {
        const mode = Object.getOwnPropertyDescriptor(ref, "mode")?.value;

        record.operationId = safeIdentity(
          Object.getOwnPropertyDescriptor(ref, "operationId")?.value,
        );
        record.submissionId = safeIdentity(
          Object.getOwnPropertyDescriptor(ref, "submissionId")?.value,
        );
        record.recoveryAvailable =
          mode === "direct"
            ? !!record.operationId && !!record.submissionId && directRecoveryAvailable(ref)
            : mode === "remote" && remoteRecoveryAvailable(ref);
      }
    }
  } catch {
    // Malformed objects/getters are not a diagnostic failure path.
  }

  return Object.freeze(record);
}

function diagnosticAttributes(value: unknown): Attributes {
  const d = diagnosticContext(value);
  const attrs: Attributes = {};

  if (d.errorCode) attrs["sandbar.error.code"] = d.errorCode;

  if (d.effect) attrs["sandbar.effect"] = d.effect;

  if (d.operationId) attrs["sandbar.operation.id"] = d.operationId;

  if (d.submissionId) attrs["sandbar.submission.id"] = d.submissionId;

  if (d.operationState) attrs["sandbar.operation.state"] = d.operationState;
  attrs["sandbar.recovery.available"] = d.recoveryAvailable;

  if (value && typeof value === "object") {
    const retained = retainedCounts.get(value);

    if (retained !== undefined) attrs["sandbar.retained_resource.count"] = retained;
  }

  return attrs;
}

/** W3C version 00 only; fixed size, no tracestate or baggage. */
export function parseTraceParent(value: unknown): SpanContext | undefined {
  if (typeof value !== "string" || value.length !== 55) return;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(value);

  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return;

  return { traceId: match[1]!, spanId: match[2]!, traceFlags: Number(match[3]), isRemote: true };
}

function attempt<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

export function activeTraceParent(): string | undefined {
  return attempt(() => {
    const sc = trace.getSpanContext(context.active());

    if (!sc || !trace.isSpanContextValid(sc)) return;

    return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags & 1 ? "01" : "00"}`;
  });
}

const operationKinds = new Set(["create", "exec", "destroy", "file_write", "image_build"]);

function operationKind(value: unknown): string | undefined {
  return typeof value === "string" && operationKinds.has(value) ? value : undefined;
}

function identityKind(value: unknown): string | undefined {
  return attempt(() => {
    if (!value || typeof value !== "object") return;
    const reference = Object.getOwnPropertyDescriptor(value, "reference")?.value;

    if (!reference || typeof reference !== "object") return;

    return operationKind(Object.getOwnPropertyDescriptor(reference, "kind")?.value);
  });
}

function callType(name: string): string | undefined {
  if (
    [
      "sandbar.sandbox.create",
      "sandbar.sandbox.submit_create",
      "sandbar.sandbox.check_create",
    ].includes(name)
  )
    return "create";

  if (["sandbar.exec", "sandbar.exec.submit"].includes(name)) return "exec";

  if (["sandbar.image.build", "sandbar.image.submit_build"].includes(name)) return "image_build";

  if (name === "sandbar.file.write") return "file_write";

  if (name === "sandbar.sandbox.destroy") return "destroy";

  return undefined;
}

interface CallState {
  name: string;
  operationType?: string;
  polls: number;
  transitions: number;
  last?: string;
  effect: "none" | "possible" | "applied";
  dropped: number;
  span: Span;
}

/** Internal direct SDK instrumentation; never configures OTel globals. */
export class Telemetry {
  private readonly owner = Symbol("sandbar.call");
  constructor(
    options: ObservabilityOptions = {},
    private readonly mode: "direct" = "direct",
    private readonly provider = "custom",
  ) {
    this.options = { tracing: options.tracing };
  }
  private readonly options: ObservabilityOptions;
  get enabled(): boolean {
    return this.options.tracing !== false;
  }
  correlate(value: unknown): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (call && call.span.isRecording()) call.span.setAttributes(diagnosticAttributes(value));
    });
  }
  submitted(): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (call) call.effect = "possible";
    });
  }
  poll(state: "pending" | "completed" | "rejected" | "unknown"): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (!call) return;
      call.polls++;

      if (call.last === state) return;
      call.last = state;

      if (call.transitions++ < 8)
        attempt(() => call.span.addEvent("sandbar.state", { "sandbar.operation.state": state }));
      else call.dropped++;
    });
  }
  async run<T>(
    name: string,
    work: () => Promise<T>,
    options: {
      phase?: boolean;
      effect?: "none" | "possible" | "applied";
      origin?: unknown;
      parent?: Context;
      kind?: SpanKind;
      identity?: unknown;
      operationType?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (!this.enabled) return work();
    const parent = options.parent ?? attempt(() => context.active()) ?? ROOT_CONTEXT;

    // SAFETY: Only this instance writes the owner key with a CallState.
    const enclosing = attempt(() => parent.getValue(this.owner)) as CallState | undefined;

    const operationType =
      operationKind(options.operationType) ??
      identityKind(options.identity) ??
      callType(name) ??
      enclosing?.operationType;

    const provider = this.options.tracing && this.options.tracing.tracerProvider;
    const scope = "sandbar-sdk";

    const span = attempt(() => {
      const tracer = provider
        ? provider.getTracer(scope, packageMetadata.version)
        : trace.getTracer(scope, packageMetadata.version);

      const origin = parseTraceParent(options.origin);

      const attributes: Attributes = {
        "sandbar.mode": this.mode,
        "sandbar.provider": ["daytona", "e2b", "modal", "fake"].includes(this.provider)
          ? this.provider
          : "custom",
        "sandbar.operation.type": operationType ?? name.replace(/^sandbar\./, ""),
      };

      if (options.phase) attributes["sandbar.phase"] = name.slice(8);

      if (options.identity) Object.assign(attributes, diagnosticAttributes(options.identity));

      return tracer.startSpan(
        name,
        {
          kind: options.kind ?? SpanKind.INTERNAL,
          attributes,
          links: origin ? [{ context: origin }] : [],
        },
        parent,
      );
    });

    if (!span) return work();
    const recording = attempt(() => span.isRecording()) ?? false;

    const state: CallState = {
      name,
      operationType,
      polls: 0,
      transitions: 0,
      effect: options.identity ? "possible" : "none",
      dropped: 0,
      span,
    };

    let active = attempt(() => trace.setSpan(parent, span)) ?? parent;

    if (!options.phase || name === "sandbar.wait")
      active = attempt(() => active.setValue(this.owner, state)) ?? parent;
    // Call work once even if a custom context manager throws before/after invoking it.
    let promise: Promise<T> | undefined;
    let invoked = false;

    const invoke = () => {
      if (!invoked) {
        invoked = true;

        try {
          promise = Promise.resolve(work());
        } catch (error) {
          promise = Promise.reject(error);
        }
      }

      return promise!;
    };

    try {
      attempt(() => context.with(active, invoke));
      const result = await (promise ?? invoke());

      if (recording)
        attempt(() => {
          span.setAttributes({
            "sandbar.call.outcome": "success",
            "sandbar.effect": options.effect ?? "none",
            ...diagnosticAttributes(result),
          });

          if (name === "sandbar.wait" || name === "sandbar.operation.wait")
            span.setAttributes({
              ...diagnosticAttributes(options.identity),
              "sandbar.operation.state": "completed",
            });

          if (name === "sandbar.operation.observe")
            span.setAttributes({
              ...diagnosticAttributes(options.identity),
              "sandbar.operation.state": result === null ? "pending" : "completed",
              "sandbar.effect": result === null ? "possible" : "applied",
            });

          if (
            result &&
            typeof result === "object" &&
            "reference" in result &&
            name.includes("submit")
          ) {
            const facts = diagnosticContext(result);

            if (!facts.operationState) span.setAttribute("sandbar.effect", "possible");
          }

          if (
            result &&
            typeof result === "object" &&
            "exitCode" in result &&
            Number.isSafeInteger(result.exitCode)
          )
            span.setAttribute("sandbar.exec.exit_code", Number(result.exitCode));

          if (result && typeof result === "object" && "kind" in result) {
            if (result.kind === "unknown")
              span.setAttributes({
                "sandbar.operation.state": "unknown",
                "sandbar.effect": "possible",
              });

            if (result.kind === "pending")
              span.setAttributes({
                "sandbar.operation.state": "pending",
                "sandbar.effect": "possible",
              });

            if (result.kind === "rejected")
              span.setAttributes({
                "sandbar.effect": "none",
                "sandbar.operation.state": "rejected",
              });

            if (result.kind === "completed") {
              span.setAttributes({
                "sandbar.operation.state": "completed",
                "sandbar.effect": "applied",
              });

              if (
                "value" in result &&
                result.value &&
                typeof result.value === "object" &&
                "retainedResources" in result.value &&
                Array.isArray(result.value.retainedResources)
              )
                span.setAttribute(
                  "sandbar.retained_resource.count",
                  Math.min(result.value.retainedResources.length, 100),
                );
            }
          }
        });

      return result;
    } catch (error) {
      if (recording)
        attempt(() => {
          const attrs = diagnosticAttributes(error);

          const cancelled =
            options.signal?.aborted || attrs["sandbar.error.code"] === "WAIT_ABORTED";

          const identityAttrs: Attributes =
            name === "sandbar.wait" ||
            name === "sandbar.operation.wait" ||
            name === "sandbar.operation.observe"
              ? diagnosticAttributes(options.identity)
              : {};

          span.setAttributes({
            ...identityAttrs,
            "sandbar.call.outcome": cancelled ? "cancelled" : "error",
            "sandbar.effect": state.effect,
            ...attrs,
          });

          if (identityAttrs["sandbar.recovery.available"])
            span.setAttribute("sandbar.recovery.available", true);

          if (!cancelled)
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Sandbar call failed" });

          if (!options.phase)
            span.recordException({
              name: "SandbarError",
              message: String(attrs["sandbar.error.code"] ?? "INTERNAL"),
            });

          if (error instanceof NonzeroExitError || error instanceof NoExitCodeError) {
            if (error.result.exitCode !== null)
              span.setAttribute("sandbar.exec.exit_code", error.result.exitCode);
          }
        });
      throw error;
    } finally {
      if (recording && (name === "sandbar.wait" || name === "sandbar.operation.wait"))
        attempt(() =>
          span.setAttributes({
            "sandbar.wait.poll_count": state.polls,
            "sandbar.events.dropped": state.dropped,
          }),
        );
      attempt(() => span.end());
    }
  }
}

/** Wrap an instance method; the original receiver, arguments and results are preserved. */
export function instrument<T extends object, K extends keyof T>(
  target: T,
  key: K,
  telemetry: Telemetry,
  name: string,
  options: {
    phase?: boolean;
    effect?: "none" | "possible" | "applied";
    identity?: unknown;
    origin?: string;
  } = {},
): void {
  // SAFETY: Call sites select an existing async instance method; arguments and result types are preserved by T[K].
  const original = target[key] as (...args: unknown[]) => Promise<unknown>;

  const invoke = async (...args: unknown[]) => {
    try {
      const result = await original.apply(target, args);

      if (name === "sandbar.operation.observe" || name === "sandbar.operation.wait") {
        noteOperation(
          target,
          result === null ? "pending" : "completed",
          result === null ? "possible" : "applied",
        );
      }

      return result;
    } catch (error) {
      if (
        (name === "sandbar.operation.observe" || name === "sandbar.operation.wait") &&
        error instanceof SandbarError
      ) {
        if (error.code === "OUTCOME_UNKNOWN") noteOperation(target, "unknown", "possible");

        if (error.effect === "applied") noteOperation(target, "completed", "applied");
      }

      throw error;
    }
  };

  const wrapped = (...args: unknown[]) => {
    const identity =
      name === "sandbar.operation.recover" || name === "sandbar.observe"
        ? { reference: args[0] }
        : options.identity;

    const operationType = name === "sandbar.prepare" ? operationKind(args[0]) : undefined;

    // SAFETY: The operation.wait wrapper retains its typed first options argument.
    const signal =
      name === "sandbar.operation.wait"
        ? attempt(() => (args[0] as { signal?: AbortSignal } | undefined)?.signal)
        : undefined;

    return telemetry.run(name, () => invoke(...args), {
      ...options,
      identity,
      operationType,
      signal,
    });
  };

  methodBodies.set(wrapped, invoke);
  // SAFETY: Both wrappers preserve the receiver, arguments and original Promise result type.
  target[key] = wrapped as T[K];
}

const methodBodies = new WeakMap<object, object>();

/** Only explicit library delegation bypasses public tracing; user calls always get a span. */
export function internalMethod<F extends (...args: never[]) => Promise<unknown>>(method: F): F {
  // SAFETY: instrument stores a bound implementation with the exact same method signature.
  return (methodBodies.get(method) ?? method) as F;
}

export function waitFor<T>(
  telemetry: Telemetry,
  operation: { wait(options?: { signal?: AbortSignal; pollMs?: number }): Promise<T> },
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<T> {
  return telemetry.run("sandbar.wait", () => internalMethod(operation.wait)(options), {
    phase: true,
    identity: operation,
    effect: "applied",
    signal: options.signal,
  });
}
