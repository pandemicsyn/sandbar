PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT,
  encrypted_credentials TEXT NOT NULL,
  adapter_contract_version INTEGER NOT NULL DEFAULT 1,
  credential_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, id)
);
CREATE INDEX IF NOT EXISTS connections_project_idx ON provider_connections(project_id, created_at, id);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  native_id TEXT,
  desired_state TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  observed_at INTEGER,
  observation_error TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  create_operation_id TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, id),
  UNIQUE(connection_id, native_id)
);
CREATE INDEX IF NOT EXISTS sandboxes_fleet_idx ON sandboxes(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS sandboxes_connection_idx ON sandboxes(connection_id, observed_state);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  execution_id TEXT,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  effect TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  provider_token TEXT NOT NULL,
  adapter_token_ciphertext TEXT,
  submission_possible INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  observed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, id)
);
CREATE INDEX IF NOT EXISTS operations_due_idx ON operations(next_attempt_at, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS operations_sandbox_idx ON operations(project_id, sandbox_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operation_attempts (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  lease_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  submission_possible INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  submitted_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  UNIQUE(operation_id, lease_generation)
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  status TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER,
  output_state TEXT NOT NULL,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  output_ciphertext TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(project_id, id)
);

CREATE TABLE IF NOT EXISTS invocation_keys (
  project_id TEXT NOT NULL REFERENCES projects(id),
  endpoint TEXT NOT NULL,
  key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, endpoint, key)
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_open_idx ON reservations(project_id, state, kind);

CREATE TABLE IF NOT EXISTS resource_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  operation_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  effective_at INTEGER,
  observed_at INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_events_sandbox_idx ON resource_events(project_id, sandbox_id, recorded_at);

CREATE TABLE IF NOT EXISTS usage_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
  operation_id TEXT,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  effective_at INTEGER,
  observed_at INTEGER,
  recorded_at INTEGER NOT NULL,
  UNIQUE(project_id, source_key)
);
