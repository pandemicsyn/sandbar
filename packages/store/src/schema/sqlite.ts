import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Dialect-specific Drizzle definitions mirror the committed SQLite migration.
export const operators = sqliteTable("operators", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    operatorId: text("operator_id")
      .notNull()
      .references(() => operators.id),
    csrfHash: text("csrf_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("sessions_expiry_idx").on(table.expiresAt)],
);

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    scope: text("scope"),
    encryptedCredentials: text("encrypted_credentials").notNull(),
    adapterContractVersion: integer("adapter_contract_version").notNull().default(1),
    credentialRevision: integer("credential_revision").notNull().default(1),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("connections_project_id").on(table.projectId, table.id),
    index("connections_project_idx").on(table.projectId, table.createdAt, table.id),
  ],
);

export const sandboxes = sqliteTable(
  "sandboxes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    nativeId: text("native_id"),
    desiredState: text("desired_state").notNull(),
    observedState: text("observed_state").notNull(),
    observedAt: integer("observed_at"),
    observationError: text("observation_error"),
    revision: integer("revision").notNull().default(1),
    createOperationId: text("create_operation_id").notNull(),
    labelsJson: text("labels_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sandboxes_project_id").on(table.projectId, table.id),
    uniqueIndex("sandboxes_native").on(table.connectionId, table.nativeId),
    index("sandboxes_fleet_idx").on(table.projectId, table.createdAt, table.id),
    index("sandboxes_connection_idx").on(table.connectionId, table.observedState),
  ],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").notNull(),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    executionId: text("execution_id"),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    status: text("status").notNull(),
    phase: text("phase").notNull(),
    effect: text("effect").notNull(),
    requestJson: text("request_json").notNull(),
    resultJson: text("result_json"),
    errorJson: text("error_json"),
    adapterTokenCiphertext: text("adapter_token_ciphertext"),
    providerToken: text("provider_token").notNull(),
    submissionPossible: integer("submission_possible").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseExpiresAt: integer("lease_expires_at"),
    nextAttemptAt: integer("next_attempt_at"),
    observedAt: integer("observed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("operations_project_id").on(table.projectId, table.id),
    index("operations_due_idx").on(table.nextAttemptAt, table.status, table.leaseExpiresAt),
    index("operations_sandbox_idx").on(table.projectId, table.sandboxId, table.createdAt),
  ],
);

export const operationAttempts = sqliteTable(
  "operation_attempts",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id),
    leaseGeneration: integer("lease_generation").notNull(),
    status: text("status").notNull(),
    submissionPossible: integer("submission_possible").notNull().default(0),
    startedAt: integer("started_at").notNull(),
    submittedAt: integer("submitted_at"),
    completedAt: integer("completed_at"),
    errorCode: text("error_code"),
  },
  (table) => [uniqueIndex("attempts_generation").on(table.operationId, table.leaseGeneration)],
);

export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: text("operation_id")
      .notNull()
      .unique()
      .references(() => operations.id),
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    timedOut: integer("timed_out"),
    outputState: text("output_state").notNull(),
    outputBytes: integer("output_bytes").notNull().default(0),
    outputTruncated: integer("output_truncated").notNull().default(0),
    outputCiphertext: text("output_ciphertext"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [uniqueIndex("executions_project_id").on(table.projectId, table.id)],
);

export const invocationKeys = sqliteTable(
  "invocation_keys",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    intentHash: text("intent_hash").notNull(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operations.id),
    acceptedAt: integer("accepted_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.endpoint, table.key] })],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: text("operation_id")
      .notNull()
      .unique()
      .references(() => operations.id),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    state: text("state").notNull(),
    createdAt: integer("created_at").notNull(),
    releasedAt: integer("released_at"),
  },
  (table) => [index("reservations_open_idx").on(table.projectId, table.state, table.kind)],
);

export const resourceEvents = sqliteTable(
  "resource_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: text("operation_id"),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    effectiveAt: integer("effective_at"),
    observedAt: integer("observed_at"),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    index("resource_events_sandbox_idx").on(table.projectId, table.sandboxId, table.recordedAt),
  ],
);

export const usageEvidence = sqliteTable(
  "usage_evidence",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: text("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: text("operation_id"),
    kind: text("kind").notNull(),
    sourceKey: text("source_key").notNull(),
    payloadJson: text("payload_json").notNull(),
    effectiveAt: integer("effective_at"),
    observedAt: integer("observed_at"),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [uniqueIndex("usage_source_idx").on(table.projectId, table.sourceKey)],
);
