---
title: Generated TypeScript API index
description: Exported API names generated from the built package declarations.
---

> Generated from the package declaration files. Run `bun run --cwd apps/docs typescript:generate` after building packages. The [TypeScript SDK reference](/docs/reference/typescript/) explains behavior and recovery guarantees.

## SDK

Import from `sandbar-sdk`.

| Export                      | Kind      |
| --------------------------- | --------- |
| `ADAPTER_CONTRACT_VERSION`  | re-export |
| `AdapterCapabilities`       | type      |
| `AdapterConnectOptions`     | type      |
| `AdapterDirectClient`       | re-export |
| `AdapterOperation`          | re-export |
| `AdapterRecoveryReference`  | type      |
| `AdapterSandbox`            | re-export |
| `AdapterSnapshot`           | re-export |
| `AdapterVolume`             | re-export |
| `AdvancedIdentity`          | type      |
| `AdvancedObservation`       | type      |
| `AdvancedOperationKind`     | type      |
| `AdvancedOperationResult`   | type      |
| `ArtifactDeletionResult`    | re-export |
| `assertResourceIdentity`    | re-export |
| `assertResourceScope`       | re-export |
| `Capabilities`              | type      |
| `CreateInput`               | type      |
| `CreatePlan`                | type      |
| `Deadline`                  | type      |
| `diagnosticContext`         | re-export |
| `DiagnosticContext`         | type      |
| `DirectCapabilities`        | type      |
| `DirectConnectOptions`      | type      |
| `DirectoryResult`           | type      |
| `DirectSandbarClient`       | type      |
| `DirectSandboxHandle`       | type      |
| `ExecInput`                 | type      |
| `ExecOutput`                | type      |
| `Fact`                      | type      |
| `FileEntry`                 | type      |
| `FileReadOptions`           | type      |
| `FileStat`                  | type      |
| `FileStreamOptions`         | type      |
| `FileStreamWriteOptions`    | type      |
| `FilesystemError`           | re-export |
| `FileWriteOptions`          | type      |
| `Image`                     | re-export |
| `ImageBuildResult`          | type      |
| `ImageInput`                | type      |
| `MountCapabilities`         | type      |
| `MountSpec`                 | re-export |
| `NoExitCodeError`           | re-export |
| `NonzeroExitError`          | re-export |
| `ObservabilityOptions`      | type      |
| `OperationHandle`           | type      |
| `OperationOutcome`          | type      |
| `OutcomeUnknownError`       | re-export |
| `OutputPreview`             | type      |
| `outputText`                | re-export |
| `PreparedAdapterAttempt`    | re-export |
| `PreparedImage`             | type      |
| `Preview`                   | type      |
| `ProcessExit`               | type      |
| `ProcessFailure`            | type      |
| `ProcessHandle`             | type      |
| `ProcessOutput`             | type      |
| `ProcessTermination`        | type      |
| `ReadOptions`               | type      |
| `RecoveredOperation`        | type      |
| `RecoveryReference`         | type      |
| `RenewRequest`              | type      |
| `RenewResult`               | type      |
| `ResourceKind`              | re-export |
| `ResourceReference`         | re-export |
| `RestoreCapabilities`       | type      |
| `RestoreRequest`            | re-export |
| `ResumeResult`              | type      |
| `Sandbar`                   | value     |
| `SandbarClient`             | type      |
| `SandbarError`              | re-export |
| `SandboxHandle`             | type      |
| `SandboxInfo`               | type      |
| `SandboxReference`          | type      |
| `SandboxState`              | type      |
| `SnapshotInfo`              | re-export |
| `SnapshotPlan`              | type      |
| `SnapshotProfile`           | type      |
| `SnapshotRequest`           | re-export |
| `SnapshotRequirements`      | re-export |
| `SnapshotResult`            | type      |
| `StartProcessInput`         | type      |
| `Support`                   | type      |
| `SuspendResult`             | type      |
| `TransferPolicy`            | type      |
| `UnsupportedFeatureError`   | re-export |
| `validateResourceReference` | re-export |
| `VolumeCapabilities`        | type      |
| `VolumeCreateInput`         | re-export |
| `VolumeInfo`                | re-export |
| `WaitAbortedError`          | re-export |
| `WaitOptions`               | type      |

## Daytona adapter

Import from `sandbar-sdk/daytona`.

| Export    | Kind     |
| --------- | -------- |
| `daytona` | function |

## E2B adapter

Import from `sandbar-sdk/e2b`.

| Export             | Kind      |
| ------------------ | --------- |
| `createE2BAdapter` | function  |
| `e2b`              | function  |
| `E2BTransport`     | interface |

## Experimental Modal adapter

Import from `sandbar-modal`.

| Export               | Kind      |
| -------------------- | --------- |
| `createModalAdapter` | re-export |
| `MODAL_ENDPOINT`     | re-export |
| `modalAdapter`       | re-export |
| `ModalTransport`     | type      |

## Adapter authoring

Import from `sandbar-adapter`.

| Export                         | Kind      |
| ------------------------------ | --------- |
| `AdapterCheckpointError`       | class     |
| `AdapterConnection`            | type      |
| `AdapterDefinition`            | type      |
| `AdapterError`                 | re-export |
| `AdapterErrorCode`             | type      |
| `AdapterFilesystemError`       | re-export |
| `AdapterSession`               | type      |
| `AttemptContext`               | type      |
| `Command`                      | type      |
| `connectAdapter`               | function  |
| `continueOperation`            | re-export |
| `createAttemptContext`         | function  |
| `CreateInput`                  | type      |
| `createObserveContext`         | function  |
| `CreateSandboxInput`           | re-export |
| `CreateValue`                  | type      |
| `defineAdapter`                | function  |
| `DestroyValue`                 | type      |
| `DirectoryResult`              | type      |
| `ExecCommand`                  | re-export |
| `ExecInput`                    | type      |
| `ExecRequest`                  | re-export |
| `ExecValue`                    | type      |
| `FileEntry`                    | type      |
| `FileMutationInput`            | type      |
| `FileMutationIntent`           | re-export |
| `FileMutationValue`            | re-export |
| `FileStat`                     | type      |
| `FileTransferContext`          | type      |
| `FileTransferInput`            | type      |
| `FileWriteInput`               | type      |
| `FileWriteValue`               | type      |
| `Guarantees`                   | type      |
| `HostContext`                  | type      |
| `Image`                        | type      |
| `ImageBuildInput`              | type      |
| `ImageBuildValue`              | type      |
| `isOutcome`                    | function  |
| `Json`                         | type      |
| `MAX_DIRECTORY_ENTRIES`        | re-export |
| `MAX_DIRECTORY_NAME_BYTES`     | re-export |
| `MAX_EXEC_STDIN_BYTES`         | re-export |
| `Mutation`                     | type      |
| `NativeProcess`                | interface |
| `NativeProcessExit`            | type      |
| `ObserveContext`               | type      |
| `observeOperation`             | re-export |
| `OperationInput`               | type      |
| `OperationKind`                | type      |
| `OperationOutcome`             | re-export |
| `operationParts`               | function  |
| `OperationParts`               | type      |
| `outcomeKind`                  | function  |
| `Pending`                      | type      |
| `PolicyAdapterDefinition`      | type      |
| `PreparedOperation`            | type      |
| `prepareOperation`             | re-export |
| `ProcessObservationFailure`    | type      |
| `ProcessOutput`                | type      |
| `ProcessStartContext`          | type      |
| `ProcessStartInput`            | type      |
| `ReadContext`                  | type      |
| `RecoveryAttempt`              | type      |
| `RecoveryResource`             | type      |
| `Rejected`                     | type      |
| `RetainedArtifact`             | type      |
| `RuntimeResult`                | type      |
| `RuntimeSession`               | type      |
| `SafeError`                    | re-export |
| `Sandbox`                      | type      |
| `Scope`                        | type      |
| `submitOperation`              | re-export |
| `Unknown`                      | type      |
| `validateAdapterConfiguration` | function  |

## Adapter test kit

Import from `sandbar-adapter/testing`.

| Export                | Kind     |
| --------------------- | -------- |
| `adapterSuite`        | function |
| `AdapterSuiteFixture` | type     |
| `AdapterSuiteReport`  | type     |
| `filesystemSuite`     | function |
