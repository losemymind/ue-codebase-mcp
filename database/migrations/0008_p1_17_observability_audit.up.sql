BEGIN;

ALTER TABLE ue_mcp.audit_events
  ADD COLUMN correlation_id uuid,
  ADD COLUMN trace_id text,
  ADD COLUMN span_id text,
  ADD COLUMN resource_type text,
  ADD COLUMN resource_id text,
  ADD COLUMN error_code text;

UPDATE ue_mcp.audit_events
SET correlation_id = id,
    trace_id = replace(gen_random_uuid()::text, '-', ''),
    span_id = substring(replace(gen_random_uuid()::text, '-', '') from 1 for 16)
WHERE correlation_id IS NULL;

ALTER TABLE ue_mcp.audit_events
  ALTER COLUMN correlation_id SET NOT NULL,
  ALTER COLUMN trace_id SET NOT NULL,
  ALTER COLUMN span_id SET NOT NULL,
  ADD CONSTRAINT audit_events_trace_id_check CHECK (trace_id ~ '^[a-f0-9]{32}$' AND trace_id <> repeat('0', 32)),
  ADD CONSTRAINT audit_events_span_id_check CHECK (span_id ~ '^[a-f0-9]{16}$' AND span_id <> repeat('0', 16)),
  ADD CONSTRAINT audit_events_resource_type_check CHECK (
    resource_type IS NULL OR resource_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
  ),
  ADD CONSTRAINT audit_events_resource_id_check CHECK (
    resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 512
  ),
  ADD CONSTRAINT audit_events_error_code_check CHECK (
    error_code IS NULL OR error_code ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
  );

CREATE INDEX audit_events_correlation_time_idx ON ue_mcp.audit_events (correlation_id, occurred_at DESC);
CREATE INDEX audit_events_trace_time_idx ON ue_mcp.audit_events (trace_id, occurred_at DESC);
CREATE INDEX audit_events_resource_time_idx ON ue_mcp.audit_events (resource_type, resource_id, occurred_at DESC)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (8, 'p1_17_observability_audit', decode(:'migration_checksum', 'hex'));

COMMIT;
