BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 4 AND name = 'p1_10_relation_persistence';

ALTER TABLE ue_mcp.index_generations
  DROP COLUMN relations_imported_at,
  DROP COLUMN file_dependency_count,
  DROP COLUMN symbol_edge_count,
  DROP COLUMN relation_payload_hash,
  DROP COLUMN relation_plan_hash;

COMMIT;
