BEGIN;

SET LOCAL search_path = ue_mcp, public, pg_catalog;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ue_mcp.svn_access_snapshots
    GROUP BY repository_id, revision, subject
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot remove path authorization while multiple path snapshots exist';
  END IF;
END;
$$;

DROP INDEX ue_mcp.svn_access_snapshots_path_lookup_idx;
DROP INDEX ue_mcp.svn_access_snapshots_path_scope_unique;
DROP INDEX ue_mcp.svn_access_snapshots_legacy_scope_unique;

ALTER TABLE ue_mcp.svn_access_snapshots
  DROP CONSTRAINT svn_access_snapshots_path_prefix_check,
  DROP COLUMN path_prefix;

ALTER TABLE ue_mcp.svn_access_snapshots
  ADD CONSTRAINT svn_access_snapshots_repository_id_revision_subject_key
  UNIQUE (repository_id, revision, subject);

CREATE INDEX svn_access_snapshots_lookup_idx
  ON ue_mcp.svn_access_snapshots (repository_id, subject, captured_at DESC);

DROP TABLE ue_mcp.service_principals;

DROP INDEX ue_mcp.users_svn_subject_unique;

ALTER TABLE ue_mcp.users
  DROP CONSTRAINT users_svn_subject_check,
  DROP COLUMN svn_subject;

DELETE FROM ue_mcp.schema_migrations
WHERE version = 9 AND name = 'p1_18_auth_persistence';

COMMIT;
