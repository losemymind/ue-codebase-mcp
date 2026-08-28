BEGIN;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 2 AND name = 'phase_1_core';

DROP TABLE ue_mcp.evaluation_runs;
DROP TABLE ue_mcp.evaluation_cases;
DROP TABLE ue_mcp.backup_runs;
DROP TABLE ue_mcp.audit_events;
DROP TABLE ue_mcp.job_artifacts;
DROP TABLE ue_mcp.job_events;
DROP TABLE ue_mcp.jobs;
DROP TABLE ue_mcp.job_presets;
DROP TABLE ue_mcp.agents;
DROP TABLE ue_mcp.chunk_embeddings;
DROP TABLE ue_mcp.code_chunks;
DROP TABLE ue_mcp.symbol_edges;
DROP TABLE ue_mcp.symbol_metadata;
DROP TABLE ue_mcp.symbol_locations;
DROP TABLE ue_mcp.symbols;
DROP TABLE ue_mcp.module_dependencies;
DROP TABLE ue_mcp.modules;
DROP TABLE ue_mcp.index_failures;
DROP TABLE ue_mcp.file_dependencies;
DROP TABLE ue_mcp.files;
DROP TABLE ue_mcp.generation_revisions;
DROP TABLE ue_mcp.index_generations;
DROP TABLE ue_mcp.svn_access_snapshots;
DROP TABLE ue_mcp.revisions;
DROP TABLE ue_mcp.repository_branches;
DROP TABLE ue_mcp.repositories;
DROP TABLE ue_mcp.project_permissions;
DROP TABLE ue_mcp.projects;
DROP TABLE ue_mcp.oidc_providers;
DROP TABLE ue_mcp.api_tokens;
DROP TABLE ue_mcp.team_memberships;
DROP TABLE ue_mcp.teams;
DROP TABLE ue_mcp.users;

DROP FUNCTION ue_mcp.set_updated_at();

COMMIT;
