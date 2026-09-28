PRAGMA defer_foreign_keys = ON;

CREATE TABLE operations_image_build (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  sandbox_id TEXT REFERENCES sandboxes(id),
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

INSERT INTO operations_image_build (
  id, project_id, kind, sandbox_id, execution_id, connection_id, status, phase,
  effect, request_json, result_json, error_json, provider_token, adapter_token_ciphertext,
  submission_possible, lease_owner, lease_generation, lease_expires_at, next_attempt_at,
  observed_at, created_at, updated_at
)
SELECT
  id, project_id, kind, sandbox_id, execution_id, connection_id, status, phase,
  effect, request_json, result_json, error_json, provider_token, adapter_token_ciphertext,
  submission_possible, lease_owner, lease_generation, lease_expires_at, next_attempt_at,
  observed_at, created_at, updated_at
FROM operations;

DROP TABLE operations;
ALTER TABLE operations_image_build RENAME TO operations;
CREATE INDEX operations_due_idx ON operations(next_attempt_at, status, lease_expires_at);
CREATE INDEX operations_sandbox_idx ON operations(project_id, sandbox_id, created_at DESC);
