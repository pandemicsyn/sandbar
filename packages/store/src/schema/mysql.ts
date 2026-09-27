import {
  bigint,
  char,
  index,
  int,
  longtext,
  mysqlTable,
  primaryKey,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = (name: string) => varchar(name, { length: 128 });

const ms = (name: string) => bigint(name, { mode: "number" });

export const operators = mysqlTable("operators", {
  id: id("id").primaryKey(),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  createdAt: ms("created_at").notNull(),
});

export const sessions = mysqlTable(
  "sessions",
  {
    idHash: char("id_hash", { length: 64 }).primaryKey(),
    operatorId: id("operator_id")
      .notNull()
      .references(() => operators.id),
    csrfHash: char("csrf_hash", { length: 64 }).notNull(),
    expiresAt: ms("expires_at").notNull(),
    createdAt: ms("created_at").notNull(),
  },
  (table) => [index("sessions_expiry_idx").on(table.expiresAt)],
);

export const projects = mysqlTable("projects", {
  id: id("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: ms("created_at").notNull(),
});

export const providerConnections = mysqlTable(
  "provider_connections",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    provider: varchar("provider", { length: 128 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    scope: varchar("scope", { length: 512 }),
    encryptedCredentials: longtext("encrypted_credentials").notNull(),
    credentialRevision: int("credential_revision").notNull().default(1),
    status: varchar("status", { length: 32 }).notNull(),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("connections_project_id").on(table.projectId, table.id),
    index("connections_project_idx").on(table.projectId, table.createdAt, table.id),
  ],
);

export const sandboxes = mysqlTable(
  "sandboxes",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    connectionId: id("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    nativeId: varchar("native_id", { length: 255 }),
    desiredState: varchar("desired_state", { length: 32 }).notNull(),
    observedState: varchar("observed_state", { length: 32 }).notNull(),
    observedAt: ms("observed_at"),
    observationError: varchar("observation_error", { length: 1024 }),
    revision: ms("revision").notNull().default(1),
    createOperationId: id("create_operation_id").notNull(),
    labelsJson: longtext("labels_json").notNull(),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sandboxes_project_id").on(table.projectId, table.id),
    uniqueIndex("sandboxes_native").on(table.connectionId, table.nativeId),
    index("sandboxes_fleet_idx").on(table.projectId, table.createdAt, table.id),
    index("sandboxes_connection_idx").on(table.connectionId, table.observedState),
  ],
);

export const operations = mysqlTable(
  "operations",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    kind: varchar("kind", { length: 32 }).notNull(),
    sandboxId: id("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    executionId: id("execution_id"),
    connectionId: id("connection_id")
      .notNull()
      .references(() => providerConnections.id),
    status: varchar("status", { length: 32 }).notNull(),
    phase: varchar("phase", { length: 128 }).notNull(),
    effect: varchar("effect", { length: 32 }).notNull(),
    requestJson: longtext("request_json").notNull(),
    resultJson: longtext("result_json"),
    errorJson: longtext("error_json"),
    providerToken: id("provider_token").notNull(),
    submissionPossible: tinyint("submission_possible").notNull().default(0),
    leaseOwner: id("lease_owner"),
    leaseGeneration: ms("lease_generation").notNull().default(0),
    leaseExpiresAt: ms("lease_expires_at"),
    nextAttemptAt: ms("next_attempt_at"),
    observedAt: ms("observed_at"),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("operations_project_id").on(table.projectId, table.id),
    index("operations_due_idx").on(table.nextAttemptAt, table.status, table.leaseExpiresAt),
    index("operations_sandbox_idx").on(table.projectId, table.sandboxId, table.createdAt),
  ],
);

export const operationAttempts = mysqlTable(
  "operation_attempts",
  {
    id: id("id").primaryKey(),
    operationId: id("operation_id")
      .notNull()
      .references(() => operations.id),
    leaseGeneration: ms("lease_generation").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    submissionPossible: tinyint("submission_possible").notNull().default(0),
    startedAt: ms("started_at").notNull(),
    submittedAt: ms("submitted_at"),
    completedAt: ms("completed_at"),
    errorCode: varchar("error_code", { length: 128 }),
  },
  (table) => [uniqueIndex("attempts_generation").on(table.operationId, table.leaseGeneration)],
);

export const executions = mysqlTable(
  "executions",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: id("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: id("operation_id")
      .notNull()
      .unique()
      .references(() => operations.id),
    status: varchar("status", { length: 32 }).notNull(),
    exitCode: int("exit_code"),
    signal: varchar("signal", { length: 64 }),
    timedOut: tinyint("timed_out"),
    outputState: varchar("output_state", { length: 32 }).notNull(),
    outputBytes: int("output_bytes").notNull().default(0),
    outputTruncated: tinyint("output_truncated").notNull().default(0),
    outputCiphertext: longtext("output_ciphertext"),
    createdAt: ms("created_at").notNull(),
    completedAt: ms("completed_at"),
  },
  (table) => [uniqueIndex("executions_project_id").on(table.projectId, table.id)],
);

export const invocationKeys = mysqlTable(
  "invocation_keys",
  {
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    key: char("key", { length: 36 }).notNull(),
    intentHash: char("intent_hash", { length: 64 }).notNull(),
    operationId: id("operation_id")
      .notNull()
      .references(() => operations.id),
    acceptedAt: ms("accepted_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.endpoint, table.key] })],
);

export const reservations = mysqlTable(
  "reservations",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: id("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: id("operation_id")
      .notNull()
      .unique()
      .references(() => operations.id),
    kind: varchar("kind", { length: 32 }).notNull(),
    amount: ms("amount").notNull(),
    state: varchar("state", { length: 32 }).notNull(),
    createdAt: ms("created_at").notNull(),
    releasedAt: ms("released_at"),
  },
  (table) => [index("reservations_open_idx").on(table.projectId, table.state, table.kind)],
);

export const resourceEvents = mysqlTable(
  "resource_events",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: id("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: id("operation_id"),
    kind: varchar("kind", { length: 128 }).notNull(),
    payloadJson: longtext("payload_json").notNull(),
    effectiveAt: ms("effective_at"),
    observedAt: ms("observed_at"),
    recordedAt: ms("recorded_at").notNull(),
  },
  (table) => [
    index("resource_events_sandbox_idx").on(table.projectId, table.sandboxId, table.recordedAt),
  ],
);

export const usageEvidence = mysqlTable(
  "usage_evidence",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id),
    sandboxId: id("sandbox_id")
      .notNull()
      .references(() => sandboxes.id),
    operationId: id("operation_id"),
    kind: varchar("kind", { length: 128 }).notNull(),
    sourceKey: varchar("source_key", { length: 255 }).notNull(),
    payloadJson: longtext("payload_json").notNull(),
    effectiveAt: ms("effective_at"),
    observedAt: ms("observed_at"),
    recordedAt: ms("recorded_at").notNull(),
  },
  (table) => [uniqueIndex("usage_source_idx").on(table.projectId, table.sourceKey)],
);
