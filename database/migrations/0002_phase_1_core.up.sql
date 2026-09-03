BEGIN;

SET LOCAL search_path = ue_mcp, public, pg_catalog;

CREATE FUNCTION ue_mcp.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE ue_mcp.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE CHECK (length(external_subject) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.team_memberships (
  team_id uuid NOT NULL REFERENCES ue_mcp.teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES ue_mcp.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('member', 'maintainer')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (team_id, user_id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX team_memberships_user_idx ON ue_mcp.team_memberships (user_id, team_id);

CREATE TABLE ue_mcp.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('user', 'service')),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 512),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) >= 32),
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (array_position(scopes, NULL) IS NULL),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (updated_at >= created_at)
);
CREATE INDEX api_tokens_owner_idx ON ue_mcp.api_tokens (owner_type, owner_id);
CREATE INDEX api_tokens_active_expiry_idx ON ue_mcp.api_tokens (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE ue_mcp.oidc_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  issuer text NOT NULL CHECK (issuer ~ '^https://'),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 512),
  jwks_uri text NOT NULL CHECK (jwks_uri ~ '^https://'),
  claims_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(claims_config) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (issuer, audience),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  ue_version text NOT NULL CHECK (ue_version ~ '^5\.6(\.[0-9]+)?$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.project_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'team', 'service')),
  principal_id text NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 512),
  role text NOT NULL CHECK (role IN ('reader', 'operator', 'administrator')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, principal_type, principal_id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX project_permissions_principal_idx ON ue_mcp.project_permissions (principal_type, principal_id, project_id);

CREATE TABLE ue_mcp.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'svn' CHECK (kind = 'svn'),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https?://|^svn(\+ssh)?://'),
  role text NOT NULL CHECK (role IN ('engine', 'game', 'plugin', 'dependency')),
  credential_ref text NOT NULL CHECK (
    length(credential_ref) BETWEEN 1 AND 512
    AND credential_ref ~ '^[A-Za-z][A-Za-z0-9_.:/-]*$'
  ),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, canonical_url),
  CHECK (updated_at >= created_at)
);
CREATE INDEX repositories_project_enabled_idx ON ue_mcp.repositories (project_id, enabled);

CREATE TABLE ue_mcp.repository_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES ue_mcp.repositories(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  svn_url text NOT NULL CHECK (svn_url ~ '^https?://|^svn(\+ssh)?://'),
  tracking_policy text NOT NULL CHECK (tracking_policy IN ('continuous', 'manual')),
  head_revision bigint CHECK (head_revision >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_id, name),
  UNIQUE (repository_id, svn_url),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_branch_id uuid NOT NULL REFERENCES ue_mcp.repository_branches(id) ON DELETE CASCADE,
  vcs_revision bigint NOT NULL CHECK (vcs_revision >= 0),
  observed_at timestamptz NOT NULL,
  author text,
  message_hash bytea CHECK (message_hash IS NULL OR octet_length(message_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_branch_id, vcs_revision),
  UNIQUE (id, repository_branch_id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX revisions_branch_observed_idx ON ue_mcp.revisions (repository_branch_id, observed_at DESC);

CREATE TABLE ue_mcp.svn_access_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES ue_mcp.repositories(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision >= 0),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  effective_access text NOT NULL CHECK (effective_access IN ('none', 'read')),
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (repository_id, revision, subject),
  CHECK (expires_at > captured_at),
  CHECK (updated_at >= created_at)
);
CREATE INDEX svn_access_snapshots_lookup_idx ON ue_mcp.svn_access_snapshots (repository_id, subject, captured_at DESC);

CREATE TABLE ue_mcp.index_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE CASCADE,
  revision_set_hash bytea NOT NULL CHECK (octet_length(revision_set_hash) = 32),
  status text NOT NULL CHECK (status IN ('building', 'ready', 'active', 'failed', 'superseded')),
  started_at timestamptz NOT NULL,
  published_at timestamptz,
  manifest_uri text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, revision_set_hash),
  CHECK (published_at IS NULL OR published_at >= started_at),
  CHECK ((status IN ('active', 'superseded')) = (published_at IS NOT NULL)),
  CHECK (status NOT IN ('ready', 'active', 'superseded') OR manifest_uri IS NOT NULL),
  CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX index_generations_one_active_per_project_idx ON ue_mcp.index_generations (project_id) WHERE status = 'active';
CREATE INDEX index_generations_project_status_idx ON ue_mcp.index_generations (project_id, status, started_at DESC);

CREATE TABLE ue_mcp.generation_revisions (
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  repository_branch_id uuid NOT NULL REFERENCES ue_mcp.repository_branches(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation_id, repository_branch_id),
  UNIQUE (generation_id, revision_id),
  FOREIGN KEY (revision_id, repository_branch_id) REFERENCES ue_mcp.revisions(id, repository_branch_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES ue_mcp.repositories(id) ON DELETE RESTRICT,
  path text NOT NULL CHECK (path <> '' AND path !~ '(^|/)\.\.(/|$)' AND path !~ '^[\\/]'),
  language text NOT NULL CHECK (language IN ('c', 'cpp', 'header', 'objective-cpp', 'csharp', 'json', 'text')),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  line_count integer NOT NULL CHECK (line_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (generation_id, repository_id, path),
  CHECK (updated_at >= created_at)
);
CREATE INDEX files_path_lookup_idx ON ue_mcp.files (generation_id, path);

CREATE TABLE ue_mcp.file_dependencies (
  src_file_id uuid NOT NULL REFERENCES ue_mcp.files(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN ('include', 'import', 'generated_from')),
  dst_file_id uuid NOT NULL REFERENCES ue_mcp.files(id) ON DELETE CASCADE,
  condition_hash bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex') CHECK (octet_length(condition_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (src_file_id, edge_type, dst_file_id, condition_hash),
  CHECK (src_file_id <> dst_file_id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX file_dependencies_dst_idx ON ue_mcp.file_dependencies (dst_file_id, edge_type, src_file_id);

CREATE TABLE ue_mcp.index_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 2048),
  error_class text NOT NULL CHECK (length(error_class) BETWEEN 1 AND 128),
  diagnostic jsonb NOT NULL CHECK (jsonb_typeof(diagnostic) = 'object'),
  retry_state text NOT NULL CHECK (retry_state IN ('retryable', 'retrying', 'permanent', 'resolved')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((retry_state = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (updated_at >= created_at)
);
CREATE INDEX index_failures_pending_idx ON ue_mcp.index_failures (generation_id, retry_state, next_retry_at) WHERE retry_state <> 'resolved';

CREATE TABLE ue_mcp.modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  module_type text NOT NULL CHECK (module_type IN ('runtime', 'editor', 'developer', 'program', 'third_party')),
  plugin_id text,
  build_file_id uuid REFERENCES ue_mcp.files(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (generation_id, name),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.module_dependencies (
  src_module_id uuid NOT NULL REFERENCES ue_mcp.modules(id) ON DELETE CASCADE,
  dst_module_id uuid NOT NULL REFERENCES ue_mcp.modules(id) ON DELETE CASCADE,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private', 'dynamic', 'circular')),
  condition text NOT NULL DEFAULT '',
  source_file_id uuid REFERENCES ue_mcp.files(id) ON DELETE SET NULL,
  source_line integer CHECK (source_line > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (src_module_id, dst_module_id, visibility, condition),
  CHECK (src_module_id <> dst_module_id OR visibility = 'circular'),
  CHECK ((source_file_id IS NULL) = (source_line IS NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX module_dependencies_dst_idx ON ue_mcp.module_dependencies (dst_module_id, visibility, src_module_id);

CREATE TABLE ue_mcp.symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  stable_usr text NOT NULL CHECK (length(stable_usr) BETWEEN 1 AND 4096),
  qualified_name text NOT NULL CHECK (length(qualified_name) BETWEEN 1 AND 4096),
  kind text NOT NULL CHECK (kind IN ('namespace', 'module', 'class', 'struct', 'union', 'enum', 'enumerator', 'function', 'method', 'constructor', 'destructor', 'variable', 'field', 'parameter', 'typedef', 'type_alias', 'macro', 'concept')),
  module_id uuid REFERENCES ue_mcp.modules(id) ON DELETE SET NULL,
  owner_symbol_id uuid REFERENCES ue_mcp.symbols(id) ON DELETE SET NULL,
  signature_hash bytea NOT NULL CHECK (octet_length(signature_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (generation_id, stable_usr),
  CHECK (owner_symbol_id IS NULL OR owner_symbol_id <> id),
  CHECK (updated_at >= created_at)
);
CREATE INDEX symbols_name_idx ON ue_mcp.symbols (generation_id, qualified_name, kind);
CREATE INDEX symbols_owner_idx ON ue_mcp.symbols (owner_symbol_id) WHERE owner_symbol_id IS NOT NULL;

CREATE TABLE ue_mcp.symbol_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol_id uuid NOT NULL REFERENCES ue_mcp.symbols(id) ON DELETE CASCADE,
  location_kind text NOT NULL CHECK (location_kind IN ('declaration', 'definition', 'reference', 'generated')),
  file_id uuid NOT NULL REFERENCES ue_mcp.files(id) ON DELETE CASCADE,
  start_line integer NOT NULL CHECK (start_line > 0),
  start_column integer NOT NULL CHECK (start_column > 0),
  end_line integer NOT NULL CHECK (end_line > 0),
  end_column integer NOT NULL CHECK (end_column > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (symbol_id, location_kind, file_id, start_line, start_column, end_line, end_column),
  CHECK (end_line > start_line OR (end_line = start_line AND end_column >= start_column)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX symbol_locations_file_idx ON ue_mcp.symbol_locations (file_id, start_line, start_column);

CREATE TABLE ue_mcp.symbol_metadata (
  symbol_id uuid PRIMARY KEY REFERENCES ue_mcp.symbols(id) ON DELETE CASCADE,
  uht_specifiers text[] NOT NULL DEFAULT '{}'::text[],
  uht_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(uht_metadata) = 'object'),
  blueprint_exposure text NOT NULL DEFAULT 'none' CHECK (blueprint_exposure IN ('none', 'callable', 'pure', 'event', 'type', 'property')),
  documentation text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (array_position(uht_specifiers, NULL) IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.symbol_edges (
  src_symbol_id uuid NOT NULL REFERENCES ue_mcp.symbols(id) ON DELETE CASCADE,
  edge_type text NOT NULL CHECK (edge_type IN ('calls', 'references', 'inherits', 'overrides', 'owns', 'instantiates', 'aliases')),
  dst_symbol_id uuid NOT NULL REFERENCES ue_mcp.symbols(id) ON DELETE CASCADE,
  file_id uuid REFERENCES ue_mcp.files(id) ON DELETE SET NULL,
  line integer CHECK (line > 0),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((file_id IS NULL) = (line IS NULL)),
  CHECK (updated_at >= created_at),
  UNIQUE NULLS NOT DISTINCT (src_symbol_id, edge_type, dst_symbol_id, file_id, line)
);
CREATE INDEX symbol_edges_outgoing_idx ON ue_mcp.symbol_edges (src_symbol_id, edge_type, dst_symbol_id);
CREATE INDEX symbol_edges_incoming_idx ON ue_mcp.symbol_edges (dst_symbol_id, edge_type, src_symbol_id);

CREATE TABLE ue_mcp.code_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  symbol_id uuid REFERENCES ue_mcp.symbols(id) ON DELETE SET NULL,
  file_id uuid NOT NULL REFERENCES ue_mcp.files(id) ON DELETE CASCADE,
  chunk_kind text NOT NULL CHECK (chunk_kind IN ('declaration', 'definition', 'documentation', 'file_context')),
  text text NOT NULL CHECK (text <> ''),
  token_count integer NOT NULL CHECK (token_count > 0),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);
CREATE INDEX code_chunks_generation_file_idx ON ue_mcp.code_chunks (generation_id, file_id, chunk_kind);
CREATE INDEX code_chunks_symbol_idx ON ue_mcp.code_chunks (symbol_id) WHERE symbol_id IS NOT NULL;
CREATE INDEX code_chunks_search_vector_idx ON ue_mcp.code_chunks USING gin (search_vector);

CREATE TABLE ue_mcp.chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES ue_mcp.code_chunks(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  embedding vector NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chunk_id, provider, model),
  CHECK (vector_dims(embedding) = dimensions),
  CHECK (updated_at >= created_at)
);
CREATE INDEX chunk_embeddings_model_idx ON ue_mcp.chunk_embeddings (provider, model, dimensions, chunk_id);
CREATE INDEX chunk_embeddings_content_idx ON ue_mcp.chunk_embeddings (provider, model, content_hash);
CREATE INDEX chunk_embeddings_1536_cosine_idx ON ue_mcp.chunk_embeddings
USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
WHERE dimensions = 1536;
COMMENT ON COLUMN ue_mcp.chunk_embeddings.embedding IS 'Variable-dimension pgvector value. A 1536-dimension cosine HNSW baseline is provisioned; P1-12 must add model-specific partial ANN indexes for configured dimensions.';

CREATE TABLE ue_mcp.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key text NOT NULL UNIQUE CHECK (agent_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  last_heartbeat_at timestamptz,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'draining', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at >= created_at),
  CHECK (updated_at >= created_at)
);
CREATE INDEX agents_status_heartbeat_idx ON ue_mcp.agents (status, last_heartbeat_at);

CREATE TABLE ue_mcp.job_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('reindex', 'ubt_build', 'uat_test')),
  target text,
  platform text,
  configuration text,
  allowlisted_args jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowlisted_args) = 'array'),
  resource_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resource_policy) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, name, version),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES ue_mcp.projects(id) ON DELETE RESTRICT,
  preset_id uuid REFERENCES ue_mcp.job_presets(id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('reindex', 'ubt_build', 'uat_test')),
  requester_type text NOT NULL CHECK (requester_type IN ('user', 'service', 'system')),
  requester_id text NOT NULL CHECK (length(requester_id) BETWEEN 1 AND 512),
  revision_set jsonb NOT NULL CHECK (jsonb_typeof(revision_set) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  lease_agent_id uuid REFERENCES ue_mcp.agents(id) ON DELETE RESTRICT,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  cancellation_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_agent_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (started_at IS NULL OR started_at >= requested_at),
  CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, requested_at)),
  CHECK (cancellation_requested_at IS NULL OR cancellation_requested_at >= requested_at),
  CHECK (status <> 'queued' OR (started_at IS NULL AND finished_at IS NULL AND lease_agent_id IS NULL)),
  CHECK (status <> 'running' OR (started_at IS NOT NULL AND finished_at IS NULL AND lease_agent_id IS NOT NULL)),
  CHECK (status NOT IN ('succeeded', 'failed', 'cancelled') OR (finished_at IS NOT NULL AND lease_agent_id IS NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX jobs_claim_idx ON ue_mcp.jobs (priority DESC, requested_at, id) WHERE status = 'queued';
CREATE INDEX jobs_expired_lease_idx ON ue_mcp.jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_project_status_idx ON ue_mcp.jobs (project_id, status, requested_at DESC);

CREATE TABLE ue_mcp.job_events (
  job_id uuid NOT NULL REFERENCES ue_mcp.jobs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,127}$'),
  redacted_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(redacted_payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, sequence),
  CHECK (updated_at >= created_at)
);
CREATE INDEX job_events_occurred_idx ON ue_mcp.job_events (job_id, occurred_at);

CREATE TABLE ue_mcp.job_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES ue_mcp.jobs(id) ON DELETE CASCADE,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('manifest', 'build_log', 'test_result', 'report', 'archive')),
  uri text NOT NULL CHECK (length(uri) BETWEEN 1 AND 4096),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  retain_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, artifact_kind, uri),
  CHECK (retain_until > created_at),
  CHECK (updated_at >= created_at)
);

CREATE TABLE ue_mcp.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'agent', 'system')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 256),
  project_id uuid REFERENCES ue_mcp.projects(id) ON DELETE RESTRICT,
  tool text,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  source_ip inet,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at)
);
CREATE INDEX audit_events_project_time_idx ON ue_mcp.audit_events (project_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx ON ue_mcp.audit_events (actor_type, actor_id, occurred_at DESC);

CREATE TABLE ue_mcp.backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('full', 'incremental', 'verification', 'restore_test')),
  generation_id uuid REFERENCES ue_mcp.index_generations(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  manifest_uri text,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK ((status = 'running') = (completed_at IS NULL)),
  CHECK (status <> 'succeeded' OR manifest_uri IS NOT NULL),
  CHECK (updated_at >= created_at)
);
CREATE INDEX backup_runs_status_time_idx ON ue_mcp.backup_runs (status, started_at DESC);

CREATE TABLE ue_mcp.evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  language text NOT NULL CHECK (language IN ('zh-CN', 'en-US')),
  query text NOT NULL CHECK (query <> ''),
  expected_evidence jsonb NOT NULL CHECK (jsonb_typeof(expected_evidence) = 'array'),
  tags text[] NOT NULL DEFAULT '{}'::text[],
  approved_version integer NOT NULL CHECK (approved_version > 0),
  approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (array_position(tags, NULL) IS NULL),
  CHECK (updated_at >= created_at)
);
CREATE INDEX evaluation_cases_language_tags_idx ON ue_mcp.evaluation_cases USING gin (tags);

CREATE TABLE ue_mcp.evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES ue_mcp.index_generations(id) ON DELETE CASCADE,
  suite_version integer NOT NULL CHECK (suite_version > 0),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  passed boolean NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (generation_id, suite_version),
  CHECK (completed_at >= started_at),
  CHECK (updated_at >= created_at)
);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'teams', 'team_memberships', 'api_tokens', 'oidc_providers',
    'projects', 'project_permissions', 'repositories', 'repository_branches',
    'revisions', 'svn_access_snapshots', 'index_generations',
    'generation_revisions', 'files', 'file_dependencies', 'index_failures',
    'modules', 'module_dependencies', 'symbols', 'symbol_locations',
    'symbol_metadata', 'symbol_edges', 'code_chunks', 'chunk_embeddings',
    'agents', 'job_presets', 'jobs', 'job_events', 'job_artifacts',
    'audit_events', 'backup_runs', 'evaluation_cases', 'evaluation_runs'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON ue_mcp.%I FOR EACH ROW EXECUTE FUNCTION ue_mcp.set_updated_at()',
      table_name
    );
  END LOOP;
END;
$$;

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (2, 'phase_1_core', decode(:'migration_checksum', 'hex'));

COMMIT;
