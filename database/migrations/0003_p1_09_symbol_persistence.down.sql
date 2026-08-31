BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 3 AND name = 'p1_09_symbol_persistence';

ALTER TABLE ue_mcp.symbol_metadata
  DROP COLUMN clang_documentation_id,
  DROP COLUMN template_parameters;

ALTER TABLE ue_mcp.symbols
  DROP COLUMN result_type,
  DROP COLUMN type_spelling,
  DROP COLUMN owner_usr,
  DROP COLUMN display_name,
  DROP COLUMN name;

ALTER TABLE ue_mcp.index_generations
  DROP COLUMN symbols_imported_at,
  DROP COLUMN symbol_location_count,
  DROP COLUMN symbol_count,
  DROP COLUMN symbol_payload_hash,
  DROP COLUMN symbol_plan_hash;

COMMIT;
