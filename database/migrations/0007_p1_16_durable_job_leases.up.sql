BEGIN;

ALTER TABLE ue_mcp.jobs
  ADD COLUMN agent_payload jsonb CHECK (agent_payload IS NULL OR
    (jsonb_typeof(agent_payload) = 'object' AND octet_length(agent_payload::text) <= 1048576)),
  ADD COLUMN available_at timestamptz,
  ADD COLUMN next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
  ADD COLUMN lease_token uuid,
  ADD COLUMN completion_manifest jsonb CHECK (completion_manifest IS NULL OR
    (jsonb_typeof(completion_manifest) = 'object' AND octet_length(completion_manifest::text) <= 16384)),
  ADD COLUMN completion_agent_id uuid REFERENCES ue_mcp.agents(id) ON DELETE RESTRICT,
  ADD COLUMN completion_attempt integer CHECK (completion_attempt IS NULL OR completion_attempt BETWEEN 1 AND 100),
  ADD COLUMN last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD COLUMN last_error_retryable boolean,
  ADD COLUMN last_failure_agent_id uuid REFERENCES ue_mcp.agents(id) ON DELETE RESTRICT,
  ADD COLUMN last_failure_attempt integer CHECK (last_failure_attempt IS NULL OR last_failure_attempt BETWEEN 1 AND 100),
  ADD CONSTRAINT jobs_lease_token_state_check CHECK (
    (lease_agent_id IS NULL) = (lease_token IS NULL)
    AND (status = 'running') = (lease_token IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT jobs_completion_manifest_state_check CHECK (
    (completion_manifest IS NULL AND completion_agent_id IS NULL AND completion_attempt IS NULL)
    OR (completion_manifest IS NOT NULL AND completion_agent_id IS NOT NULL AND completion_attempt IS NOT NULL)
  ),
  ADD CONSTRAINT jobs_success_requires_completion_check CHECK (
    status <> 'succeeded' OR completion_manifest IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT jobs_error_state_check CHECK (
    (last_error_code IS NULL AND last_error_retryable IS NULL
      AND last_failure_agent_id IS NULL AND last_failure_attempt IS NULL)
    OR (last_error_code IS NOT NULL AND last_error_retryable IS NOT NULL
      AND last_failure_agent_id IS NOT NULL AND last_failure_attempt IS NOT NULL)
  );

UPDATE ue_mcp.jobs SET available_at = requested_at WHERE available_at IS NULL;
UPDATE ue_mcp.jobs job SET next_event_sequence = COALESCE((
  SELECT max(event.sequence) + 1 FROM ue_mcp.job_events event WHERE event.job_id = job.id
), 0);
UPDATE ue_mcp.jobs SET lease_token = gen_random_uuid() WHERE status = 'running' AND lease_token IS NULL;

ALTER TABLE ue_mcp.jobs VALIDATE CONSTRAINT jobs_lease_token_state_check;

ALTER TABLE ue_mcp.jobs
  ALTER COLUMN available_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN available_at SET NOT NULL;

CREATE INDEX jobs_available_claim_idx
  ON ue_mcp.jobs (priority DESC, available_at, requested_at, id)
  WHERE status = 'queued' AND agent_payload IS NOT NULL;

CREATE UNIQUE INDEX jobs_one_running_lease_per_agent_unique
  ON ue_mcp.jobs (lease_agent_id) WHERE status = 'running';

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (7, 'p1_16_durable_job_leases', decode(:'migration_checksum', 'hex'));

COMMIT;
