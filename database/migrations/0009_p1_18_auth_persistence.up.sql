BEGIN;

SET LOCAL search_path = ue_mcp, public, pg_catalog;

ALTER TABLE ue_mcp.users
  ADD COLUMN svn_subject text;

ALTER TABLE ue_mcp.users
  ADD CONSTRAINT users_svn_subject_check CHECK (
    svn_subject IS NULL OR (
      length(svn_subject) BETWEEN 1 AND 512
      AND svn_subject !~ '[[:cntrl:]]'
    )
  );

CREATE UNIQUE INDEX users_svn_subject_unique
  ON ue_mcp.users (svn_subject)
  WHERE svn_subject IS NOT NULL;

CREATE TABLE ue_mcp.service_principals (
  id text PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 512
    AND id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]*$'
  ),
  svn_subject text NOT NULL CHECK (
    length(svn_subject) BETWEEN 1 AND 512
    AND svn_subject !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (svn_subject),
  CHECK (updated_at >= created_at)
);

CREATE TRIGGER service_principals_set_updated_at
BEFORE UPDATE ON ue_mcp.service_principals
FOR EACH ROW EXECUTE FUNCTION ue_mcp.set_updated_at();

ALTER TABLE ue_mcp.svn_access_snapshots
  DROP CONSTRAINT svn_access_snapshots_repository_id_revision_subject_key;

ALTER TABLE ue_mcp.svn_access_snapshots
  ADD COLUMN path_prefix text;

ALTER TABLE ue_mcp.svn_access_snapshots
  ADD CONSTRAINT svn_access_snapshots_path_prefix_check CHECK (
    path_prefix IS NULL OR (
      length(path_prefix) <= 2048
      AND path_prefix !~ '[[:cntrl:]]'
      AND position(E'\\' IN path_prefix) = 0
      AND position('%' IN path_prefix) = 0
      AND path_prefix !~ '^/'
      AND path_prefix !~ '/$'
      AND path_prefix !~ '(^|/)([.]|[.][.])(/|$)'
      AND path_prefix !~ '//'
    )
  );

CREATE UNIQUE INDEX svn_access_snapshots_legacy_scope_unique
  ON ue_mcp.svn_access_snapshots (repository_id, revision, subject)
  WHERE path_prefix IS NULL;

CREATE UNIQUE INDEX svn_access_snapshots_path_scope_unique
  ON ue_mcp.svn_access_snapshots (repository_id, revision, subject, path_prefix)
  WHERE path_prefix IS NOT NULL;

DROP INDEX ue_mcp.svn_access_snapshots_lookup_idx;

CREATE INDEX svn_access_snapshots_path_lookup_idx
  ON ue_mcp.svn_access_snapshots (repository_id, subject, revision, length(path_prefix) DESC);

INSERT INTO ue_mcp.schema_migrations (version, name, checksum)
VALUES (9, 'p1_18_auth_persistence', decode(:'migration_checksum', 'hex'));

COMMIT;
