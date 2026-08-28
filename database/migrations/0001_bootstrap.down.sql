BEGIN;

DROP TABLE ue_mcp.schema_migrations;
DROP SCHEMA ue_mcp;

-- The vector extension may be shared by other schemas/applications, so rollback
-- deliberately leaves it installed.

COMMIT;
