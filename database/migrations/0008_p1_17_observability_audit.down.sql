BEGIN;

DROP INDEX ue_mcp.audit_events_resource_time_idx;
DROP INDEX ue_mcp.audit_events_trace_time_idx;
DROP INDEX ue_mcp.audit_events_correlation_time_idx;

ALTER TABLE ue_mcp.audit_events
  DROP COLUMN error_code,
  DROP COLUMN resource_id,
  DROP COLUMN resource_type,
  DROP COLUMN span_id,
  DROP COLUMN trace_id,
  DROP COLUMN correlation_id;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 8 AND name = 'p1_17_observability_audit';

COMMIT;
