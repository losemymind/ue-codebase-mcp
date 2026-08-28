# Database migrations

The Phase 1 schema is owned by the `ue_mcp` PostgreSQL schema. Migration `0001`
creates pgvector and migration metadata; migration `0002` creates only the Phase
1 tables from plan sections 5.1, 5.2, 5.3, and 5.5. The pgvector extension is
intentionally retained by a full rollback because another application may share
it in the same database.

Use standard libpq environment variables (`PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, and TLS variables as required) instead of embedding
credentials in arguments. Apply all pending migrations with:

```powershell
npm run db:migrate
```

Roll back one migration with `npm run db:rollback`, or select a version directly:

```powershell
powershell -NoProfile -File database/migrate.ps1 -Action down -TargetVersion 0
```

The runner verifies that applied migrations are a contiguous manifest prefix and
that their stored SHA-256 checksums still match local files. It passes
`ON_ERROR_STOP` to `psql`; every migration is also transactional.

## Live acceptance test

The live test destroys only the `ue_mcp` schema, but it still refuses to run
unless the selected database name ends in `test`. Point the libpq variables at a
disposable PostgreSQL database with pgvector available, then run:

```powershell
npm run db:test:live
```

This exercises an empty upgrade, upgrade from bootstrap version 1, negative data
constraints, rollback to version 1, re-upgrade to version 2, and full rollback.
It is intentionally opt-in and is not replaced by a mocked production result.

The schema stores provider/model dimensions with each embedding. It includes a
1536-dimension cosine HNSW baseline. When P1-12 receives the approved embedding
provider configuration, it must add partial ANN indexes for any other selected
dimension rather than silently relying on an incompatible index.
