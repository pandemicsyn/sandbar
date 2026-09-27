import type {
  ProviderDriver,
  SandboxRef,
  NativeScope,
  DriverResult,
  InvocationIdentity,
} from "@sandbar/provider-spi";
import { validateDriverResult } from "@sandbar/provider-spi";
import type { ExecRequest } from "@sandbar/contracts";
import { ControlStore, type Claimed, type SandboxRow, type ConnectionRow } from "@sandbar/store";
import { SecretBox } from "./crypto";
import {
  normalizeCreate,
  normalizeExec,
  outputLimit,
  correlateDriverResult,
  captureBoundedOutput,
} from "@sandbar/core";

export interface RunnerOptions {
  store: ControlStore;
  driver: ProviderDriver;
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

  private scope(connection: ConnectionRow): NativeScope {
    if (
      connection.provider !== this.options.driver.name ||
      connection.status !== "verified" ||
      !connection.scope
    )
      throw new Error("Provider connection is unavailable");

    return {
      provider: connection.provider,
      connectionId: connection.id,
      accountId: connection.scope,
      region: "local",
    };
  }
  private async process(claim: Claimed): Promise<void> {
    const { store, driver } = this.options;
    const op = claim.operation;

    try {
      const connection = await store.getConnection(op.project_id, op.connection_id);

      if (!connection) throw new Error("Provider connection vanished");
      const scope = this.scope(connection);

      if (claim.observeOnly) {
        // This path is read only even when the claim follows a process crash.
        const result = await driver.observe({ scope, submissionId: op.provider_token });

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
        const envelope = JSON.parse(op.request_json) as { encryptedRequest: string };

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
        const result = await driver.destroy({ sandbox: this.ref(scope, box), identity });
        await this.handleResult(claim, validateDriverResult(result), scope);
      }
    } catch {
      // Errors after possible submission are ambiguous. Never infer no effect from a thrown transport/decoder error.
      await store.reschedule(claim, "outcome_unknown", 5_000, "DRIVER_ERROR");
    }
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
        ? (JSON.parse(claim.operation.request_json) as { path: string; bytes: number })
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
