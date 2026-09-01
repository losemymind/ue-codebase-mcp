BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 7 AND name = 'p1_16_durable_job_leases';

DROP INDEX ue_mcp.jobs_one_running_lease_per_agent_unique;
DROP INDEX ue_mcp.jobs_available_claim_idx;

ALTER TABLE ue_mcp.jobs
  DROP COLUMN last_failure_attempt,
  DROP COLUMN last_failure_agent_id,
  DROP COLUMN last_error_retryable,
  DROP COLUMN last_error_code,
  DROP COLUMN completion_attempt,
  DROP COLUMN completion_agent_id,
  DROP COLUMN completion_manifest,
  DROP COLUMN lease_token,
  DROP COLUMN next_event_sequence,
  DROP COLUMN available_at,
  DROP COLUMN agent_payload;

COMMIT;
