CREATE TABLE IF NOT EXISTS operators (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  token_hash char(64) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  created_at bigint NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS sessions (
  id_hash char(64) COLLATE utf8mb4_bin PRIMARY KEY,
  operator_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  csrf_hash char(64) COLLATE utf8mb4_bin NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  KEY sessions_expiry_idx (expires_at),
  CONSTRAINT sessions_operator_fk FOREIGN KEY (operator_id) REFERENCES operators(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS projects (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at bigint NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS provider_connections (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  provider varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  scope varchar(512),
  encrypted_credentials longtext NOT NULL,
  credential_revision int NOT NULL DEFAULT 1,
  status varchar(32) NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE KEY connections_project_id (project_id,id),
  KEY connections_project_idx (project_id,created_at,id),
  CONSTRAINT connections_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sandboxes (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  connection_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  native_id varchar(255) COLLATE utf8mb4_bin,
  desired_state varchar(32) NOT NULL,
  observed_state varchar(32) NOT NULL,
  observed_at bigint,
  observation_error varchar(1024),
  revision bigint NOT NULL DEFAULT 1,
  create_operation_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  labels_json longtext NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE KEY sandboxes_project_id (project_id,id),
  UNIQUE KEY sandboxes_native (connection_id,native_id),
  KEY sandboxes_fleet_idx (project_id,created_at,id),
  KEY sandboxes_connection_idx (connection_id,observed_state),
  CONSTRAINT sandboxes_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT sandboxes_connection_fk FOREIGN KEY (connection_id) REFERENCES provider_connections(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS operations (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  kind varchar(32) NOT NULL,
  sandbox_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  execution_id varchar(128) COLLATE utf8mb4_bin,
  connection_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  status varchar(32) NOT NULL,
  phase varchar(128) NOT NULL,
  effect varchar(32) NOT NULL,
  request_json longtext NOT NULL,
  result_json longtext,
  error_json longtext,
  provider_token varchar(128) COLLATE utf8mb4_bin NOT NULL,
  submission_possible tinyint(1) NOT NULL DEFAULT 0,
  lease_owner varchar(128) COLLATE utf8mb4_bin,
  lease_generation bigint NOT NULL DEFAULT 0,
  lease_expires_at bigint,
  next_attempt_at bigint,
  observed_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE KEY operations_project_id (project_id,id),
  KEY operations_due_idx (next_attempt_at,status,lease_expires_at),
  KEY operations_sandbox_idx (project_id,sandbox_id,created_at),
  CONSTRAINT operations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT operations_sandbox_fk FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id),
  CONSTRAINT operations_connection_fk FOREIGN KEY (connection_id) REFERENCES provider_connections(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operation_attempts (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  operation_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  lease_generation bigint NOT NULL,
  status varchar(32) NOT NULL,
  submission_possible tinyint(1) NOT NULL DEFAULT 0,
  started_at bigint NOT NULL,
  submitted_at bigint,
  completed_at bigint,
  error_code varchar(128),
  UNIQUE KEY attempts_generation (operation_id,lease_generation),
  CONSTRAINT attempts_operation_fk FOREIGN KEY (operation_id) REFERENCES operations(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS executions (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  sandbox_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  operation_id varchar(128) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  status varchar(32) NOT NULL,
  exit_code int,
  signal varchar(64),
  timed_out tinyint(1),
  output_state varchar(32) NOT NULL,
  output_bytes int NOT NULL DEFAULT 0,
  output_truncated tinyint(1) NOT NULL DEFAULT 0,
  output_ciphertext longtext,
  created_at bigint NOT NULL,
  completed_at bigint,
  UNIQUE KEY executions_project_id (project_id,id),
  CONSTRAINT executions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT executions_sandbox_fk FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id),
  CONSTRAINT executions_operation_fk FOREIGN KEY (operation_id) REFERENCES operations(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS invocation_keys (
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  endpoint varchar(255) COLLATE utf8mb4_bin NOT NULL,
  `key` char(36) COLLATE utf8mb4_bin NOT NULL,
  intent_hash char(64) COLLATE utf8mb4_bin NOT NULL,
  operation_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  accepted_at bigint NOT NULL,
  PRIMARY KEY(project_id,endpoint,`key`),
  CONSTRAINT invocation_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT invocation_operation_fk FOREIGN KEY (operation_id) REFERENCES operations(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS reservations (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  sandbox_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  operation_id varchar(128) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  kind varchar(32) NOT NULL,
  amount bigint NOT NULL,
  state varchar(32) NOT NULL,
  created_at bigint NOT NULL,
  released_at bigint,
  KEY reservations_open_idx (project_id,state,kind),
  CONSTRAINT reservations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT reservations_sandbox_fk FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id),
  CONSTRAINT reservations_operation_fk FOREIGN KEY (operation_id) REFERENCES operations(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS resource_events (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  sandbox_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  operation_id varchar(128) COLLATE utf8mb4_bin,
  kind varchar(128) NOT NULL,
  payload_json longtext NOT NULL,
  effective_at bigint,
  observed_at bigint,
  recorded_at bigint NOT NULL,
  KEY resource_events_sandbox_idx (project_id,sandbox_id,recorded_at),
  CONSTRAINT resource_events_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT resource_events_sandbox_fk FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS usage_evidence (
  id varchar(128) COLLATE utf8mb4_bin PRIMARY KEY,
  project_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  sandbox_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  operation_id varchar(128) COLLATE utf8mb4_bin,
  kind varchar(128) NOT NULL,
  source_key varchar(255) COLLATE utf8mb4_bin NOT NULL,
  payload_json longtext NOT NULL,
  effective_at bigint,
  observed_at bigint,
  recorded_at bigint NOT NULL,
  UNIQUE KEY usage_source_idx (project_id,source_key),
  CONSTRAINT usage_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT usage_sandbox_fk FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id)
) ENGINE=InnoDB;
