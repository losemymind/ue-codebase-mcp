BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA ue_mcp;
REVOKE ALL ON SCHEMA ue_mcp FROM PUBLIC;

CREATE TABLE ue_mcp.schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]*$'),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (1, 'bootstrap', decode(:'migration_checksum', 'hex'));

COMMIT;
