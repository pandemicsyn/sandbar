import { connectDirect } from "./adapter-direct";
export {
  AdapterDirectClient, AdapterSandbox, AdapterOperation, PreparedAdapterAttempt,
  ADAPTER_CONTRACT_VERSION,
} from "./adapter-direct";
export type {
  AdapterRecoveryReference, AdapterConnectOptions, AdapterCapabilities,
  AdvancedOperationResult, AdvancedOperationKind, AdvancedIdentity, AdvancedObservation,
} from "./adapter-direct";
export {
  Image, SandbarError, OutcomeUnknownError, WaitAbortedError,
  NonzeroExitError, NoExitCodeError, outputText,
} from "./resource";
export type {
  CreateInput, ExecInput, ExecOutput, OperationHandle,
  RecoveryReference, SandboxHandle,
} from "./resource";

export const Sandbar = { connect: connectDirect };
