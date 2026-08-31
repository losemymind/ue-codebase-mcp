BEGIN;

ALTER TABLE ue_mcp.index_generations
  ADD COLUMN manifest_hash bytea CHECK (manifest_hash IS NULL OR octet_length(manifest_hash) = 32),
  ADD COLUMN validation_hash bytea CHECK (validation_hash IS NULL OR octet_length(validation_hash) = 32),
  ADD COLUMN validated_at timestamptz,
  ADD COLUMN embedding_provider text CHECK (embedding_provider IS NULL OR length(embedding_provider) BETWEEN 1 AND 128),
  ADD COLUMN embedding_model text CHECK (embedding_model IS NULL OR length(embedding_model) BETWEEN 1 AND 256),
  ADD COLUMN embedding_dimensions integer CHECK (embedding_dimensions IS NULL OR embedding_dimensions BETWEEN 1 AND 16000),
  ADD COLUMN embedding_count bigint CHECK (embedding_count IS NULL OR embedding_count >= 0),
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN gc_claim_hash bytea CHECK (gc_claim_hash IS NULL OR octet_length(gc_claim_hash) = 32),
  ADD COLUMN gc_claimed_at timestamptz,
  ADD COLUMN publication_version bigint NOT NULL DEFAULT 0 CHECK (publication_version >= 0),
  ADD CONSTRAINT index_generations_validation_state_check CHECK (
    (validated_at IS NULL AND manifest_hash IS NULL AND validation_hash IS NULL
      AND embedding_provider IS NULL AND embedding_model IS NULL
      AND embedding_dimensions IS NULL AND embedding_count IS NULL)
    OR
    (validated_at IS NOT NULL AND manifest_hash IS NOT NULL AND validation_hash IS NOT NULL
      AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL
      AND embedding_dimensions IS NOT NULL AND embedding_count IS NOT NULL)
  ),
  ADD CONSTRAINT index_generations_publish_requires_validation_check CHECK (
    status NOT IN ('ready', 'active', 'superseded') OR validated_at IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT index_generations_superseded_state_check CHECK (
    (status = 'superseded') = (superseded_at IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT index_generations_gc_claim_state_check CHECK (
    (gc_claim_hash IS NULL) = (gc_claimed_at IS NULL)
  ) NOT VALID;

CREATE TABLE ue_mcp.generation_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE RESTRICT,
  target_generation_id uuid NOT NULL,
  previous_active_generation_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('staged', 'validated', 'validation_failed', 'published', 'rolled_back', 'gc_claimed', 'gc_deleted')),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'agent', 'system')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  publication_version bigint NOT NULL CHECK (publication_version >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (previous_active_generation_id IS NULL OR previous_active_generation_id <> target_generation_id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX generation_publication_events_project_time_idx
  ON ue_mcp.generation_publication_events (project_id, occurred_at DESC, id);
CREATE INDEX generation_publication_events_target_idx
  ON ue_mcp.generation_publication_events (target_generation_id, occurred_at DESC);

CREATE TRIGGER generation_publication_events_set_updated_at
BEFORE UPDATE ON ue_mcp.generation_publication_events
FOR EACH ROW EXECUTE FUNCTION ue_mcp.set_updated_at();

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (6, 'p1_14_generation_publication', decode(:'migration_checksum', 'hex'));

COMMIT;
