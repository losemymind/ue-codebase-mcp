BEGIN;

ALTER TABLE ue_mcp.index_generations
  ADD COLUMN relation_plan_hash bytea CHECK (relation_plan_hash IS NULL OR octet_length(relation_plan_hash) = 32),
  ADD COLUMN relation_payload_hash bytea CHECK (relation_payload_hash IS NULL OR octet_length(relation_payload_hash) = 32),
  ADD COLUMN symbol_edge_count bigint CHECK (symbol_edge_count IS NULL OR symbol_edge_count >= 0),
  ADD COLUMN file_dependency_count bigint CHECK (file_dependency_count IS NULL OR file_dependency_count >= 0),
  ADD COLUMN relations_imported_at timestamptz,
  ADD CONSTRAINT index_generations_relation_import_state_check CHECK (
    (relations_imported_at IS NULL AND relation_plan_hash IS NULL AND relation_payload_hash IS NULL
      AND symbol_edge_count IS NULL AND file_dependency_count IS NULL)
    OR
    (relations_imported_at IS NOT NULL AND relation_plan_hash IS NOT NULL AND relation_payload_hash IS NOT NULL
      AND symbol_edge_count IS NOT NULL AND file_dependency_count IS NOT NULL)
  ),
  ADD CONSTRAINT index_generations_relation_requires_symbols_check CHECK (
    relations_imported_at IS NULL OR symbols_imported_at IS NOT NULL
  );

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (4, 'p1_10_relation_persistence', decode(:'migration_checksum', 'hex'));

COMMIT;
