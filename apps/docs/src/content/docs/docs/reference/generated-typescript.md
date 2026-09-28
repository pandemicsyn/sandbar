---
title: Generated TypeScript API index
description: Exported API names generated from the built package declarations.
---

> Generated from the package declaration files. Run `bun run --cwd apps/docs typescript:generate` after building packages. The [TypeScript SDK reference](/docs/reference/typescript/) explains behavior and recovery guarantees.

## SDK

Import from `sandbar-sdk`.

| Export                     | Kind      |
| -------------------------- | --------- |
| `ADAPTER_CONTRACT_VERSION` | re-export |
| `AdapterCapabilities`      | type      |
| `AdapterConnectOptions`    | type      |
| `AdapterDirectClient`      | re-export |
| `AdapterOperation`         | re-export |
| `AdapterRecoveryReference` | type      |
| `AdapterSandbox`           | re-export |
| `AdvancedIdentity`         | type      |
| `AdvancedObservation`      | type      |
| `AdvancedOperationKind`    | type      |
| `AdvancedOperationResult`  | type      |
| `CreateInput`              | type      |
| `ExecInput`                | type      |
| `ExecOutput`               | type      |
| `Image`                    | re-export |
| `ImageBuildResult`         | type      |
| `ImageInput`               | type      |
| `NoExitCodeError`          | re-export |
| `NonzeroExitError`         | re-export |
| `OperationHandle`          | type      |
| `OutcomeUnknownError`      | re-export |
| `outputText`               | re-export |
| `PreparedAdapterAttempt`   | re-export |
| `PreparedImage`            | type      |
| `RecoveryReference`        | type      |
| `Sandbar`                  | value     |
| `SandbarClient`            | type      |
| `SandbarError`             | re-export |
| `SandboxHandle`            | type      |
| `WaitAbortedError`         | re-export |

## Daytona adapter

Import from `sandbar-sdk/daytona`.

| Export    | Kind     |
| --------- | -------- |
| `daytona` | function |

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
| `AdapterConnection`            | type      |
| `AdapterDefinition`            | type      |
| `AdapterError`                 | class     |
| `AdapterErrorCode`             | type      |
| `AdapterSession`               | type      |
| `AttemptContext`               | type      |
| `Command`                      | type      |
| `connectAdapter`               | function  |
| `createAttemptContext`         | function  |
| `CreateInput`                  | type      |
| `createObserveContext`         | function  |
| `CreateSandboxInput`           | re-export |
| `CreateValue`                  | type      |
| `defineAdapter`                | function  |
| `DestroyValue`                 | type      |
| `ExecCommand`                  | re-export |
| `ExecInput`                    | type      |
| `ExecRequest`                  | re-export |
| `ExecValue`                    | type      |
| `FileWriteInput`               | type      |
| `FileWriteValue`               | type      |
| `Guarantees`                   | type      |
| `HostContext`                  | type      |
| `Image`                        | type      |
| `ImageBuildInput`              | type      |
| `ImageBuildValue`              | type      |
| `isOutcome`                    | function  |
| `Json`                         | type      |
| `Mutation`                     | type      |
| `ObserveContext`               | type      |
| `observeOperation`             | re-export |
| `OperationKind`                | type      |
| `operationParts`               | function  |
| `OperationParts`               | type      |
| `outcomeKind`                  | function  |
| `Pending`                      | type      |
| `PolicyAdapterDefinition`      | type      |
| `PreparedOperation`            | type      |
| `prepareOperation`             | re-export |
| `ReadContext`                  | type      |
| `RecoveryAttempt`              | type      |
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

## Service host

Import from `sandbar-service`.

| Export           | Kind     |
| ---------------- | -------- |
| `createService`  | function |
| `ServiceAdapter` | type     |
| `ServiceHandle`  | type     |
| `ServiceOptions` | type     |

## Service HTTP client

Import from `sandbar-service/client`.

| Export                | Kind      |
| --------------------- | --------- |
| `CreateInput`         | type      |
| `ExecInput`           | type      |
| `ExecOutput`          | type      |
| `Image`               | re-export |
| `NoExitCodeError`     | re-export |
| `NonzeroExitError`    | re-export |
| `OperationHandle`     | type      |
| `OutcomeUnknownError` | re-export |
| `outputText`          | re-export |
| `RecoveryReference`   | type      |
| `RemoteClient`        | class     |
| `RemoteOptions`       | type      |
| `Sandbar`             | value     |
| `SandbarError`        | re-export |
| `SandboxHandle`       | type      |
| `WaitAbortedError`    | re-export |
