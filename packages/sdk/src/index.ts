import { connectDirect } from "./adapter-direct";

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
  AdapterCapabilities,
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
  OutcomeUnknownError,
  WaitAbortedError,
  NonzeroExitError,
  NoExitCodeError,
} from "./resource";

export type {
  ImageInput,
  CreateInput,
  ExecInput,
  ExecOutput,
  SandboxHandle,
  OperationHandle,
  RecoveryReference,
  SandbarClient,
} from "./resource";
