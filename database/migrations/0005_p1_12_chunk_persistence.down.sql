BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 5 AND name = 'p1_12_chunk_persistence';

ALTER TABLE ue_mcp.index_generations
  DROP COLUMN chunks_imported_at,
  DROP COLUMN code_chunk_count,
  DROP COLUMN chunk_payload_hash,
  DROP COLUMN chunk_plan_hash;

ALTER TABLE ue_mcp.code_chunks
  DROP COLUMN part_count,
  DROP COLUMN part_index,
  DROP COLUMN end_column,
  DROP COLUMN end_line,
  DROP COLUMN start_column,
  DROP COLUMN start_line,
  DROP COLUMN content_hash,
  DROP COLUMN stable_key;

COMMIT;
