import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migrationRoot = path.join(root, 'database', 'migrations');
const manifest = JSON.parse(await readFile(path.join(migrationRoot, 'manifest.json'), 'utf8'));

const expectedTables = [
  'users',
  'teams',
  'team_memberships',
  'api_tokens',
  'oidc_providers',
  'projects',
  'project_permissions',
  'repositories',
  'repository_branches',
  'revisions',
  'svn_access_snapshots',
  'index_generations',
  'generation_revisions',
  'files',
  'file_dependencies',
  'index_failures',
  'modules',
  'module_dependencies',
  'symbols',
  'symbol_locations',
  'symbol_metadata',
  'symbol_edges',
  'code_chunks',
  'chunk_embeddings',
  'agents',
  'job_presets',
  'jobs',
  'job_events',
  'job_artifacts',
  'audit_events',
  'backup_runs',
  'evaluation_cases',
  'evaluation_runs',
];

function tableNames(sql, operation) {
  return [...sql.matchAll(new RegExp(`${operation} TABLE ue_mcp\\.([a-z_]+)`, 'g'))].map((match) => match[1]);
}

test('migration manifest is contiguous and every migration is transactional', async () => {
  assert.equal(manifest.schema, 'ue_mcp');
  assert.deepEqual(manifest.migrations.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  for (const migration of manifest.migrations) {
    for (const direction of ['up', 'down']) {
      const sql = await readFile(path.join(migrationRoot, migration[direction]), 'utf8');
      assert.match(sql, /^BEGIN;\n/);
      assert.match(sql, /\nCOMMIT;\n$/);
      assert.doesNotMatch(sql, /DROP[^;]*\bCASCADE\b/);
      if (direction === 'up') {
        assert.match(sql, /INSERT INTO ue_mcp\.schema_migrations \(version, name, checksum\)/);
        assert.match(sql, /decode\(:'migration_checksum', 'hex'\)/);
      }
    }
  }
});

test('P1-09 persistence migration preserves full symbol data and binds atomic imports', async () => {
  const up = await readFile(path.join(migrationRoot, '0003_p1_09_symbol_persistence.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0003_p1_09_symbol_persistence.down.sql'), 'utf8');
  for (const field of ['name', 'display_name', 'owner_usr', 'type_spelling', 'result_type']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
  }
  for (const field of ['template_parameters', 'clang_documentation_id']) assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
  for (const field of ['symbol_plan_hash', 'symbol_payload_hash', 'symbol_count', 'symbol_location_count', 'symbols_imported_at']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /index_generations_symbol_import_state_check/);
  assert.match(up, /VALUES \(3, 'p1_09_symbol_persistence'/);
  assert.match(down, /version = 3 AND name = 'p1_09_symbol_persistence'/);
});

test('P1-10 persistence migration atomically binds relation imports after symbols', async () => {
  const up = await readFile(path.join(migrationRoot, '0004_p1_10_relation_persistence.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0004_p1_10_relation_persistence.down.sql'), 'utf8');
  for (const field of ['relation_plan_hash', 'relation_payload_hash', 'symbol_edge_count', 'file_dependency_count', 'relations_imported_at']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /index_generations_relation_import_state_check/);
  assert.match(up, /index_generations_relation_requires_symbols_check/);
  assert.match(up, /relations_imported_at IS NULL OR symbols_imported_at IS NOT NULL/);
  assert.match(up, /VALUES \(4, 'p1_10_relation_persistence'/);
  assert.match(down, /version = 4 AND name = 'p1_10_relation_persistence'/);
});

test('P1-12 persistence migration adds stable chunk identity and atomic import markers', async () => {
  const up = await readFile(path.join(migrationRoot, '0005_p1_12_chunk_persistence.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0005_p1_12_chunk_persistence.down.sql'), 'utf8');
  for (const field of ['stable_key', 'content_hash', 'start_line', 'start_column', 'end_line', 'end_column', 'part_index', 'part_count']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  for (const field of ['chunk_plan_hash', 'chunk_payload_hash', 'code_chunk_count', 'chunks_imported_at']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /code_chunks_generation_stable_key_unique UNIQUE \(generation_id, stable_key\)/);
  assert.doesNotMatch(up, /\bdigest\s*\(/);
  assert.match(up, /index_generations_chunk_import_state_check/);
  assert.match(up, /chunks_imported_at IS NULL OR symbols_imported_at IS NOT NULL/);
  assert.match(up, /VALUES \(5, 'p1_12_chunk_persistence'/);
});

test('P1-14 migration binds validated publication evidence, fencing, audit history, and reversible GC support', async () => {
  const up = await readFile(path.join(migrationRoot, '0006_p1_14_generation_publication.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0006_p1_14_generation_publication.down.sql'), 'utf8');
  for (const field of ['manifest_hash', 'validation_hash', 'validated_at', 'embedding_provider', 'embedding_model',
    'embedding_dimensions', 'embedding_count', 'superseded_at', 'gc_claim_hash', 'gc_claimed_at', 'publication_version']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /index_generations_validation_state_check/);
  assert.match(up, /index_generations_gc_claim_state_check/);
  assert.match(up, /status NOT IN \('ready', 'active', 'superseded'\) OR validated_at IS NOT NULL/);
  assert.match(up, /CREATE TABLE ue_mcp\.generation_publication_events/);
  assert.match(up, /'staged', 'validated', 'validation_failed', 'published', 'rolled_back', 'gc_claimed', 'gc_deleted'/);
  assert.match(up, /target_generation_id uuid NOT NULL/);
  assert.doesNotMatch(up, /target_generation_id uuid NOT NULL REFERENCES/, 'GC audit identity must survive generation deletion');
  assert.match(up, /VALUES \(6, 'p1_14_generation_publication'/);
  assert.match(down, /version = 6 AND name = 'p1_14_generation_publication'/);
  assert.match(down, /DROP TABLE ue_mcp\.generation_publication_events/);
});

test('P1-16 migration binds durable job payloads, availability, fencing, events and terminal evidence', async () => {
  const up = await readFile(path.join(migrationRoot, '0007_p1_16_durable_job_leases.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0007_p1_16_durable_job_leases.down.sql'), 'utf8');
  for (const field of ['agent_payload', 'available_at', 'next_event_sequence', 'lease_token', 'completion_manifest',
    'completion_agent_id', 'completion_attempt', 'last_error_code', 'last_error_retryable', 'last_failure_agent_id',
    'last_failure_attempt']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /jobs_lease_token_state_check/);
  assert.match(up, /\(status = 'running'\) = \(lease_token IS NOT NULL\)/);
  assert.match(up, /VALIDATE CONSTRAINT jobs_lease_token_state_check/);
  assert.match(up, /max\(event\.sequence\) \+ 1/);
  assert.match(up, /octet_length\(agent_payload::text\) <= 1048576/);
  assert.match(up, /octet_length\(completion_manifest::text\) <= 16384/);
  assert.match(up, /jobs_completion_manifest_state_check/);
  assert.match(up, /jobs_success_requires_completion_check/);
  assert.match(up, /jobs_error_state_check/);
  assert.match(up, /jobs_available_claim_idx/);
  assert.match(up, /CREATE UNIQUE INDEX jobs_one_running_lease_per_agent_unique/);
  assert.match(up, /ON ue_mcp\.jobs \(lease_agent_id\) WHERE status = 'running'/);
  assert.match(up, /WHERE status = 'queued' AND agent_payload IS NOT NULL/);
  assert.match(up, /VALUES \(7, 'p1_16_durable_job_leases'/);
  assert.match(down, /version = 7 AND name = 'p1_16_durable_job_leases'/);
});

test('P1-17 migration makes correlation and trace audit evidence durable and indexed', async () => {
  const up = await readFile(path.join(migrationRoot, '0008_p1_17_observability_audit.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0008_p1_17_observability_audit.down.sql'), 'utf8');
  for (const field of ['correlation_id', 'trace_id', 'span_id', 'resource_type', 'resource_id', 'error_code']) {
    assert.match(up, new RegExp(`ADD COLUMN ${field}\\b`));
    assert.match(down, new RegExp(`DROP COLUMN ${field}\\b`));
  }
  assert.match(up, /ALTER COLUMN correlation_id SET NOT NULL/);
  assert.match(up, /audit_events_trace_id_check/);
  assert.match(up, /audit_events_span_id_check/);
  assert.match(up, /audit_events_correlation_time_idx/);
  assert.match(up, /audit_events_trace_time_idx/);
  assert.match(up, /audit_events_resource_time_idx/);
  assert.match(up, /VALUES \(8, 'p1_17_observability_audit'/);
  assert.match(up, /decode\(:'migration_checksum', 'hex'\)/);
  assert.match(down, /version = 8 AND name = 'p1_17_observability_audit'/);
});

test('P1-18 auth migration adds explicit SVN identities and path-scoped snapshots without granting legacy users', async () => {
  const up = await readFile(path.join(migrationRoot, '0009_p1_18_auth_persistence.up.sql'), 'utf8');
  const down = await readFile(path.join(migrationRoot, '0009_p1_18_auth_persistence.down.sql'), 'utf8');
  assert.match(up, /ADD COLUMN svn_subject text;/);
  assert.doesNotMatch(up, /UPDATE ue_mcp\.users[\s\S]*svn_subject/u);
  assert.match(up, /CREATE TABLE ue_mcp\.service_principals/);
  assert.match(up, /ADD COLUMN path_prefix text;/);
  assert.match(up, /path_prefix IS NULL OR/);
  assert.match(up, /position\(E'\\\\' IN path_prefix\) = 0/);
  assert.match(up, /svn_access_snapshots_legacy_scope_unique/);
  assert.match(up, /WHERE path_prefix IS NULL/);
  assert.match(up, /svn_access_snapshots_path_scope_unique/);
  assert.match(up, /WHERE path_prefix IS NOT NULL/);
  assert.match(up, /length\(path_prefix\) DESC/);
  assert.match(up, /VALUES \(9, 'p1_18_auth_persistence'/);
  assert.match(down, /cannot remove path authorization while multiple path snapshots exist/);
  assert.match(down, /DROP TABLE ue_mcp\.service_principals/);
  assert.match(down, /DROP COLUMN svn_subject/);
  assert.match(down, /version = 9 AND name = 'p1_18_auth_persistence'/);
});

test('core migration covers phase 1 sections 5.1 through 5.3 and 5.5 only', async () => {
  const sql = await readFile(path.join(migrationRoot, '0002_phase_1_core.up.sql'), 'utf8');
  const bootstrap = await readFile(path.join(migrationRoot, '0001_bootstrap.up.sql'), 'utf8');
  assert.deepEqual(tableNames(sql, 'CREATE'), expectedTables);

  for (const phase2Table of ['assets', 'asset_packages', 'asset_graphs', 'asset_nodes', 'asset_pins', 'asset_edges']) {
    assert.doesNotMatch(sql, new RegExp(`CREATE TABLE ue_mcp\\.${phase2Table}\\b`));
  }

  assert.match(bootstrap, /CREATE EXTENSION IF NOT EXISTS vector;/, 'bootstrap must install pgvector');
  assert.match(sql, /embedding vector NOT NULL/);
  assert.match(sql, /CHECK \(vector_dims\(embedding\) = dimensions\)/);
  assert.match(sql, /USING hnsw \(\(embedding::vector\(1536\)\) vector_cosine_ops\)/);
  assert.match(sql, /WHERE dimensions = 1536/);
  assert.match(sql, /search_vector tsvector GENERATED ALWAYS AS/);
  assert.match(sql, /USING gin \(search_vector\)/);
  assert.match(sql, /BEFORE UPDATE ON ue_mcp\.%I/);
});

test('every business table has timestamps and key security/time constraints are present', async () => {
  const sql = await readFile(path.join(migrationRoot, '0002_phase_1_core.up.sql'), 'utf8');
  const bodies = new Map(
    [...sql.matchAll(/CREATE TABLE ue_mcp\.([a-z_]+) \(([\s\S]*?)\n\);/g)].map((match) => [match[1], match[2]]),
  );
  assert.equal(bodies.size, expectedTables.length);

  for (const table of expectedTables) {
    assert.match(bodies.get(table), /created_at timestamptz NOT NULL/);
    assert.match(bodies.get(table), /updated_at timestamptz NOT NULL/);
    assert.match(bodies.get(table), /CHECK \(updated_at >= created_at\)/);
  }

  assert.match(bodies.get('repositories'), /CHECK \(kind = 'svn'\)/);
  assert.match(bodies.get('projects'), /ue_version ~ '\^5\\\.6/);
  assert.match(bodies.get('api_tokens'), /token_hash bytea NOT NULL UNIQUE CHECK \(octet_length\(token_hash\) >= 32\)/);
  assert.match(bodies.get('api_tokens'), /CHECK \(expires_at > created_at\)/);
  assert.match(bodies.get('generation_revisions'), /PRIMARY KEY \(generation_id, repository_branch_id\)/);
  assert.match(bodies.get('index_generations'), /published_at IS NULL OR published_at >= started_at/);
  assert.match(bodies.get('jobs'), /status <> 'running'.*lease_agent_id IS NOT NULL/s);
  assert.match(bodies.get('jobs'), /status NOT IN \('succeeded', 'failed', 'cancelled'\).*lease_agent_id IS NULL/s);
  assert.match(bodies.get('job_presets'), /allowlisted_args jsonb/);

  for (const configTable of ['teams', 'oidc_providers', 'projects', 'project_permissions', 'repositories', 'repository_branches', 'job_presets']) {
    assert.match(bodies.get(configTable), /version integer NOT NULL/);
    assert.match(bodies.get(configTable), /created_by text NOT NULL/);
    assert.match(bodies.get(configTable), /updated_by text NOT NULL/);
  }
});

test('rollback uses the exact reverse dependency order and preserves shared pgvector', async () => {
  const sql = await readFile(path.join(migrationRoot, '0002_phase_1_core.down.sql'), 'utf8');
  assert.deepEqual(tableNames(sql, 'DROP'), [...expectedTables].reverse());
  assert.match(sql, /DELETE FROM ue_mcp\.schema_migrations[\s\S]*version = 2/);
  assert.doesNotMatch(sql, /DROP EXTENSION/);

  const bootstrapDown = await readFile(path.join(migrationRoot, '0001_bootstrap.down.sql'), 'utf8');
  assert.match(bootstrapDown, /DROP TABLE ue_mcp\.schema_migrations;\nDROP SCHEMA ue_mcp;/);
  assert.doesNotMatch(bootstrapDown, /DROP EXTENSION/);
});

test('runner fails on psql errors and never requires a credential-bearing URI', async () => {
  const runner = await readFile(path.join(root, 'database', 'migrate.ps1'), 'utf8');
  assert.match(runner, /ON_ERROR_STOP=1/);
  assert.match(runner, /DatabaseName must be a database name, not a connection URI/);
  assert.match(runner, /Migration history is not a known contiguous prefix/);
  assert.match(runner, /Get-FileHash -LiteralPath .* -Algorithm SHA256/);
  assert.match(runner, /Applied migration .* has checksum/);
  assert.match(runner, /Up target .* is older than current version/);
  assert.match(runner, /Sort-Object -Property version -Descending/);
});
