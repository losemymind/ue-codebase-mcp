BEGIN;

ALTER TABLE ue_mcp.index_generations
  ADD COLUMN symbol_plan_hash bytea CHECK (symbol_plan_hash IS NULL OR octet_length(symbol_plan_hash) = 32),
  ADD COLUMN symbol_payload_hash bytea CHECK (symbol_payload_hash IS NULL OR octet_length(symbol_payload_hash) = 32),
  ADD COLUMN symbol_count bigint CHECK (symbol_count IS NULL OR symbol_count >= 0),
  ADD COLUMN symbol_location_count bigint CHECK (symbol_location_count IS NULL OR symbol_location_count >= 0),
  ADD COLUMN symbols_imported_at timestamptz,
  ADD CONSTRAINT index_generations_symbol_import_state_check CHECK (
    (symbols_imported_at IS NULL AND symbol_plan_hash IS NULL AND symbol_payload_hash IS NULL
      AND symbol_count IS NULL AND symbol_location_count IS NULL)
    OR
    (symbols_imported_at IS NOT NULL AND symbol_plan_hash IS NOT NULL AND symbol_payload_hash IS NOT NULL
      AND symbol_count IS NOT NULL AND symbol_location_count IS NOT NULL)
  );

ALTER TABLE ue_mcp.symbols
  ADD COLUMN name text,
  ADD COLUMN display_name text,
  ADD COLUMN owner_usr text,
  ADD COLUMN type_spelling text NOT NULL DEFAULT '',
  ADD COLUMN result_type text NOT NULL DEFAULT '';

UPDATE ue_mcp.symbols
SET name = qualified_name,
    display_name = qualified_name;

ALTER TABLE ue_mcp.symbols
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN display_name SET NOT NULL,
  ADD CONSTRAINT symbols_name_length_check CHECK (length(name) BETWEEN 1 AND 4096),
  ADD CONSTRAINT symbols_display_name_length_check CHECK (length(display_name) BETWEEN 1 AND 4096),
  ADD CONSTRAINT symbols_owner_usr_length_check CHECK (owner_usr IS NULL OR length(owner_usr) BETWEEN 1 AND 4096),
  ADD CONSTRAINT symbols_type_spelling_length_check CHECK (length(type_spelling) <= 65536),
  ADD CONSTRAINT symbols_result_type_length_check CHECK (length(result_type) <= 65536);

ALTER TABLE ue_mcp.symbol_metadata
  ADD COLUMN template_parameters text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN clang_documentation_id text,
  ADD CONSTRAINT symbol_metadata_template_parameters_check CHECK (array_position(template_parameters, NULL) IS NULL),
  ADD CONSTRAINT symbol_metadata_clang_documentation_id_check CHECK (
    clang_documentation_id IS NULL OR clang_documentation_id ~ '^[A-F0-9]{40}$'
  );

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (3, 'p1_09_symbol_persistence', decode(:'migration_checksum', 'hex'));

COMMIT;
