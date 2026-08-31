BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 6 AND name = 'p1_14_generation_publication';

DROP TRIGGER generation_publication_events_set_updated_at ON ue_mcp.generation_publication_events;
DROP TABLE ue_mcp.generation_publication_events;

ALTER TABLE ue_mcp.index_generations
  DROP COLUMN publication_version,
  DROP COLUMN gc_claimed_at,
  DROP COLUMN gc_claim_hash,
  DROP COLUMN superseded_at,
  DROP COLUMN embedding_count,
  DROP COLUMN embedding_dimensions,
  DROP COLUMN embedding_model,
  DROP COLUMN embedding_provider,
  DROP COLUMN validated_at,
  DROP COLUMN validation_hash,
  DROP COLUMN manifest_hash;

COMMIT;
