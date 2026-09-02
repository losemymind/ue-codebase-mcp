import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPostgresRuntime,
  loadExpectedMigrations,
  PostgresRuntimeDatabase,
  PostgresRuntimeError,
} from '../../services/control-plane/src/postgres.ts';

const approved = Object.freeze([{ name: 'test-select-v1', text: 'SELECT $1::integer AS value' }]);
const migrations = Object.freeze([{ version: 1, name: 'bootstrap', checksum: 'a'.repeat(64) }]);

class FakePool {
  constructor(handler = () => ({ rows: [], rowCount: 0 })) {
    this.handler = handler;
    this.calls = [];
    this.clients = [];
    this.ended = 0;
    this.errorListener = undefined;
  }

  on(event, listener) {
    assert.equal(event, 'error');
    this.errorListener = listener;
    return this;
  }

  async query(query) {
    this.calls.push(query);
    return this.handler(query);
  }

  async connect() {
    const client = {
      calls: [], released: [],
      query: async (query) => {
        client.calls.push(query);
        return this.handler(query);
      },
      release: (destroy = false) => client.released.push(destroy),
    };
    this.clients.push(client);
    return client;
  }

  async end() { this.ended += 1; }
}

test('runtime executes only pre-approved named parameterized statements', async () => {
  const pool = new FakePool((query) => ({ rows: [{ value: query.values[0] }], rowCount: 1 }));
  const database = new PostgresRuntimeDatabase(pool, { approved_statements: approved, expected_migrations: migrations });
  const result = await database.execute(approved[0], [7]);
  assert.deepEqual(result, { rows: [{ value: 7 }], row_count: 1 });
  assert.deepEqual(pool.calls[0], { name: approved[0].name, text: approved[0].text, values: [7], rowMode: 'object' });
  await assert.rejects(database.execute({ name: 'not-approved-v1', text: 'SELECT 1' }, []),
    (error) => error instanceof PostgresRuntimeError && error.code === 'statement-not-approved');
  await assert.rejects(database.execute({ ...approved[0], text: 'SELECT 2' }, []),
    (error) => error instanceof PostgresRuntimeError && error.code === 'statement-not-approved');
  assert.equal(pool.calls.length, 1);
});

test('runtime bounds values and rejects malformed driver results without exposing driver errors', async () => {
  const malformed = new PostgresRuntimeDatabase(new FakePool(() => ({ rows: [], rowCount: null })), {
    approved_statements: approved, expected_migrations: migrations,
  });
  await assert.rejects(malformed.execute(approved[0], [1]),
    (error) => error instanceof PostgresRuntimeError && error.code === 'result-invalid');
  const failed = new PostgresRuntimeDatabase(new FakePool(() => { throw new Error('PRIVATE DSN DETAIL'); }), {
    approved_statements: approved, expected_migrations: migrations,
  });
  await assert.rejects(failed.execute(approved[0], [1]), (error) => {
    assert.equal(error.code, 'database-unavailable');
    assert.doesNotMatch(error.message, /PRIVATE|DSN/u);
    return true;
  });
  await assert.rejects(failed.execute(approved[0], ['x'.repeat(8 * 1024 * 1024 + 1)]),
    (error) => error.code === 'invalid-configuration');
});

test('transactions commit successful work and roll back failures before releasing clients', async () => {
  const pool = new FakePool((query) => typeof query === 'string'
    ? { rows: [], rowCount: null } : { rows: [{ value: query.values[0] }], rowCount: 1 });
  const database = new PostgresRuntimeDatabase(pool, { approved_statements: approved, expected_migrations: migrations });
  assert.equal(await database.transaction(async (transaction) => {
    const value = await transaction.execute(approved[0], [9]);
    return value.rows[0].value;
  }), 9);
  assert.deepEqual(pool.clients[0].calls.map((query) => typeof query === 'string' ? query : query.name),
    ['BEGIN', 'test-select-v1', 'COMMIT']);
  assert.deepEqual(pool.clients[0].released, [false]);

  const domainError = new Error('domain failure');
  await assert.rejects(database.transaction(async () => { throw domainError; }), (error) => error === domainError);
  assert.deepEqual(pool.clients[1].calls, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(pool.clients[1].released, [false]);

  const rollbackFailure = new FakePool((query) => {
    if (query === 'ROLLBACK') throw new Error('connection lost');
    return { rows: [], rowCount: null };
  });
  const rollbackDatabase = new PostgresRuntimeDatabase(rollbackFailure, {
    approved_statements: approved, expected_migrations: migrations,
  });
  await assert.rejects(rollbackDatabase.transaction(async () => { throw domainError; }), (error) => error === domainError);
  assert.deepEqual(rollbackFailure.clients[0].released, [true]);
});

test('readiness requires the exact contiguous migration identity and checksums', async () => {
  const expectedRows = migrations.map((migration) => ({ ...migration }));
  const pool = new FakePool(() => ({ rows: expectedRows, rowCount: expectedRows.length }));
  const database = new PostgresRuntimeDatabase(pool, { approved_statements: approved, expected_migrations: migrations });
  assert.equal(await database.check(), true);
  assert.equal(pool.calls[0].name, 'control-plane-migration-readiness-v1');
  expectedRows[0].checksum = 'b'.repeat(64);
  assert.equal(await database.check(), false);
  pool.handler = () => { throw new Error('database offline'); };
  assert.equal(await database.check(), false);
  await database.close();
  await database.close();
  assert.equal(pool.ended, 1);
  assert.equal(await database.check(), false);
  await assert.rejects(database.execute(approved[0], [1]), (error) => error.code === 'runtime-closed');
});

test('migration policy hashes every checked-in migration in contiguous manifest order', async () => {
  const policy = await loadExpectedMigrations(path.resolve('database/migrations/manifest.json'));
  assert.equal(policy.length, 8);
  assert.deepEqual(policy.map(({ version, name }) => ({ version, name })), [
    { version: 1, name: 'bootstrap' },
    { version: 2, name: 'phase_1_core' },
    { version: 3, name: 'p1_09_symbol_persistence' },
    { version: 4, name: 'p1_10_relation_persistence' },
    { version: 5, name: 'p1_12_chunk_persistence' },
    { version: 6, name: 'p1_14_generation_publication' },
    { version: 7, name: 'p1_16_durable_job_leases' },
    { version: 8, name: 'p1_17_observability_audit' },
  ]);
  assert.ok(policy.every((migration) => /^[a-f0-9]{64}$/u.test(migration.checksum)));
});

test('pool creation reads a bounded regular secret file and rejects unsafe connection strings', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ue-mcp-postgres-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const secret = path.join(root, 'database-dsn');
  await writeFile(secret, 'postgresql://service:password@127.0.0.1:5432/ue_mcp?sslmode=disable\n', { mode: 0o600 });
  const runtime = await createPostgresRuntime({ connection_string_file: secret,
    migration_manifest_file: path.resolve('database/migrations/manifest.json'), approved_statements: approved });
  await runtime.close();

  for (const value of ['postgresql://service@127.0.0.1/db', 'http://service:password@127.0.0.1/db',
    'postgresql://service:password@127.0.0.1/db',
    'postgresql://service:password@127.0.0.1/db?application_name=override',
    'postgresql://service:password@127.0.0.1/db?sslmode=disable&sslnegotiation=direct',
    'postgresql://service:pass%0Aword@127.0.0.1/db',
    'postgresql://service:password@127.0.0.1/db\nsecond-line']) {
    await writeFile(secret, value, { mode: 0o600 });
    await assert.rejects(createPostgresRuntime({ connection_string_file: secret,
      migration_manifest_file: path.resolve('database/migrations/manifest.json'), approved_statements: approved }),
      (error) => error.code === 'invalid-configuration');
  }
  await assert.rejects(createPostgresRuntime({ connection_string_file: 'relative-secret',
    migration_manifest_file: path.resolve('database/migrations/manifest.json'), approved_statements: approved }),
    (error) => error.code === 'invalid-configuration');
});
