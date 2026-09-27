import { AdapterError } from "@sandbar/adapter";
import type { AdvancedOperationResult as RuntimeResult } from "sandbar-sdk/direct";
import type {
  ProviderDriver,
  ProviderLease,
  SandboxRef,
  NativeScope,
  DriverResult,
  InvocationIdentity,
} from "@sandbar/provider-spi";
import { ProviderReadError, validateDriverResult } from "@sandbar/provider-spi";
import type { ExecRequest } from "@sandbar/contracts";
import { ControlStore, type Claimed, type SandboxRow, type ConnectionRow } from "@sandbar/store";
import { SecretBox } from "./crypto";
import {
  ProviderConfigurationError,
  AdapterContractMismatchError,
  ProviderIdentityMismatchError,
  type ProviderRegistry,
  type AdapterProviderLease,
} from "./registry";
import {
  normalizeCreate,
  normalizeExec,
  outputLimit,
  correlateDriverResult,
  captureBoundedOutput,
} from "@sandbar/core";

function isAdapterLease(lease: ProviderLease | AdapterProviderLease): lease is AdapterProviderLease {
  return "adapterConnection" in lease;
}

export interface RunnerOptions {
  store: ControlStore;
  driver?: ProviderDriver;
  registry?: ProviderRegistry;
  secrets: SecretBox;
  pollMs?: number;
  owner?: string;
}

export class DurableRunner {
  readonly owner: string;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  constructor(private readonly options: RunnerOptions) {
    this.owner = options.owner ?? `runner_${crypto.randomUUID()}`;
  }
  start(): void {
    if (this.timer) return;

    const poll = () => {
      void this.tick().catch(() =>
        console.error("Durable runner poll failed; retrying on next interval"),
      );
    };

    this.timer = setInterval(poll, this.options.pollMs ?? 500);
    poll();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick(): Promise<boolean> {
    if (this.active) return false;
    this.active = true;

    try {
      await this.options.store.expireOutputs();
      const claim = await this.options.store.claimDue(this.owner);

      if (!claim) return false;
      await this.process(claim);

      return true;
    } finally {
      this.active = false;
    }
  }

  private async connection(connection: ConnectionRow): Promise<ProviderLease> {
    if (
      !this.options.driver ||
      connection.provider !== this.options.driver.name ||
      connection.status !== "verified" ||
      !connection.scope
    )
      throw new Error("Provider connection is unavailable");

    return {
      driver: this.options.driver,
      scope: {
        provider: connection.provider,
        connectionId: connection.id,
        accountId: connection.scope,
        region: "local",
      },
    };
  }
  private async process(claim: Claimed): Promise<void> {
    const { store } = this.options;
    const op = claim.operation;
    let lease: ProviderLease | AdapterProviderLease | undefined;

    try {
      const connection = await store.getConnection(op.project_id, op.connection_id);

      if (!connection || connection.status !== "verified" || !connection.scope)
        throw new Error("Provider connection is unavailable");

      try {
        lease = this.options.registry
          ? await this.options.registry.connect(connection)
          : await this.connection(connection);
      } catch (error) {
        if (
          !claim.observeOnly &&
          ((error instanceof ProviderReadError && error.code === "UNAUTHENTICATED") ||
            error instanceof ProviderIdentityMismatchError ||
            error instanceof ProviderConfigurationError ||
            error instanceof AdapterContractMismatchError)
        ) {
          await store.failWithoutEffect(claim, {
            code:
              error instanceof ProviderIdentityMismatchError
                ? "CONFLICT"
                : error instanceof ProviderConfigurationError || error instanceof AdapterContractMismatchError
                  ? "INVALID_ARGUMENT"
                  : "UNAUTHENTICATED",
            message: "Provider connection verification failed",
            effect: "none",
            retry: "never",
          });

          return;
        }

        throw error;
      }

      const { driver, scope } = lease;

      if (isAdapterLease(lease)) {
        await this.processAdapter(claim, lease);
        return;
      }

      if (claim.observeOnly) {
        // This path is read only even when the claim follows a process crash.
        const result = await driver.observe({
          scope,
          submissionId: op.provider_token,
          operationId: op.id,
        });

        if (result) await this.handleResult(claim, validateDriverResult(result), scope);
        else await store.reschedule(claim, "outcome_unknown", 5_000, "NO_OBSERVATION");

        return;
      }

      const key = await store.getInvocationKey(op.id);

      if (!key) throw new Error("Durable invocation identity is missing");

      const identity: InvocationIdentity = {
        projectId: op.project_id,
        operationId: op.id,
        invocationKey: key,
        submissionId: op.provider_token,
      };

      const box = await store.getSandbox(op.project_id, op.sandbox_id);

      if (!box) throw new Error("Sandbox record vanished");

      if (op.kind === "create") {
        const plan = normalizeCreate(JSON.parse(op.request_json));

        const preparation = await driver.prepare({
          scope,
          image: plan.image,
          networkPolicy: plan.networkPolicy,
          region: plan.region,
        });

        if (!preparation.supported || !preparation.effectiveImage) {
          await store.failWithoutEffect(claim, {
            code: "UNSUPPORTED",
            message: preparation.reason ?? "Provider cannot prepare this input",
            effect: "none",
            retry: "never",
          });

          return;
        }

        if (!(await store.beginSubmission(claim))) return;

        const result = await driver.create({
          scope,
          identity,
          image: preparation.effectiveImage,
          networkPolicy: plan.networkPolicy,
          labels: plan.labels,
        });

        await this.handleResult(claim, validateDriverResult(result), scope);
      } else if (op.kind === "exec") {
        if (!box.native_id) {
          await store.reschedule(claim, "waiting_for_sandbox", 2_000);

          return;
        }

        // SAFETY: admitExec persists this encrypted request envelope before dispatch.
        const envelope = JSON.parse(op.request_json) as {
          encryptedRequest: string;
        };

        const plan = normalizeExec(
          JSON.parse(
            await this.options.secrets.open(
              "execution-request",
              `${box.id}:${key}`,
              envelope.encryptedRequest,
            ),
          ),
        );

        const ref = this.ref(scope, box);

        if (!(await store.beginSubmission(claim))) return;

        const result = await driver.exec({
          sandbox: ref,
          identity,
          ...plan,
        });

        await this.handleResult(claim, validateDriverResult(result), scope);
      } else if (op.kind === "file_write") {
        if (!box.native_id) {
          await store.reschedule(claim, "waiting_for_sandbox", 2_000);

          return;
        }

        // SAFETY: admitFileWrite persists these fields before the runner reads them.
        const request = JSON.parse(op.request_json) as {
          path: string;
          overwrite: boolean;
          encryptedBytes: string;
        };

        const base64 = await this.options.secrets.open(
          "file-write-input",
          `${box.id}:${key}`,
          request.encryptedBytes,
        );

        const bytes = Uint8Array.from(Buffer.from(base64, "base64"));

        if (!(await store.beginSubmission(claim))) return;

        const result = await driver.writeFile({
          sandbox: this.ref(scope, box),
          identity,
          path: request.path,
          bytes,
          overwrite: request.overwrite,
        });

        await this.handleResult(claim, validateDriverResult(result), scope);
      } else {
        if (!box.native_id) {
          if (await store.completeDestroyWithoutNative(claim)) return;
          await store.reschedule(claim, "waiting_for_native_identity", 5_000);

          return;
        }

        if (!(await store.beginSubmission(claim))) return;

        const result = await driver.destroy({
          sandbox: this.ref(scope, box),
          identity,
        });

        await this.handleResult(claim, validateDriverResult(result), scope);
      }
    } catch {
      // Errors after possible submission are ambiguous. Never infer no effect from a thrown transport/decoder error.
      await store.reschedule(claim, "outcome_unknown", 5_000, "DRIVER_ERROR");
    } finally {
      if (lease?.ownership === "owned") {
        try {
          await lease.release();
        } catch {
          console.error("Provider transport release failed");
        }
      }
    }
  }
  private async processAdapter(claim: Claimed, lease: AdapterProviderLease): Promise<void> {
    const { store, secrets } = this.options;
    const op = claim.operation;
    const box = await store.getSandbox(op.project_id, op.sandbox_id);
    if (!box) throw new Error("Sandbox record vanished");

    if (claim.observeOnly) {
      let token: { version: number; token: unknown } | undefined;
      if (op.adapter_token_ciphertext) {
        const plaintext = await secrets.open("adapter-recovery-token", op.id, op.adapter_token_ciphertext);
        token = JSON.parse(plaintext);
      }
      const result = await lease.adapterConnection.operations.observe({
        kind: op.kind,
        operationId: op.id,
        submissionId: op.provider_token,
        sandboxId: op.kind === "create" ? undefined : box.native_id ?? undefined,
        token: token?.token as never,
        tokenVersion: token?.version,
      });
      await this.handleAdapterResult(claim, lease.scope, result);
      return;
    }

    const key = await store.getInvocationKey(op.id);
    if (!key) throw new Error("Durable invocation identity is missing");
    if (op.kind !== "create" && !box.native_id) {
      if (op.kind === "destroy" && await store.completeDestroyWithoutNative(claim)) return;
      await store.reschedule(claim, "waiting_for_sandbox", 2_000);
      return;
    }

    let input: unknown;
    if (op.kind === "create") {
      const plan = normalizeCreate(JSON.parse(op.request_json));
      input = { image: plan.image, networkPolicy: plan.networkPolicy, region: plan.region, labels: plan.labels };
    } else if (op.kind === "exec") {
      const envelope = JSON.parse(op.request_json) as { encryptedRequest: string };
      const plan = normalizeExec(JSON.parse(await secrets.open(
        "execution-request", `${box.id}:${key}`, envelope.encryptedRequest,
      )));
      input = { sandbox: { id: box.native_id! }, ...plan };
    } else if (op.kind === "file_write") {
      const request = JSON.parse(op.request_json) as {
        path: string; overwrite: boolean; encryptedBytes: string;
      };
      const base64 = await secrets.open("file-write-input", `${box.id}:${key}`, request.encryptedBytes);
      input = {
        sandbox: { id: box.native_id! },
        path: request.path,
        overwrite: request.overwrite,
        bytes: Uint8Array.from(Buffer.from(base64, "base64")),
      };
    } else {
      input = { id: box.native_id! };
    }

    let prepared;
    try {
      prepared = await lease.adapterConnection.operations.prepare(op.kind, input, {
        maxOutputBytes: op.kind === "exec" ? (input as { maxOutputBytes: number }).maxOutputBytes : undefined,
      });
    } catch (error) {
      if (error instanceof AdapterError && ["INVALID_ARGUMENT", "UNSUPPORTED", "CAPACITY", "CONFLICT"].includes(error.code)) {
        await store.failWithoutEffect(claim, {
          code: error.code,
          message: "Adapter cannot prepare this request",
          effect: "none",
          retry: "never",
        });
      } else {
        await store.reschedule(claim, "prepare_failed", 5_000, "ADAPTER_PREPARE_FAILED");
      }
      return;
    }

    const result = await prepared.submit({
      operationId: op.id,
      submissionId: op.provider_token,
      invocationKey: key,
    }, { beforeSubmit: () => store.beginSubmission(claim) });
    if (result) await this.handleAdapterResult(claim, lease.scope, result);
  }

  private async handleAdapterResult(
    claim: Claimed,
    scope: NativeScope,
    result: RuntimeResult | null,
  ): Promise<void> {
    const { store, secrets } = this.options;
    const op = claim.operation;
    if (!result) {
      await store.reschedule(claim, "outcome_unknown", 5_000, "NO_OBSERVATION");
      return;
    }
    if (result.kind === "pending") {
      const ciphertext = await secrets.seal(
        "adapter-recovery-token", op.id,
        JSON.stringify({ version: result.version, token: result.token }),
      );
      await store.reschedule(claim, "awaiting_observation", Math.max(500, result.pollAfterMs), undefined, true, ciphertext);
      return;
    }
    if (result.kind === "unknown") {
      await store.reschedule(claim, "outcome_unknown", 5_000, "ADAPTER_UNKNOWN");
      return;
    }
    if (result.kind === "rejected") {
      if (claim.observeOnly) {
        await store.reschedule(claim, "outcome_unknown", 5_000, "UNCORRELATED_REJECTION");
        return;
      }
      await store.failWithoutEffect(claim, {
        code: result.code,
        message: "Adapter rejected the request before acceptance",
        effect: "none",
        retry: "never",
      }, true);
      return;
    }

    const value = result.value;
    const observedAt = new Date().toISOString();
    let wrapped: DriverResult;
    if (op.kind === "create" && "id" in value) {
      wrapped = {
        status: "completed", effect: "applied", submissionId: op.provider_token,
        value: { kind: "sandbox", observation: {
          ref: { kind: "sandbox", scope, nativeId: value.id },
          state: value.state, observedAt,
        } },
      };
    } else if (op.kind === "destroy" && "computeStopped" in value) {
      wrapped = {
        status: "completed", effect: value.computeStopped ? "applied" : "partial",
        submissionId: op.provider_token,
        value: { kind: "destroy", observation: {
          sandbox: this.ref(scope, (await store.getSandbox(op.project_id, op.sandbox_id))!),
          computeStopped: value.computeStopped,
          retainedResources: value.retainedResources,
        } },
      };
    } else if (op.kind === "exec" && "stdout" in value &&
               value.stdout instanceof Uint8Array && value.stderr instanceof Uint8Array) {
      const box = await store.getSandbox(op.project_id, op.sandbox_id);
      if (!box) throw new Error("Sandbox record vanished");
      const sandbox = this.ref(scope, box);
      wrapped = {
        status: "completed", effect: "applied", submissionId: op.provider_token,
        value: { kind: "execution", observation: {
          ref: { kind: "execution", scope, nativeId: op.provider_token },
          sandbox, completed: true, exitCode: value.exitCode,
          stdoutBase64: Buffer.from(value.stdout).toString("base64"),
          stderrBase64: Buffer.from(value.stderr).toString("base64"),
          truncated: value.truncated, observedAt,
        } },
      };
    } else if (op.kind === "file_write" && "bytesWritten" in value) {
      const box = await store.getSandbox(op.project_id, op.sandbox_id);
      if (!box) throw new Error("Sandbox record vanished");
      const request = JSON.parse(op.request_json) as { path: string; bytes: number };
      wrapped = {
        status: "completed", effect: "applied", submissionId: op.provider_token,
        value: { kind: "file_write", observation: {
          sandbox: this.ref(scope, box), path: request.path,
          bytesWritten: value.bytesWritten, complete: value.bytesWritten === request.bytes,
        } },
      };
    } else {
      throw new Error("Adapter completion mismatches operation kind");
    }
    await this.handleResult(claim, wrapped, scope);
  }

  private ref(scope: NativeScope, box: SandboxRow): SandboxRef {
    if (!box.native_id) throw new Error("Native identity unavailable");

    return { scope, nativeId: box.native_id, kind: "sandbox" };
  }
  private async handleResult(
    claim: Claimed,
    result: DriverResult,
    scope: NativeScope,
  ): Promise<void> {
    const { store, secrets } = this.options;

    if (result.status !== "completed") {
      correlateDriverResult(result, {
        submissionId: claim.operation.provider_token,
        kind: claim.operation.kind,
        scope,
        requireSubmissionId: claim.observeOnly,
      });
    }

    if (result.status === "pending") {
      await store.reschedule(
        claim,
        "awaiting_observation",
        Math.max(500, result.observeAfterMs),
        undefined,
        true,
      );

      return;
    }

    if (result.status === "unknown") {
      await store.reschedule(claim, "outcome_unknown", 5_000, "PROVIDER_UNKNOWN");

      return;
    }

    if (result.status === "rejected") {
      if (claim.observeOnly) {
        await store.reschedule(claim, "outcome_unknown", 5_000, "UNCORRELATED_REJECTION");

        return;
      }

      const errors = {
        invalid: ["INVALID_ARGUMENT", "Provider rejected the request as invalid"],
        unsupported: ["UNSUPPORTED", "Provider does not support this request"],
        unauthorized: ["UNAUTHENTICATED", "Provider authentication failed"],
        not_found: ["NOT_FOUND", "Provider resource was not found"],
        conflict: ["CONFLICT", "Provider reported a conflict"],
        capacity: ["CAPACITY", "Provider capacity is unavailable"],
        rate_limit: ["RATE_LIMIT", "Provider rate limit was reached"],
        unavailable: ["UNAVAILABLE", "Provider is unavailable"],
        timeout: ["TIMEOUT", "Provider request timed out"],
        internal: ["INTERNAL", "Provider could not complete the request"],
      } as const;

      const [code, message] = errors[result.error.code];
      const error = { code, message, effect: "none", retry: "never" };
      await store.failWithoutEffect(claim, error, true);

      return;
    }

    const box = await store.getSandbox(claim.operation.project_id, claim.operation.sandbox_id);

    if (!box) throw new Error("Sandbox identity missing");

    // SAFETY: admission stores the path and byte count used to correlate file receipts.
    const file =
      claim.operation.kind === "file_write"
        ? (JSON.parse(claim.operation.request_json) as {
            path: string;
            bytes: number;
          })
        : undefined;

    correlateDriverResult(result, {
      submissionId: claim.operation.provider_token,
      kind: claim.operation.kind,
      scope,
      sandbox: box.native_id ? this.ref(scope, box) : undefined,
      file,
      requireSubmissionId: claim.observeOnly,
    });
    const value = result.value;

    if (value.kind === "destroy") {
      if (!value.observation.computeStopped) {
        await store.reschedule(claim, "cleanup_unconfirmed", 5_000, "COMPUTE_NOT_STOPPED");

        return;
      }
    }

    if (value.kind === "file_write") {
      if (!value.observation.complete || value.observation.bytesWritten !== file!.bytes) {
        await store.reschedule(claim, "file_write_unconfirmed", 5_000, "INCOMPLETE_FILE_WRITE");

        return;
      }
    }

    if (value.kind === "execution") {
      if (!value.observation.completed) {
        await store.reschedule(claim, "execution_running", 1_000, undefined, true);

        return;
      }

      // SAFETY: the submission marker retains bounded output options after the secret request is cleared.
      const retained = JSON.parse(claim.operation.request_json) as Pick<ExecRequest, "output">;

      const output = captureBoundedOutput(
        value.observation.stdoutBase64,
        value.observation.stderrBase64,
        outputLimit(retained.output),
      );

      const encryptedOutput = output.bytes
        ? await secrets.seal(
            "execution-output",
            claim.operation.execution_id!,
            JSON.stringify(output.payload),
          )
        : undefined;

      const {
        stdoutBase64: _stdout,
        stderrBase64: _stderr,
        ...safeObservation
      } = value.observation;

      await store.complete(claim, {
        effect: result.effect,
        value: { kind: "execution", observation: safeObservation },
        observedAt: Date.parse(value.observation.observedAt),
        encryptedOutput,
        outputBytes: output.bytes,
        outputTruncated: output.truncated || !!value.observation.truncated,
      });
    } else {
      await store.complete(claim, {
        effect: result.effect,
        value,
        observedAt: value.kind === "sandbox" ? Date.parse(value.observation.observedAt) : undefined,
      });
    }
  }
}
