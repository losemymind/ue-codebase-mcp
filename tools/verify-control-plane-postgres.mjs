import path from 'node:path';
import { createPostgresRuntime } from '../services/control-plane/src/postgres.ts';

const LIVE_STATEMENT = Object.freeze({
  name: 'control-plane-live-connection-v1',
  text: `SELECT current_database() IS NOT NULL
      AND current_user IS NOT NULL
      AND current_setting('transaction_isolation') = 'read committed' AS connected`,
});

let runtime;
try {
  runtime = await createPostgresRuntime({
    connection_string_file: process.env.UE_MCP_DATABASE_DSN_FILE ?? '',
    migration_manifest_file: path.resolve('database/migrations/manifest.json'),
    approved_statements: Object.freeze([LIVE_STATEMENT]),
  });
  if (!await runtime.check()) throw new Error('not ready');
  const direct = await runtime.execute(LIVE_STATEMENT, []);
  if (direct.row_count !== 1 || direct.rows.length !== 1 || direct.rows[0].connected !== true) throw new Error('direct query failed');
  const transactional = await runtime.transaction((transaction) => transaction.execute(LIVE_STATEMENT, []));
  if (transactional.row_count !== 1 || transactional.rows.length !== 1
      || transactional.rows[0].connected !== true) throw new Error('transaction query failed');
  console.log('control-plane PostgreSQL live check passed');
} catch {
  console.error('control-plane PostgreSQL live check failed');
  process.exitCode = 1;
} finally {
  try { await runtime?.close(); } catch { process.exitCode = 1; }
}
