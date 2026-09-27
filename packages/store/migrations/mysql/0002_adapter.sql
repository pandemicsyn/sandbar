ALTER TABLE operations ADD COLUMN adapter_token_ciphertext LONGTEXT NULL;
ALTER TABLE provider_connections ADD COLUMN adapter_contract_version INT NOT NULL DEFAULT 1;
