BEGIN;

ALTER TABLE ue_mcp.code_chunks
  ADD COLUMN stable_key bytea,
  ADD COLUMN content_hash bytea,
  ADD COLUMN start_line integer,
  ADD COLUMN start_column integer,
  ADD COLUMN end_line integer,
  ADD COLUMN end_column integer,
  ADD COLUMN part_index integer NOT NULL DEFAULT 0,
  ADD COLUMN part_count integer NOT NULL DEFAULT 1;

-- Pre-P1-12 rows have no import marker and are treated as dirty by the coordinator.
-- Give them collision-free 32-byte placeholders without adding a new database extension.
UPDATE ue_mcp.code_chunks
SET stable_key = decode(replace(id::text, '-', ''), 'hex') || decode(replace(id::text, '-', ''), 'hex'),
    content_hash = decode(replace(id::text, '-', ''), 'hex') || decode(replace(id::text, '-', ''), 'hex');

ALTER TABLE ue_mcp.code_chunks
  ALTER COLUMN stable_key SET NOT NULL,
  ALTER COLUMN content_hash SET NOT NULL,
  ADD CONSTRAINT code_chunks_stable_key_size_check CHECK (octet_length(stable_key) = 32),
  ADD CONSTRAINT code_chunks_content_hash_size_check CHECK (octet_length(content_hash) = 32),
  ADD CONSTRAINT code_chunks_source_range_check CHECK (
    (start_line IS NULL AND start_column IS NULL AND end_line IS NULL AND end_column IS NULL)
    OR
    (start_line > 0 AND start_column > 0 AND end_line > 0 AND end_column > 0
      AND (end_line, end_column) > (start_line, start_column))
  ),
  ADD CONSTRAINT code_chunks_part_check CHECK (part_index >= 0 AND part_count > 0 AND part_index < part_count),
  ADD CONSTRAINT code_chunks_generation_stable_key_unique UNIQUE (generation_id, stable_key);

ALTER TABLE ue_mcp.index_generations
  ADD COLUMN chunk_plan_hash bytea CHECK (chunk_plan_hash IS NULL OR octet_length(chunk_plan_hash) = 32),
  ADD COLUMN chunk_payload_hash bytea CHECK (chunk_payload_hash IS NULL OR octet_length(chunk_payload_hash) = 32),
  ADD COLUMN code_chunk_count bigint CHECK (code_chunk_count IS NULL OR code_chunk_count >= 0),
  ADD COLUMN chunks_imported_at timestamptz,
  ADD CONSTRAINT index_generations_chunk_import_state_check CHECK (
    (chunks_imported_at IS NULL AND chunk_plan_hash IS NULL AND chunk_payload_hash IS NULL AND code_chunk_count IS NULL)
    OR
    (chunks_imported_at IS NOT NULL AND chunk_plan_hash IS NOT NULL AND chunk_payload_hash IS NOT NULL AND code_chunk_count IS NOT NULL)
  ),
  ADD CONSTRAINT index_generations_chunk_requires_symbols_check CHECK (
    chunks_imported_at IS NULL OR symbols_imported_at IS NOT NULL
  );

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (5, 'p1_12_chunk_persistence', decode(:'migration_checksum', 'hex'));

COMMIT;
