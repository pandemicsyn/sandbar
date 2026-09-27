import { sql, type SQL } from "drizzle-orm";
import type { Backend, QueryConnection } from "./backend";

export class StoreError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "CONFLICT"
      | "CAPACITY"
      | "OUTPUT_CAPACITY"
      | "INVOCATION_EXPIRED"
      | "UNAUTHENTICATED",
    message: string,
  ) {
    super(message);
  }
}

export type Kind = "create" | "exec" | "destroy" | "file_write";

export type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "unknown";

type CreateIntent = { environment: object; network?: object; labels?: Record<string, string> };

type OperationFailure = {
  code: string;
  message: string;
  effect: string;
  retry: string;
  retryAfterSeconds?: number;
};

export interface ConnectionRow {
  id: string;
  project_id: string;
  provider: string;
  name: string;
  scope: string | null;
  encrypted_credentials: string;
  credential_revision: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface SandboxRow {
  id: string;
  project_id: string;
  connection_id: string;
  native_id: string | null;
  desired_state: string;
  observed_state: string;
  observed_at: number | null;
  observation_error: string | null;
  revision: number;
  create_operation_id: string;
  labels_json: string;
  created_at: number;
  updated_at: number;
}

export interface OperationRow {
  id: string;
  project_id: string;
  kind: Kind;
  sandbox_id: string;
  execution_id: string | null;
  connection_id: string;
  status: OperationStatus;
  phase: string;
  effect: string;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  provider_token: string;
  submission_possible: number;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  observed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ExecutionRow {
  id: string;
  project_id: string;
  sandbox_id: string;
  operation_id: string;
  status: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: number | null;
  output_state: string;
  output_bytes: number;
  output_truncated: number;
  output_ciphertext: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface Admission {
  operation: OperationRow;
  sandbox: SandboxRow;
  execution?: ExecutionRow;
  repeated: boolean;
}

export interface Claimed {
  operation: OperationRow;
  attemptId: string;
  generation: number;
  observeOnly: boolean;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): number {
  return Date.now();
}

function parseJson<T>(value: string): T {
  // SAFETY: Callers select the shape persisted by this store for the named row field.
  return JSON.parse(value) as T;
}

function uuidV7Millis(key: string): number {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
    key,
  );

  if (!match) throw new StoreError("CONFLICT", "Idempotency-Key must be UUIDv7");

  return Number.parseInt(match[1] + match[2], 16);
}

export class ControlStore {
  constructor(readonly backend: Backend) {}
  close(): Promise<void> {
    return this.backend.close();
  }

  async setupOperator(
    tokenHash: string,
    sessionIdHash: string,
    csrfHash: string,
    expiresAt: number,
  ): Promise<void> {
    try {
      await this.backend.transaction(async (tx) => {
        const createdAt = now();

        await tx.run(
          sql`INSERT INTO operators (id,token_hash,created_at) VALUES ('operator',${tokenHash},${createdAt})`,
        );
        await tx.run(
          sql`INSERT INTO sessions (id_hash,operator_id,csrf_hash,expires_at,created_at) VALUES (${sessionIdHash},'operator',${csrfHash},${expiresAt},${createdAt})`,
        );
      });
    } catch (error) {
      if (!(await this.hasOperator())) throw error;
      throw new StoreError("CONFLICT", "Operator setup has already completed");
    }
  }
  async hasOperator(): Promise<boolean> {
    return !!(await this.backend.row(sql`SELECT id FROM operators WHERE id='operator'`));
  }
  async authenticateBearer(tokenHash: string): Promise<boolean> {
    return !!(await this.backend.row(
      sql`SELECT id FROM operators WHERE id='operator' AND token_hash=${tokenHash}`,
    ));
  }
  async createSession(idHash: string, csrfHash: string, expiresAt: number): Promise<void> {
    await this.backend.run(
      sql`INSERT INTO sessions (id_hash,operator_id,csrf_hash,expires_at,created_at) VALUES (${idHash},'operator',${csrfHash},${expiresAt},${now()})`,
    );
  }
  async getSession(idHash: string): Promise<{ csrf_hash: string; expires_at: number } | undefined> {
    return this.backend.row(
      sql`SELECT csrf_hash,expires_at FROM sessions WHERE id_hash=${idHash} AND expires_at>${now()}`,
    );
  }
  async deleteSession(idHash: string): Promise<void> {
    await this.backend.run(sql`DELETE FROM sessions WHERE id_hash=${idHash}`);
  }

  async createProject(name: string): Promise<{ id: string; name: string; createdAt: string }> {
    const projectId = id("prj"),
      created = now();

    await this.backend.run(
      sql`INSERT INTO projects (id,name,created_at) VALUES (${projectId},${name},${created})`,
    );

    return { id: projectId, name, createdAt: new Date(created).toISOString() };
  }
  async listProjects(): Promise<{ id: string; name: string; createdAt: string }[]> {
    const rows = await this.backend.rows<{ id: string; name: string; created_at: number }>(
      sql`SELECT id,name,created_at FROM projects ORDER BY created_at,id`,
    );

    return rows.map((x) => ({
      id: x.id,
      name: x.name,
      createdAt: new Date(Number(x.created_at)).toISOString(),
    }));
  }
  async hasProject(projectId: string): Promise<boolean> {
    return !!(await this.backend.row(sql`SELECT id FROM projects WHERE id=${projectId}`));
  }
  async createConnection(input: {
    id: string;
    projectId: string;
    provider: string;
    name: string;
    encryptedCredentials: string;
  }): Promise<ConnectionRow> {
    if (!(await this.hasProject(input.projectId)))
      throw new StoreError("NOT_FOUND", "Project not found");

    const connectionId = input.id,
      time = now();

    await this.backend.run(
      sql`INSERT INTO provider_connections (id,project_id,provider,name,scope,encrypted_credentials,credential_revision,status,created_at,updated_at) VALUES (${connectionId},${input.projectId},${input.provider},${input.name},NULL,${input.encryptedCredentials},1,'unverified',${time},${time})`,
    );

    return (await this.getConnection(input.projectId, connectionId))!;
  }
  async getConnection(projectId: string, connectionId: string): Promise<ConnectionRow | undefined> {
    return this.backend.row(
      sql`SELECT * FROM provider_connections WHERE project_id=${projectId} AND id=${connectionId}`,
    );
  }
  async listConnections(projectId: string): Promise<ConnectionRow[]> {
    return this.backend.rows(
      sql`SELECT * FROM provider_connections WHERE project_id=${projectId} ORDER BY created_at,id`,
    );
  }
  async verifyConnection(
    projectId: string,
    connectionId: string,
    scope: string,
  ): Promise<ConnectionRow> {
    const existing = await this.getConnection(projectId, connectionId);

    if (!existing) throw new StoreError("NOT_FOUND", "Connection not found");

    if (existing.scope && existing.scope !== scope)
      throw new StoreError("CONFLICT", "Native scope changed; create a new connection");
    await this.backend.run(
      sql`UPDATE provider_connections SET scope=${scope},status='verified',updated_at=${now()} WHERE project_id=${projectId} AND id=${connectionId}`,
    );

    return (await this.getConnection(projectId, connectionId))!;
  }

  private async lockProject(tx: QueryConnection, projectId: string): Promise<void> {
    const suffix = this.backend.dialect === "mysql" ? sql.raw(" FOR UPDATE") : sql.raw("");
    const project = await tx.row(sql`SELECT id FROM projects WHERE id=${projectId}${suffix}`);

    if (!project) throw new StoreError("NOT_FOUND", "Project not found");
  }
  private async lockOperation(
    tx: QueryConnection,
    operationId: string,
  ): Promise<OperationRow | undefined> {
    const suffix = this.backend.dialect === "mysql" ? sql.raw(" FOR UPDATE") : sql.raw("");

    return tx.row<OperationRow>(sql`SELECT * FROM operations WHERE id=${operationId}${suffix}`);
  }
  private async existingInvocation(
    tx: QueryConnection,
    projectId: string,
    endpoint: string,
    key: string,
    hash: string,
  ): Promise<Admission | undefined> {
    const prior = await tx.row<{ intent_hash: string; operation_id: string }>(
      sql`SELECT intent_hash,operation_id FROM invocation_keys WHERE project_id=${projectId} AND endpoint=${endpoint} AND ${sql.raw("`key`")}=${key}`,
    );

    if (!prior) return undefined;

    if (prior.intent_hash !== hash)
      throw new StoreError("CONFLICT", "Idempotency-Key was used with different input");

    const op = (await tx.row<OperationRow>(
      sql`SELECT * FROM operations WHERE id=${prior.operation_id}`,
    ))!;

    const box = (await tx.row<SandboxRow>(sql`SELECT * FROM sandboxes WHERE id=${op.sandbox_id}`))!;

    const execution = op.execution_id
      ? await tx.row<ExecutionRow>(sql`SELECT * FROM executions WHERE id=${op.execution_id}`)
      : undefined;

    return { operation: op, sandbox: box, execution, repeated: true };
  }
  async lookupInvocation(
    projectId: string,
    endpoint: string,
    key: string,
  ): Promise<OperationRow | undefined> {
    return this.backend.row<OperationRow>(
      sql`SELECT operations.* FROM invocation_keys INNER JOIN operations ON operations.id=invocation_keys.operation_id WHERE invocation_keys.project_id=${projectId} AND invocation_keys.endpoint=${endpoint} AND invocation_keys.${sql.raw("`key`")}=${key} AND operations.project_id=${projectId}`,
    );
  }
  private checkNewKey(key: string): void {
    const delta = now() - uuidV7Millis(key);

    if (delta > 86_400_000 || delta < -300_000)
      throw new StoreError(
        "INVOCATION_EXPIRED",
        "Idempotency-Key is outside the first-admission window",
      );
  }
  private async checkUnknownQuota(tx: QueryConnection, projectId: string): Promise<void> {
    const row = await tx.row<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM operations WHERE project_id=${projectId} AND status='unknown'`,
    );

    if (Number(row?.n ?? 0) >= 100)
      throw new StoreError("CAPACITY", "Too many unresolved outcomes in project");
  }

  async admitCreate(input: {
    projectId: string;
    endpoint: string;
    key: string;
    intentHash: string;
    request: CreateIntent;
    connectionId?: string;
  }): Promise<Admission> {
    return this.backend.transaction(async (tx) => {
      await this.lockProject(tx, input.projectId);

      const old = await this.existingInvocation(
        tx,
        input.projectId,
        input.endpoint,
        input.key,
        input.intentHash,
      );

      if (old) return old;
      this.checkNewKey(input.key);
      await this.checkUnknownQuota(tx, input.projectId);

      const connection = input.connectionId
        ? await tx.row<ConnectionRow>(
            sql`SELECT * FROM provider_connections WHERE project_id=${input.projectId} AND id=${input.connectionId} AND status='verified'`,
          )
        : await tx.row<ConnectionRow>(
            sql`SELECT * FROM provider_connections WHERE project_id=${input.projectId} AND status='verified' ORDER BY created_at,id LIMIT 1`,
          );

      if (!connection)
        throw new StoreError("CONFLICT", "No verified provider connection is available");

      const sandboxId = id("sb"),
        operationId = id("op"),
        submissionId = id("sub"),
        time = now();

      const frozen = {
        ...input.request,
        connectionId: connection.id,
        network: input.request.network ?? { policy: "blocked" },
      };

      await tx.run(
        sql`INSERT INTO sandboxes (id,project_id,connection_id,native_id,desired_state,observed_state,observed_at,observation_error,revision,create_operation_id,labels_json,created_at,updated_at) VALUES (${sandboxId},${input.projectId},${connection.id},NULL,'running','resolving',NULL,NULL,1,${operationId},${JSON.stringify(input.request.labels ?? {})},${time},${time})`,
      );
      await tx.run(
        sql`INSERT INTO operations (id,project_id,kind,sandbox_id,execution_id,connection_id,status,phase,effect,request_json,result_json,error_json,provider_token,submission_possible,lease_owner,lease_generation,lease_expires_at,next_attempt_at,observed_at,created_at,updated_at) VALUES (${operationId},${input.projectId},'create',${sandboxId},NULL,${connection.id},'queued','accepted','none',${JSON.stringify(frozen)},NULL,NULL,${submissionId},0,NULL,0,NULL,${time},NULL,${time},${time})`,
      );
      await tx.run(
        sql`INSERT INTO invocation_keys (project_id,endpoint,${sql.raw("`key`")},intent_hash,operation_id,accepted_at) VALUES (${input.projectId},${input.endpoint},${input.key},${input.intentHash},${operationId},${time})`,
      );
      await tx.run(
        sql`INSERT INTO reservations (id,project_id,sandbox_id,operation_id,kind,amount,state,created_at,released_at) VALUES (${id("res")},${input.projectId},${sandboxId},${operationId},'sandbox',1,'active',${time},NULL)`,
      );
      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${input.projectId},${sandboxId},${operationId},'operation.accepted','{}',NULL,NULL,${time})`,
      );

      return {
        operation: (await tx.row<OperationRow>(
          sql`SELECT * FROM operations WHERE id=${operationId}`,
        ))!,
        sandbox: (await tx.row<SandboxRow>(sql`SELECT * FROM sandboxes WHERE id=${sandboxId}`))!,
        repeated: false,
      };
    });
  }

  async admitExec(input: {
    projectId: string;
    sandboxId: string;
    endpoint: string;
    key: string;
    intentHash: string;
    encryptedRequest: string;
    output?: { capture: "bounded" | "none"; maxBytes?: number };
    captureBytes: number;
  }): Promise<Admission> {
    return this.backend.transaction(async (tx) => {
      await this.lockProject(tx, input.projectId);

      const old = await this.existingInvocation(
        tx,
        input.projectId,
        input.endpoint,
        input.key,
        input.intentHash,
      );

      if (old) return old;
      this.checkNewKey(input.key);
      await this.checkUnknownQuota(tx, input.projectId);

      const box = await tx.row<SandboxRow>(
        sql`SELECT * FROM sandboxes WHERE project_id=${input.projectId} AND id=${input.sandboxId}`,
      );

      if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");

      if (box.observed_state !== "running" || box.desired_state !== "running" || !box.native_id)
        throw new StoreError("CONFLICT", "Sandbox is not running");

      const totals = await tx.row<{ project_bytes: number; sandbox_bytes: number }>(
        sql`SELECT COALESCE(SUM(amount),0) AS project_bytes, COALESCE(SUM(CASE WHEN sandbox_id=${box.id} THEN amount ELSE 0 END),0) AS sandbox_bytes FROM reservations WHERE project_id=${input.projectId} AND kind='output' AND state='active'`,
      );

      let projectBytes = Number(totals?.project_bytes ?? 0),
        sandboxBytes = Number(totals?.sandbox_bytes ?? 0);

      const evict = async (sandboxId?: string) => {
        const scope = sandboxId ? sql`AND r.sandbox_id=${sandboxId}` : sql``;

        const candidates = await tx.rows<{
          reservation_id: string;
          execution_id: string;
          sandbox_id: string;
          amount: number;
        }>(
          sql`SELECT r.id AS reservation_id,e.id AS execution_id,r.sandbox_id,r.amount FROM reservations r JOIN executions e ON e.operation_id=r.operation_id JOIN operations o ON o.id=r.operation_id WHERE r.project_id=${input.projectId} AND r.kind='output' AND r.state='active' AND r.amount>0 AND e.status='completed' AND e.output_ciphertext IS NOT NULL AND o.status='succeeded' ${scope} ORDER BY e.completed_at,e.id`,
        );

        for (const candidate of candidates) {
          if (
            sandboxId
              ? sandboxBytes + input.captureBytes <= 16 * 1024 * 1024
              : projectBytes + input.captureBytes <= 256 * 1024 * 1024
          )
            break;
          const time = now();

          await tx.run(
            sql`UPDATE executions SET output_state='evicted',output_ciphertext=NULL WHERE id=${candidate.execution_id}`,
          );
          await tx.run(
            sql`UPDATE reservations SET state='released',released_at=${time} WHERE id=${candidate.reservation_id}`,
          );
          projectBytes -= Number(candidate.amount);

          if (candidate.sandbox_id === box.id) sandboxBytes -= Number(candidate.amount);
        }
      };

      if (sandboxBytes + input.captureBytes > 16 * 1024 * 1024) await evict(box.id);

      if (projectBytes + input.captureBytes > 256 * 1024 * 1024) await evict();

      if (
        projectBytes + input.captureBytes > 256 * 1024 * 1024 ||
        sandboxBytes + input.captureBytes > 16 * 1024 * 1024
      )
        throw new StoreError("OUTPUT_CAPACITY", "Output reservation capacity exceeded");

      const operationId = id("op"),
        executionId = id("ex"),
        submissionId = id("sub"),
        time = now();

      await tx.run(
        sql`INSERT INTO operations (id,project_id,kind,sandbox_id,execution_id,connection_id,status,phase,effect,request_json,result_json,error_json,provider_token,submission_possible,lease_owner,lease_generation,lease_expires_at,next_attempt_at,observed_at,created_at,updated_at) VALUES (${operationId},${input.projectId},'exec',${box.id},${executionId},${box.connection_id},'queued','accepted','none',${JSON.stringify({ encryptedRequest: input.encryptedRequest, output: input.output })},NULL,NULL,${submissionId},0,NULL,0,NULL,${time},NULL,${time},${time})`,
      );
      await tx.run(
        sql`INSERT INTO executions (id,project_id,sandbox_id,operation_id,status,exit_code,${sql.raw("`signal`")},timed_out,output_state,output_bytes,output_truncated,output_ciphertext,created_at,completed_at) VALUES (${executionId},${input.projectId},${box.id},${operationId},'queued',NULL,NULL,NULL,'not_captured',0,0,NULL,${time},NULL)`,
      );
      await tx.run(
        sql`INSERT INTO invocation_keys (project_id,endpoint,${sql.raw("`key`")},intent_hash,operation_id,accepted_at) VALUES (${input.projectId},${input.endpoint},${input.key},${input.intentHash},${operationId},${time})`,
      );
      await tx.run(
        sql`INSERT INTO reservations (id,project_id,sandbox_id,operation_id,kind,amount,state,created_at,released_at) VALUES (${id("res")},${input.projectId},${box.id},${operationId},'output',${input.captureBytes},'active',${time},NULL)`,
      );
      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${input.projectId},${box.id},${operationId},'operation.accepted','{}',NULL,NULL,${time})`,
      );

      return {
        operation: (await tx.row<OperationRow>(
          sql`SELECT * FROM operations WHERE id=${operationId}`,
        ))!,
        sandbox: box,
        execution: (await tx.row<ExecutionRow>(
          sql`SELECT * FROM executions WHERE id=${executionId}`,
        ))!,
        repeated: false,
      };
    });
  }

  async admitDestroy(input: {
    projectId: string;
    sandboxId: string;
    endpoint: string;
    key: string;
    intentHash: string;
  }): Promise<Admission> {
    return this.backend.transaction(async (tx) => {
      await this.lockProject(tx, input.projectId);

      const old = await this.existingInvocation(
        tx,
        input.projectId,
        input.endpoint,
        input.key,
        input.intentHash,
      );

      if (old) return old;
      this.checkNewKey(input.key);

      const box = await tx.row<SandboxRow>(
        sql`SELECT * FROM sandboxes WHERE project_id=${input.projectId} AND id=${input.sandboxId}`,
      );

      if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");

      if (box.desired_state === "destroyed")
        throw new StoreError("CONFLICT", "Destruction has already been requested");

      const activeMutation = await tx.row<{ id: string }>(
        sql`SELECT id FROM operations WHERE project_id=${input.projectId} AND sandbox_id=${box.id} AND kind IN ('exec','file_write') AND status IN ('queued','running','unknown') LIMIT 1`,
      );

      if (activeMutation)
        throw new StoreError("CONFLICT", "Sandbox has unresolved execution or file work");

      const operationId = id("op"),
        submissionId = id("sub"),
        time = now();

      const creation = !box.native_id
        ? await tx.row<OperationRow>(
            sql`SELECT * FROM operations WHERE id=${box.create_operation_id} AND project_id=${input.projectId}`,
          )
        : undefined;

      const localOnly = !!creation && creation.status === "failed" && creation.effect === "none";
      const observedState = localOnly ? "destroyed" : "destroying";
      await tx.run(
        sql`UPDATE sandboxes SET desired_state='destroyed',observed_state=${observedState},observed_at=${localOnly ? time : box.observed_at},revision=revision+1,updated_at=${time} WHERE id=${box.id}`,
      );

      const resultJson = localOnly
        ? JSON.stringify({
            kind: "destroy",
            observation: { computeStopped: true, retainedResources: [] },
          })
        : null;

      await tx.run(
        sql`INSERT INTO operations (id,project_id,kind,sandbox_id,execution_id,connection_id,status,phase,effect,request_json,result_json,error_json,provider_token,submission_possible,lease_owner,lease_generation,lease_expires_at,next_attempt_at,observed_at,created_at,updated_at) VALUES (${operationId},${input.projectId},'destroy',${box.id},NULL,${box.connection_id},${localOnly ? "succeeded" : "queued"},${localOnly ? "completed" : "accepted"},'none',${JSON.stringify({ previousObservedState: box.observed_state, previousRevision: Number(box.revision) })},${resultJson},NULL,${submissionId},0,NULL,0,NULL,${localOnly ? null : time},${localOnly ? time : null},${time},${time})`,
      );
      await tx.run(
        sql`INSERT INTO invocation_keys (project_id,endpoint,${sql.raw("`key`")},intent_hash,operation_id,accepted_at) VALUES (${input.projectId},${input.endpoint},${input.key},${input.intentHash},${operationId},${time})`,
      );
      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${input.projectId},${box.id},${operationId},'destroy.requested','{}',NULL,NULL,${time})`,
      );

      if (localOnly)
        await tx.run(
          sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${input.projectId},${box.id},${operationId},'destroy.completed',${JSON.stringify({ effect: "none", localOnly: true })},${time},${time},${time})`,
        );

      return {
        operation: (await tx.row<OperationRow>(
          sql`SELECT * FROM operations WHERE id=${operationId}`,
        ))!,
        sandbox: (await tx.row<SandboxRow>(sql`SELECT * FROM sandboxes WHERE id=${box.id}`))!,
        repeated: false,
      };
    });
  }

  async admitFileWrite(input: {
    projectId: string;
    sandboxId: string;
    endpoint: string;
    key: string;
    intentHash: string;
    path: string;
    overwrite: boolean;
    encryptedBytes: string;
    bytes: number;
  }): Promise<Admission> {
    return this.backend.transaction(async (tx) => {
      await this.lockProject(tx, input.projectId);

      const old = await this.existingInvocation(
        tx,
        input.projectId,
        input.endpoint,
        input.key,
        input.intentHash,
      );

      if (old) return old;
      this.checkNewKey(input.key);
      await this.checkUnknownQuota(tx, input.projectId);

      const box = await tx.row<SandboxRow>(
        sql`SELECT * FROM sandboxes WHERE project_id=${input.projectId} AND id=${input.sandboxId}`,
      );

      if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");

      if (box.observed_state !== "running" || box.desired_state !== "running" || !box.native_id)
        throw new StoreError("CONFLICT", "Sandbox is not running");

      const operationId = id("op"),
        submissionId = id("sub"),
        time = now();

      const request = {
        path: input.path,
        overwrite: input.overwrite,
        encryptedBytes: input.encryptedBytes,
        bytes: input.bytes,
      };

      await tx.run(
        sql`INSERT INTO operations (id,project_id,kind,sandbox_id,execution_id,connection_id,status,phase,effect,request_json,result_json,error_json,provider_token,submission_possible,lease_owner,lease_generation,lease_expires_at,next_attempt_at,observed_at,created_at,updated_at) VALUES (${operationId},${input.projectId},'file_write',${box.id},NULL,${box.connection_id},'queued','accepted','none',${JSON.stringify(request)},NULL,NULL,${submissionId},0,NULL,0,NULL,${time},NULL,${time},${time})`,
      );
      await tx.run(
        sql`INSERT INTO invocation_keys (project_id,endpoint,${sql.raw("`key`")},intent_hash,operation_id,accepted_at) VALUES (${input.projectId},${input.endpoint},${input.key},${input.intentHash},${operationId},${time})`,
      );
      await tx.run(
        sql`INSERT INTO reservations (id,project_id,sandbox_id,operation_id,kind,amount,state,created_at,released_at) VALUES (${id("res")},${input.projectId},${box.id},${operationId},'file_input',${input.bytes},'active',${time},NULL)`,
      );
      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${input.projectId},${box.id},${operationId},'file_write.accepted',${JSON.stringify({ path: input.path, bytes: input.bytes })},NULL,NULL,${time})`,
      );

      return {
        operation: (await tx.row<OperationRow>(
          sql`SELECT * FROM operations WHERE id=${operationId}`,
        ))!,
        sandbox: box,
        repeated: false,
      };
    });
  }

  async getSandbox(projectId: string, sandboxId: string): Promise<SandboxRow | undefined> {
    return this.backend.row(
      sql`SELECT * FROM sandboxes WHERE project_id=${projectId} AND id=${sandboxId}`,
    );
  }
  async listSandboxes(
    projectId: string,
    limit = 50,
    before?: { createdAt: number; id: string },
    filters?: { state?: string; connectionId?: string; q?: string },
  ): Promise<SandboxRow[]> {
    const clauses: SQL[] = [sql`project_id=${projectId}`];

    if (before)
      clauses.push(
        sql`(created_at<${before.createdAt} OR (created_at=${before.createdAt} AND id<${before.id}))`,
      );

    if (filters?.state) clauses.push(sql`observed_state=${filters.state}`);

    if (filters?.connectionId) clauses.push(sql`connection_id=${filters.connectionId}`);

    if (filters?.q) {
      const pattern = `%${filters.q.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
      clauses.push(sql`(id LIKE ${pattern} ESCAPE '!' OR labels_json LIKE ${pattern} ESCAPE '!')`);
    }

    return this.backend.rows(
      sql`SELECT * FROM sandboxes WHERE ${sql.join(clauses, sql` AND `)} ORDER BY created_at DESC,id DESC LIMIT ${limit}`,
    );
  }
  async getOperation(projectId: string, operationId: string): Promise<OperationRow | undefined> {
    return this.backend.row(
      sql`SELECT * FROM operations WHERE project_id=${projectId} AND id=${operationId}`,
    );
  }
  async getActiveOperation(
    projectId: string,
    sandboxId: string,
  ): Promise<OperationRow | undefined> {
    return this.backend.row(
      sql`SELECT * FROM operations WHERE project_id=${projectId} AND sandbox_id=${sandboxId} AND status IN ('queued','running','unknown') ORDER BY created_at DESC,id DESC LIMIT 1`,
    );
  }
  async getExecution(projectId: string, executionId: string): Promise<ExecutionRow | undefined> {
    return this.backend.row(
      sql`SELECT * FROM executions WHERE project_id=${projectId} AND id=${executionId}`,
    );
  }
  async getInvocationKey(operationId: string): Promise<string | undefined> {
    return (
      await this.backend.row<{ key: string }>(
        sql`SELECT ${sql.raw("`key`")} AS ${sql.raw("`key`")} FROM invocation_keys WHERE operation_id=${operationId}`,
      )
    )?.key;
  }

  async claimDue(
    owner: string,
    leaseMs = 30_000,
    projectId?: string,
  ): Promise<Claimed | undefined> {
    return this.backend.transaction(async (tx) => {
      const time = now();

      const lock =
        this.backend.dialect === "mysql" ? sql.raw(" FOR UPDATE SKIP LOCKED") : sql.raw("");

      const scope = projectId ? sql`AND project_id=${projectId}` : sql.raw("");

      const op = await tx.row<OperationRow>(
        sql`SELECT * FROM operations WHERE status IN ('queued','running','unknown') ${scope} AND ((next_attempt_at<=${time} AND (lease_expires_at IS NULL OR lease_expires_at<=${time})) OR (lease_expires_at<=${time})) ORDER BY next_attempt_at,id LIMIT 1${lock}`,
      );

      if (!op) return undefined;

      const generation = Number(op.lease_generation) + 1,
        attemptId = id("att");

      const observeOnly = !!Number(op.submission_possible);

      const knownPending =
        observeOnly &&
        op.status === "running" &&
        ["awaiting_observation", "execution_running", "observing_pending"].includes(op.phase);

      await tx.run(
        sql`UPDATE operations SET status=${observeOnly && !knownPending ? "unknown" : "running"},phase=${observeOnly ? (knownPending ? "observing_pending" : "reconciling") : "claimed"},lease_owner=${owner},lease_generation=${generation},lease_expires_at=${time + leaseMs},next_attempt_at=NULL,updated_at=${time} WHERE id=${op.id}`,
      );

      if (op.kind === "exec")
        await tx.run(
          sql`UPDATE executions SET status=${observeOnly && !knownPending ? "unknown" : "running"} WHERE operation_id=${op.id}`,
        );
      await tx.run(
        sql`INSERT INTO operation_attempts (id,operation_id,lease_generation,status,submission_possible,started_at,submitted_at,completed_at,error_code) VALUES (${attemptId},${op.id},${generation},${observeOnly ? "observing" : "claimed"},${observeOnly ? 1 : 0},${time},NULL,NULL,NULL)`,
      );

      return {
        operation: (await tx.row<OperationRow>(sql`SELECT * FROM operations WHERE id=${op.id}`))!,
        attemptId,
        generation,
        observeOnly,
      };
    });
  }
  async beginSubmission(claim: Claimed): Promise<boolean> {
    return this.backend.transaction(async (tx) => {
      await this.lockProject(tx, claim.operation.project_id);
      const op = await this.lockOperation(tx, claim.operation.id);

      if (
        !op ||
        op.lease_owner !== claim.operation.lease_owner ||
        Number(op.lease_generation) !== claim.generation ||
        Number(op.submission_possible)
      )
        return false;

      if (op.kind === "exec" || op.kind === "file_write") {
        const box = await tx.row<SandboxRow>(
          sql`SELECT * FROM sandboxes WHERE project_id=${op.project_id} AND id=${op.sandbox_id}`,
        );

        if (
          !box ||
          box.desired_state !== "running" ||
          box.observed_state !== "running" ||
          !box.native_id
        )
          return false;
      }

      const time = now();

      const fileRequest =
        op.kind === "file_write"
          ? parseJson<{ path: string; overwrite: boolean; bytes: number }>(op.request_json)
          : undefined;

      const execRequest =
        op.kind === "exec"
          ? parseJson<{ output?: { capture: string; maxBytes?: number } }>(op.request_json)
          : undefined;

      const retainedRequest = fileRequest
        ? JSON.stringify({
            path: fileRequest.path,
            overwrite: fileRequest.overwrite,
            bytes: fileRequest.bytes,
          })
        : execRequest
          ? JSON.stringify({ output: execRequest.output })
          : op.request_json;

      await tx.run(
        sql`UPDATE operations SET submission_possible=1,phase='submitted',effect='possible',request_json=${retainedRequest},updated_at=${time} WHERE id=${op.id}`,
      );
      await tx.run(
        sql`UPDATE operation_attempts SET status='submitted',submission_possible=1,submitted_at=${time} WHERE id=${claim.attemptId}`,
      );

      return true;
    });
  }
  async completeDestroyWithoutNative(claim: Claimed): Promise<boolean> {
    return this.backend.transaction(async (tx) => {
      const op = await this.lockOperation(tx, claim.operation.id);

      if (
        !op ||
        op.kind !== "destroy" ||
        op.lease_owner !== claim.operation.lease_owner ||
        Number(op.lease_generation) !== claim.generation ||
        Number(op.submission_possible)
      )
        return false;

      const box = await tx.row<SandboxRow>(
        sql`SELECT * FROM sandboxes WHERE project_id=${op.project_id} AND id=${op.sandbox_id}`,
      );

      if (!box || box.native_id) return false;

      const creation = await tx.row<OperationRow>(
        sql`SELECT * FROM operations WHERE project_id=${op.project_id} AND id=${box.create_operation_id}`,
      );

      if (!creation || creation.status !== "failed" || creation.effect !== "none") return false;
      const time = now();

      const result = JSON.stringify({
        kind: "destroy",
        observation: { computeStopped: true, retainedResources: [] },
      });

      await tx.run(
        sql`UPDATE operations SET status='succeeded',phase='completed',effect='none',result_json=${result},error_json=NULL,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,observed_at=${time},updated_at=${time} WHERE id=${op.id}`,
      );
      await tx.run(
        sql`UPDATE operation_attempts SET status='completed',completed_at=${time} WHERE id=${claim.attemptId}`,
      );
      await tx.run(
        sql`UPDATE sandboxes SET observed_state='destroyed',observed_at=${time},revision=revision+1,updated_at=${time} WHERE id=${box.id}`,
      );
      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${op.project_id},${box.id},${op.id},'destroy.completed',${JSON.stringify({ effect: "none", localOnly: true })},${time},${time},${time})`,
      );

      return true;
    });
  }
  async reschedule(
    claim: Claimed,
    phase: string,
    delayMs: number,
    errorCode?: string,
    knownPending = false,
  ): Promise<void> {
    await this.backend.transaction(async (tx) => {
      const time = now();
      const op = await this.lockOperation(tx, claim.operation.id);

      if (
        !op ||
        Number(op.lease_generation) !== claim.generation ||
        op.lease_owner !== claim.operation.lease_owner
      )
        return;
      const uncertain = !!Number(op.submission_possible);
      await tx.run(
        sql`UPDATE operations SET status=${knownPending ? "running" : uncertain ? "unknown" : "queued"},phase=${phase},effect=${uncertain ? "possible" : "none"},lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=${time + delayMs},updated_at=${time} WHERE id=${op.id}`,
      );

      if (op.kind === "exec")
        await tx.run(
          sql`UPDATE executions SET status=${knownPending ? "running" : uncertain ? "unknown" : "queued"} WHERE operation_id=${op.id}`,
        );

      if (uncertain && op.kind === "create")
        await tx.run(
          sql`UPDATE sandboxes SET observed_state='unknown',observation_error=${errorCode ?? "OUTCOME_UNKNOWN"},revision=revision+1,updated_at=${time} WHERE id=${op.sandbox_id}`,
        );
      await tx.run(
        sql`UPDATE operation_attempts SET status=${uncertain ? "unknown" : "deferred"},completed_at=${time},error_code=${errorCode ?? null} WHERE id=${claim.attemptId}`,
      );
    });
  }
  async requestReconcile(projectId: string, operationId: string): Promise<OperationRow> {
    const op = await this.getOperation(projectId, operationId);

    if (!op) throw new StoreError("NOT_FOUND", "Operation not found");

    if (!Number(op.submission_possible) || ["succeeded", "failed"].includes(op.status))
      throw new StoreError("CONFLICT", "Operation does not need reconciliation");
    await this.backend.run(
      sql`UPDATE operations SET next_attempt_at=${now()} WHERE id=${operationId} AND project_id=${projectId} AND lease_owner IS NULL`,
    );

    return (await this.getOperation(projectId, operationId))!;
  }

  async complete(
    claim: Claimed,
    result: {
      effect: string;
      value: object;
      observedAt?: number;
      encryptedOutput?: string;
      outputBytes?: number;
      outputTruncated?: boolean;
    },
  ): Promise<void> {
    await this.backend.transaction(async (tx) => {
      const op = await this.lockOperation(tx, claim.operation.id);

      if (
        !op ||
        Number(op.lease_generation) !== claim.generation ||
        op.lease_owner !== claim.operation.lease_owner
      )
        return;

      // SAFETY: The runner supplies a validated destroy observation for destroy completions.
      if (
        op.kind === "destroy" &&
        (result.value as { observation?: { computeStopped?: boolean } }).observation
          ?.computeStopped !== true
      )
        throw new StoreError(
          "CONFLICT",
          "Cannot confirm destruction while compute may still be running",
        );

      // SAFETY: The runner supplies a validated execution observation for exec completions.
      if (
        op.kind === "exec" &&
        (result.value as { observation?: { completed?: boolean } }).observation?.completed !== true
      )
        throw new StoreError(
          "CONFLICT",
          "Cannot complete an execution before a terminal observation",
        );

      const time = now(),
        observedAt = result.observedAt ?? time;

      await tx.run(
        sql`UPDATE operations SET status='succeeded',phase='completed',effect=${result.effect},request_json=${op.kind === "exec" || op.kind === "file_write" ? "{}" : op.request_json},result_json=${JSON.stringify(result.value)},error_json=NULL,lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,observed_at=${observedAt},updated_at=${time} WHERE id=${op.id}`,
      );
      await tx.run(
        sql`UPDATE operation_attempts SET status='completed',completed_at=${time} WHERE id=${claim.attemptId}`,
      );

      if (op.kind === "create") {
        // SAFETY: A completed create carries a validated sandbox observation.
        const obs = (
          result.value as {
            kind: string;
            observation: { ref: { nativeId: string }; state: string };
          }
        ).observation;

        await tx.run(
          sql`UPDATE sandboxes SET native_id=${obs.ref.nativeId},observed_state=${obs.state},observed_at=${observedAt},observation_error=NULL,revision=revision+1,updated_at=${time} WHERE id=${op.sandbox_id}`,
        );
        await tx.run(
          sql`UPDATE reservations SET state='released',released_at=${time} WHERE operation_id=${op.id} AND kind='sandbox'`,
        );
      } else if (op.kind === "exec") {
        // SAFETY: A completed exec carries a validated execution observation.
        const obs = (
          result.value as {
            kind: string;
            observation: { exitCode?: number | null; truncated?: boolean };
          }
        ).observation;

        const bytes = result.outputBytes ?? 0;

        if (
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes > 0 !== Boolean(result.encryptedOutput)
        )
          throw new StoreError("CONFLICT", "Captured output metadata is inconsistent");

        const reservation = await tx.row<{ amount: number }>(
          sql`SELECT amount FROM reservations WHERE operation_id=${op.id} AND kind='output' AND state='active'`,
        );

        if (!reservation || bytes > Number(reservation.amount))
          throw new StoreError("CONFLICT", "Captured output exceeds its reservation");
        const request = parseJson<{ output?: { capture: string } }>(op.request_json);

        const outputState =
          request.output?.capture === "none"
            ? "not_captured"
            : result.outputTruncated
              ? "truncated"
              : "captured";

        await tx.run(
          sql`UPDATE executions SET status='completed',exit_code=${obs.exitCode ?? null},output_state=${outputState},output_bytes=${bytes},output_truncated=${result.outputTruncated ? 1 : 0},output_ciphertext=${result.encryptedOutput ?? null},completed_at=${time} WHERE id=${op.execution_id}`,
        );
        // Retained ciphertext consumes capacity until it is actually removed. Return only unused capacity.
        await tx.run(
          sql`UPDATE reservations SET amount=${bytes},state=${bytes > 0 ? "active" : "released"},released_at=${bytes > 0 ? null : time} WHERE operation_id=${op.id} AND kind='output'`,
        );
      } else if (op.kind === "destroy") {
        await tx.run(
          sql`UPDATE sandboxes SET observed_state='destroyed',observed_at=${observedAt},revision=revision+1,updated_at=${time} WHERE id=${op.sandbox_id}`,
        );
      } else if (op.kind === "file_write") {
        await tx.run(
          sql`UPDATE reservations SET state='released',released_at=${time} WHERE operation_id=${op.id} AND kind='file_input'`,
        );
      }

      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${op.project_id},${op.sandbox_id},${op.id},${`${op.kind}.completed`},${JSON.stringify({ effect: result.effect })},${observedAt},${observedAt},${time})`,
      );
      await tx.run(
        sql`INSERT INTO usage_evidence (id,project_id,sandbox_id,operation_id,kind,source_key,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("ue")},${op.project_id},${op.sandbox_id},${op.id},${`${op.kind}.observed`},${`${op.id}:completed`},${JSON.stringify({ effect: result.effect })},${observedAt},${observedAt},${time})`,
      );
    });
  }
  async failWithoutEffect(
    claim: Claimed,
    error: OperationFailure,
    certifiedNoEffect = false,
  ): Promise<void> {
    await this.backend.transaction(async (tx) => {
      const op = await this.lockOperation(tx, claim.operation.id);

      if (
        !op ||
        Number(op.lease_generation) !== claim.generation ||
        op.lease_owner !== claim.operation.lease_owner
      )
        return;

      if (Number(op.submission_possible) && !certifiedNoEffect)
        throw new StoreError("CONFLICT", "Cannot mark a possibly submitted operation effect-free");
      const time = now();
      await tx.run(
        sql`UPDATE operations SET status='failed',phase='rejected',effect='none',request_json=${op.kind === "exec" || op.kind === "file_write" ? "{}" : op.request_json},error_json=${JSON.stringify(error)},lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=${time} WHERE id=${op.id}`,
      );
      await tx.run(
        sql`UPDATE operation_attempts SET status='rejected',completed_at=${time} WHERE id=${claim.attemptId}`,
      );
      await tx.run(
        sql`UPDATE reservations SET state='released',released_at=${time} WHERE operation_id=${op.id}`,
      );

      if (op.kind === "exec")
        await tx.run(
          sql`UPDATE executions SET status='completed',output_state='not_captured',completed_at=${time} WHERE operation_id=${op.id}`,
        );

      if (op.kind === "create")
        await tx.run(
          sql`UPDATE sandboxes SET observed_state='unknown',observation_error=${String(error.code ?? "CREATE_REJECTED")},revision=revision+1,updated_at=${time} WHERE id=${op.sandbox_id}`,
        );

      if (op.kind === "destroy") {
        const request = parseJson<{
          previousObservedState?: string;
          previousRevision?: number;
        }>(op.request_json);

        const box = await tx.row<SandboxRow>(
          sql`SELECT * FROM sandboxes WHERE project_id=${op.project_id} AND id=${op.sandbox_id}`,
        );

        if (!box) throw new StoreError("NOT_FOUND", "Sandbox not found");

        const newerObservation =
          request.previousRevision === undefined
            ? !!box.native_id
            : Number(box.revision) > request.previousRevision + 1;

        const observedState = newerObservation
          ? box.observed_state
          : (request.previousObservedState ?? "unknown");

        await tx.run(
          sql`UPDATE sandboxes SET desired_state='running',observed_state=${observedState},observation_error=${String(error.code ?? "DESTROY_REJECTED")},revision=revision+1,updated_at=${time} WHERE id=${op.sandbox_id}`,
        );
      }

      await tx.run(
        sql`INSERT INTO resource_events (id,project_id,sandbox_id,operation_id,kind,payload_json,effective_at,observed_at,recorded_at) VALUES (${id("evt")},${op.project_id},${op.sandbox_id},${op.id},'operation.rejected',${JSON.stringify({ code: error.code })},NULL,NULL,${time})`,
      );
    });
  }
}
