/**
 * Sandbar API design, draft 0.1 — contracts only, no runtime implementation.
 * See sandbar-design.md for guarantees, defaults, failure handling, and rollout.
 * TypeScript is the reference; durable values must also fit a JSON wire schema.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type StateKind = "filesystem" | "filesystem+memory";
export type ResourceKind = "sandbox" | "checkpoint" | "workspace" | "workspace-version";

/** A locator, never a credential. Scope is a verified provider account/project. */
export interface ResourceRef<K extends ResourceKind> {
  version: 1;
  kind: K;
  provider: string; // configured instance, e.g. "daytona-us-prod"
  scope: string;
  nativeId: string;
}
export type SandboxRef = ResourceRef<"sandbox">;
export type CheckpointRef = ResourceRef<"checkpoint">;
export type WorkspaceRef = ResourceRef<"workspace">;
export type WorkspaceVersionRef = ResourceRef<"workspace-version">;

export interface CallOptions {
  signal?: AbortSignal; // cancels waiting/transport; NOT a remote cancellation guarantee
  deadlineMs?: number; // absolute Unix milliseconds for this client operation
  idempotencyKey?: string; // reuse requires identical request; support is reported
}
export interface Resources {
  cpu: number;
  memoryMiB: number;
  diskMiB?: number;
}
export type Placement =
  | { provider: string }
  | { order: string[] }; // explicit, deterministic creation fallback order

export interface Requirements {
  suspend?: StateKind;
  checkpoint?: StateKind;
  terminal?: true;
  processStreaming?: true;
  isolation?: "vm"; // no silent substitution with a shared-kernel runtime
}
export interface LifecyclePolicy {
  idle?: {
    afterSeconds: number;
    activity: "proxy-traffic" | "running-processes";
    action: "destroy" | "suspend";
    preserve?: StateKind; // required for suspend, invalid for destroy
  };
  maxLifetimeSeconds?: number; // wall clock; never translated into idle timeout
}
export type NetworkPolicy =
  | { outbound: "allow" }
  | { outbound: "deny" }
  | { outbound: "allowlist"; domains: string[] };

export interface MountRequest {
  workspace: WorkspaceRef;
  path: string;
  access: "read-only" | "read-write";
  version?: WorkspaceVersionRef; // v1 requires read-only when pinned
}
export interface CreateRequest {
  placement: Placement;
  environment: string; // logical environment in configured catalog
  resources: Resources;
  region?: string;
  requirements?: Requirements;
  lifecycle?: LifecyclePolicy;
  network: NetworkPolicy; // explicit; provider defaults do not define policy
  env?: Record<string, string>; // sensitive: never logged or returned in plans
  mounts?: MountRequest[];
  labels?: Record<string, string>;
  providerOptions?: JsonObject; // only legal with pinned placement; adapter validates
}
export interface EnvironmentBinding {
  artifact: JsonObject; // adapter-owned, versioned schema; no credentials
  contract: { os: "linux"; arch: "amd64" | "arm64"; workingDirectory: string };
  revision: string; // prefer immutable provider artifact/version
}
export type EnvironmentCatalog = Record<string, Record<string, EnvironmentBinding>>;

export type SandboxState =
  | "creating" | "running" | "suspending" | "suspended"
  | "resuming" | "destroying" | "destroyed" | "failed" | "unknown";
export interface SandboxInfo {
  ref: SandboxRef;
  state: SandboxState;
  nativeState: string;
  resources: Resources;
  environmentRevision: string;
  lifecycle: LifecyclePolicy;
  labels: Record<string, string>;
  observedAt: string;
  capabilities: CapabilityReport;
}

/** Detailed availability is request/runtime/account specific, not a static badge. */
export interface Feature {
  available: boolean;
  implementation: "native" | "composed" | "unavailable";
  maturity: "stable" | "experimental";
  conditions: string[];
}
export interface CapabilityReport {
  observedAt: string;
  features: {
    suspendFilesystem: Feature;
    suspendMemory: Feature;
    checkpointFilesystem: Feature;
    checkpointMemory: Feature;
    forkFilesystem: Feature;
    forkMemory: Feature;
    terminal: Feature;
    processStreaming: Feature;
    workspaceMounts: Feature;
  };
}

export interface CheckpointRequest {
  preserve: StateKind; // required: no provider default
  scope: { rootFilesystem: true }; // attached storage is excluded from this contract
  disruption: "none" | "pause" | "stop" | "terminate"; // maximum tolerated effect
  consistency: "crash-consistent" | "caller-quiesced";
  retention?: { minimumSeconds: number };
}
export interface CheckpointInfo {
  ref: CheckpointRef;
  source: SandboxRef;
  preserve: StateKind;
  scope: { rootFilesystem: true; includedMounts: string[]; excludedMounts: string[] };
  createdAt: string;
  expiration: { kind: "at"; at: string } | { kind: "none" } | { kind: "unknown" };
  restore: {
    mode: "cold-boot" | "warm";
    portability: "same-provider-scope";
    mutableResources: Array<keyof Resources>;
    restrictions: string[];
  };
  sourceStateAfter: SandboxState;
  connections: "reconnect-required" | "preserved" | "unknown";
}
export interface RestoreRequest {
  resources?: Partial<Resources>; // only checkpoint-permitted changes
  lifecycle?: LifecyclePolicy;
  mounts?: MountRequest[]; // explicit shared-storage bindings, validated before boot
}
export interface SuspendRequest { preserve: StateKind }
export interface SuspendResult {
  sandbox: SandboxInfo;
  preserved: StateKind;
  resumeMode: "cold-boot" | "warm";
  connections: "reconnect-required" | "preserved" | "unknown";
}
export interface ForkRequest {
  checkpoint: CheckpointRequest;
  mounts: "reject-attached" | "share-explicitly";
  // v1 makes one child per call, so batch partial success stays explicit.
}

export type Command =
  | { argv: [string, ...string[]]; shell?: never }
  | { shell: string; argv?: never }; // explicit POSIX shell command
export interface ExecRequest {
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds: number; // process deadline, distinct from client deadline
  maxOutputBytes: number; // bounded combined capture; no implicit unbounded buffering
}
export interface ExecResult {
  outcome: "exited" | "signaled" | "timed-out";
  exitCode: number | null;
  signal?: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
}
export interface FileReadRequest { path: string; maxBytes: number }
export interface FileWriteRequest { path: string; data: Uint8Array; mode?: number }

export interface EffectReport {
  disruption: CheckpointRequest["disruption"];
  sourceStateAfter?: SandboxState;
  connections: "reconnect-required" | "preserved" | "unknown";
  storageScope?: CheckpointInfo["scope"];
  implementation: "native" | "composed";
  enforcement: "provider" | "gateway";
  limitations: string[];
}
export type PlanAction =
  | { kind: "create"; request: CreateRequest }
  | { kind: "checkpoint"; sandbox: SandboxRef; request: CheckpointRequest }
  | { kind: "suspend"; sandbox: SandboxRef; request: SuspendRequest }
  | { kind: "resume"; sandbox: SandboxRef }
  | { kind: "restore"; checkpoint: CheckpointRef; request: RestoreRequest }
  | { kind: "fork"; sandbox: SandboxRef; request: ForkRequest };
export type PlanResult =
  | { supported: false; reasons: Array<{ code: string; field: string; message: string }> }
  | { supported: true; provider: string; effects: EffectReport; checkedAt: string };

export interface Sandbox {
  readonly ref: SandboxRef;
  inspect(options?: CallOptions): Promise<SandboxInfo>;
  exec(request: ExecRequest, options?: CallOptions): Promise<ExecResult>;
  files: {
    read(request: FileReadRequest, options?: CallOptions): Promise<Uint8Array>;
    write(request: FileWriteRequest, options?: CallOptions): Promise<void>;
  };
  checkpoint(request: CheckpointRequest, options?: CallOptions): Promise<CheckpointInfo>;
  suspend(request: SuspendRequest, options?: CallOptions): Promise<SuspendResult>;
  resume(options?: CallOptions): Promise<SandboxInfo>;
  fork(request: ForkRequest, options?: CallOptions): Promise<Sandbox>;
  destroy(options?: CallOptions): Promise<DestroyResult>;
  processes?: ProcessApi;
  terminal?: TerminalApi;
}
export interface DestroyResult {
  computeStopped: true;
  recoverableUntil?: string; // stopping compute is not a data-erasure guarantee
  retainedResources: Array<CheckpointRef | WorkspaceRef>;
  retentionNotes: string[];
}

export interface WorkspaceVersion {
  ref: WorkspaceVersionRef;
  workspace: WorkspaceRef;
  createdAt: string;
  durability: "remote-confirmed";
}
export interface Workspace {
  readonly ref: WorkspaceRef;
  checkpoint(options?: CallOptions): Promise<WorkspaceVersion>;
  fork(version: WorkspaceVersionRef, options?: CallOptions): Promise<Workspace>;
  // checkpoint must flush the owned mount session; it is not a global multi-writer barrier.
}
export interface SandbarConfig {
  providers: ComputeProvider[];
  environments: EnvironmentCatalog;
  workspaceProviders?: WorkspaceProvider[];
  mountBridges?: MountBridge[];
  experimental?: boolean;
}
export declare class Sandbar {
  constructor(config: SandbarConfig);
  plan(action: PlanAction, options?: CallOptions): Promise<PlanResult>;
  create(request: CreateRequest, options?: CallOptions): Promise<Sandbox>;
  connect(ref: SandboxRef, options?: CallOptions): Promise<Sandbox>; // never creates/resumes
  restore(ref: CheckpointRef, request?: RestoreRequest, options?: CallOptions): Promise<Sandbox>;
  checkpoints: {
    inspect(ref: CheckpointRef, options?: CallOptions): Promise<CheckpointInfo>;
    delete(ref: CheckpointRef, options?: CallOptions): Promise<void>;
  };
  workspaces: {
    create(provider: string, options?: CallOptions): Promise<Workspace>;
    connect(ref: WorkspaceRef, options?: CallOptions): Promise<Workspace>;
  };
}

// ---------------------------------------------------------------------------
// Provider SPI: implementation packages translate native SDK/HTTP calls here.
// ---------------------------------------------------------------------------

export interface DriverContext {
  operationId: string; // generated before submission; stable through reconciliation
  idempotencyKey?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  trace: (event: { name: string; attributes: Record<string, string | number | boolean> }) => void;
}
export interface OperationResults {
  create: SandboxInfo;
  destroy: DestroyResult;
  exec: ExecResult;
  writeFile: void;
  checkpoint: CheckpointInfo;
  restore: SandboxInfo;
  suspend: SuspendResult;
  resume: SandboxInfo;
  fork: SandboxInfo;
  deleteCheckpoint: void;
}
export type OperationKind = keyof OperationResults;
export interface OperationToken<K extends OperationKind> {
  kind: K;
  operationId: string;
  provider: string;
  scope: string;
  nativeOperationId?: string;
  recovery: JsonObject; // versioned, serializable, non-secret adapter data
}
export type DriverResult<K extends OperationKind> =
  | { status: "succeeded"; value: OperationResults[K] }
  | { status: "pending"; token: OperationToken<K>; retryAfterMs?: number }
  | { status: "failed"; error: ProviderError }
  | { status: "unknown"; token: OperationToken<K>; error: ProviderError };

export interface ProviderError {
  code: "UNSUPPORTED" | "INVALID_ARGUMENT" | "AUTH" | "NOT_FOUND" | "CONFLICT"
    | "CAPACITY" | "RATE_LIMIT" | "EXPIRED" | "UNAVAILABLE" | "TIMEOUT"
    | "OUTPUT_LIMIT" | "OUTCOME_UNKNOWN" | "INTERNAL";
  message: string; // redacted
  effect: "not-applied" | "applied" | "unknown";
  retryAfterMs?: number;
  providerCode?: string;
}

/** Filled by the router after placement, environment, and mount validation. */
export interface ResolvedCreate {
  request: CreateRequest & { placement: { provider: string } };
  environment: EnvironmentBinding;
  preparedMounts: PreparedMount[];
}
export interface PreparedMount {
  bridge: string;
  mount: MountRequest;
  configuration: JsonObject; // opaque adapter data; secret references only
}
export type DriverPlanAction =
  | { kind: "create"; request: ResolvedCreate }
  | Exclude<PlanAction, { kind: "create" }>;

export interface ComputeProvider {
  readonly id: string; // instance identity; remains stable across client restarts
  readonly name: string; // provider family, e.g. "tensorlake"
  readonly apiVersion: "sandbar.provider.v1";

  /** Read-only validation; all requested policy fields must be understood. */
  prepare(action: DriverPlanAction, context: DriverContext): Promise<PlanResult>;
  create(request: ResolvedCreate, context: DriverContext): Promise<DriverResult<"create">>;
  inspect(ref: SandboxRef, context: DriverContext): Promise<SandboxInfo>;
  destroy(ref: SandboxRef, context: DriverContext): Promise<DriverResult<"destroy">>;
  exec(ref: SandboxRef, request: ExecRequest, context: DriverContext): Promise<DriverResult<"exec">>;
  readFile(ref: SandboxRef, request: FileReadRequest, context: DriverContext): Promise<Uint8Array>;
  writeFile(ref: SandboxRef, request: FileWriteRequest, context: DriverContext): Promise<DriverResult<"writeFile">>;

  operations?: OperationDriver;
  checkpoints?: CheckpointDriver;
  lifecycle?: LifecycleDriver;
  forks?: ForkDriver;
  processes?: ProcessDriver;
  terminals?: TerminalDriver;
}
export interface OperationDriver {
  /** Observes/reconciles an existing operation; must never submit it again. */
  observe<K extends OperationKind>(token: OperationToken<K>, context: DriverContext): Promise<DriverResult<K>>;
}
export interface CheckpointDriver {
  capture(ref: SandboxRef, request: CheckpointRequest, context: DriverContext): Promise<DriverResult<"checkpoint">>;
  inspect(ref: CheckpointRef, context: DriverContext): Promise<CheckpointInfo>;
  restore(ref: CheckpointRef, request: RestoreRequest, context: DriverContext): Promise<DriverResult<"restore">>;
  delete(ref: CheckpointRef, context: DriverContext): Promise<DriverResult<"deleteCheckpoint">>;
}
export interface LifecycleDriver {
  suspend(ref: SandboxRef, request: SuspendRequest, context: DriverContext): Promise<DriverResult<"suspend">>;
  resume(ref: SandboxRef, context: DriverContext): Promise<DriverResult<"resume">>;
}
export interface ForkDriver {
  fork(ref: SandboxRef, request: ForkRequest, context: DriverContext): Promise<DriverResult<"fork">>;
}

export type OutputEvent =
  | { type: "stdout" | "stderr"; data: Uint8Array; cursor?: string }
  | { type: "gap"; message: string }
  | { type: "exit"; exitCode: number | null; signal?: string };
export interface ProcessHandle {
  ref: { sandbox: SandboxRef; nativeId: string };
  output: AsyncIterable<OutputEvent>; // live, backpressured; replay support is explicit
  writeStdin(data: Uint8Array, options?: CallOptions): Promise<void>;
  closeStdin(options?: CallOptions): Promise<void>;
  wait(options?: CallOptions): Promise<{ exitCode: number | null; signal?: string }>;
  signal(signal: "SIGTERM" | "SIGKILL" | "SIGINT", options?: CallOptions): Promise<void>;
}
export interface ProcessApi {
  start(request: ExecRequest, options?: CallOptions): Promise<ProcessHandle>;
  attach(ref: ProcessHandle["ref"], cursor?: string, options?: CallOptions): Promise<ProcessHandle>;
}
export interface ProcessDriver {
  start(ref: SandboxRef, request: ExecRequest, context: DriverContext): Promise<ProcessHandle>;
  attach(ref: ProcessHandle["ref"], cursor: string | undefined, context: DriverContext): Promise<ProcessHandle>;
}
export interface TerminalHandle {
  output: AsyncIterable<Uint8Array>; // PTY combines stdout and stderr
  write(data: Uint8Array, options?: CallOptions): Promise<void>;
  resize(columns: number, rows: number, options?: CallOptions): Promise<void>;
  close(options?: CallOptions): Promise<void>;
}
export interface TerminalApi {
  open(options: { columns: number; rows: number; cwd?: string }, call?: CallOptions): Promise<TerminalHandle>;
}
export interface TerminalDriver {
  open(ref: SandboxRef, options: { columns: number; rows: number; cwd?: string }, context: DriverContext): Promise<TerminalHandle>;
}

/** Storage can belong to a different provider than the compute. */
export interface WorkspaceProvider {
  readonly id: string;
  readonly apiVersion: "sandbar.workspace.v1";
  create(context: DriverContext): Promise<WorkspaceRef>;
  inspect(ref: WorkspaceRef, context: DriverContext): Promise<{
    ref: WorkspaceRef;
    multiWriter: "unsupported" | "last-writer-wins" | "merge-disjoint";
    restrictions: string[];
  }>;
  checkpoint(ref: WorkspaceRef, context: DriverContext): Promise<WorkspaceVersion>;
  fork(version: WorkspaceVersionRef, context: DriverContext): Promise<WorkspaceRef>;
  delete(ref: WorkspaceRef, context: DriverContext): Promise<void>;
}
export interface MountBridge {
  readonly id: string;
  /** Read-only, pair-specific check: OS, runtime, permissions, network, mount protocol. */
  prepare(compute: { provider: string; environment: EnvironmentBinding }, mount: MountRequest,
    context: DriverContext): Promise<
      | { supported: true; prepared: PreparedMount; restrictions: string[] }
      | { supported: false; reasons: string[] }
    >;
}
