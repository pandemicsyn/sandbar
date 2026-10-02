import { connectDirect } from "./adapter-direct";

export type {
  StartProcessInput,
  ProcessOutput,
  ProcessExit,
  ProcessTermination,
  ProcessHandle,
  ProcessFailure,
} from "./processes";

export {
  AdapterDirectClient,
  AdapterSandbox,
  AdapterOperation,
  PreparedAdapterAttempt,
  ADAPTER_CONTRACT_VERSION,
} from "./adapter-direct";

export type {
  AdapterRecoveryReference,
  AdapterConnectOptions,
  DirectConnectOptions,
  AdapterCapabilities,
  RecoveredOperation,
  AdvancedOperationResult,
  AdvancedOperationKind,
  AdvancedIdentity,
  AdvancedObservation,
} from "./adapter-direct";

export const Sandbar = { connect: connectDirect };

export {
  Image,
  outputText,
  SandbarError,
  UnsupportedFeatureError,
  OutcomeUnknownError,
  WaitAbortedError,
  NonzeroExitError,
  NoExitCodeError,
} from "./resource";

export type {
  ImageInput,
  PreparedImage,
  ImageBuildResult,
  CreateInput,
  ExecInput,
  ExecOutput,
  OutputPreview,
  DirectSandbarClient,
  DirectSandboxHandle,
  SandboxHandle,
  ReadOptions,
  OperationHandle,
  RecoveryReference,
  SandbarClient,
} from "./resource";

export {
  ResourceReference,
  ResourceKind,
  validateResourceReference,
  assertResourceScope,
  assertResourceIdentity,
  SnapshotRequest,
  SnapshotRequirements,
} from "sandbar-adapter";

export type {
  Support,
  Capabilities,
  DirectCapabilities,
  OperationOutcome,
  SnapshotPlan,
  SnapshotProfile,
  SandboxState,
  SandboxReference,
  SuspendResult,
  ResumeResult,
  RenewRequest,
  RenewResult,
  SandboxInfo,
  Preview,
  Fact,
  Deadline,
  CreatePlan,
} from "sandbar-adapter";

export { AdapterSnapshot, AdapterVolume } from "./resources";

export type { SnapshotResult, WaitOptions } from "./resources";

export {
  MountSpec,
  SnapshotInfo,
  VolumeInfo,
  RestoreRequest,
  VolumeCreateInput,
  ArtifactDeletionResult,
} from "sandbar-adapter";

export type { MountCapabilities, VolumeCapabilities, RestoreCapabilities } from "sandbar-adapter";

export { diagnosticContext } from "./observability";

export type { ObservabilityOptions, DiagnosticContext } from "./observability";

export type { FileEntry } from "sandbar-adapter";
