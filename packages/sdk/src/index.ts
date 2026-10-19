import { connectDirect } from "./adapter-direct";

export type {
  StartProcessInput,
  ProcessOutput,
  ProcessOutputBytes,
  ProcessOutputFormat,
  ProcessChunk,
  ProcessExit,
  ProcessStatus,
  ProcessTermination,
  ProcessHandle,
  ProcessReference,
  ProcessSignal,
  TerminalDimensions,
  StartTerminalInput,
  TerminalHandle,
  ProcessFailure,
  ExecOptions,
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
  ConnectOptions,
  CloseOptions,
  AdapterCapabilities,
  RecoveredOperation,
  AdvancedOperationResult,
  AdvancedOperationKind,
  AdvancedIdentity,
  AdvancedObservation,
  SandboxInfo,
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
  NetworkPolicy,
  ExecInput,
  ExecOutput,
  OutputPreview,
  DirectSandbarClient,
  DirectSandboxHandle,
  SandboxHandle,
  SnapshotHandle,
  ImageHandle,
  VolumeHandle,
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
} from "@sandbar-sdk/adapter";

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
  Preview,
  Fact,
  Deadline,
  ResourceMinimums,
  SandboxResources,
  CreatePlan,
} from "@sandbar-sdk/adapter";

export { AdapterSnapshot, AdapterVolume, AdapterImage } from "./resources";

export type {
  SnapshotResult,
  WaitOptions,
  RestoreInput,
  SandboxList,
  SandboxListEntry,
  SandboxListInput,
} from "./resources";

export {
  MountSpec,
  SnapshotInfo,
  ImageInfo,
  VolumeInfo,
  RestoreRequest,
  VolumeCreateInput,
  ArtifactDeletionResult,
} from "@sandbar-sdk/adapter";

export type {
  MountCapabilities,
  VolumeCapabilities,
  RestoreCapabilities,
} from "@sandbar-sdk/adapter";

export { diagnosticContext } from "./observability";

export type { ObservabilityOptions, DiagnosticContext } from "./observability";

export { FilesystemError } from "./file-transfer";

export type {
  FileReadOptions,
  FileWriteOptions,
  FileStreamOptions,
  FileStreamWriteOptions,
  TransferPolicy,
} from "./file-transfer";

export type { FileEntry, DirectoryResult, FileStat } from "@sandbar-sdk/adapter";

export type {
  WalkFilesOptions,
  WalkFileEntry,
  ReadTextLinesOptions,
} from "./filesystem-extensions";

export { createProcessTail, readProcessLines } from "./process-output";

export type {
  ProcessTail,
  ProcessTailOptions,
  ProcessLine,
  ProcessLineOptions,
} from "./process-output";

export { SandboxCleanupError } from "./scoped-sandbox";

export type { SandboxScopeOptions, SandboxScopeCallbackOutcome } from "./scoped-sandbox";
