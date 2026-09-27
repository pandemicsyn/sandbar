ALTER TABLE operations ADD COLUMN adapter_token_ciphertext TEXT;
ALTER TABLE provider_connections ADD COLUMN adapter_contract_version INTEGER NOT NULL DEFAULT 1;
