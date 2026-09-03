import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export interface FixedSqlStatement {
  readonly name: string;
  readonly text: string;
}

export type PostgresValue = string | number | boolean | null | Uint8Array | Date;

export interface FixedSqlResult<Row> {
  readonly rows: readonly Row[];
  readonly row_count: number;
}

export interface PostgresTransactionOptions {
  readonly isolation: 'repeatable-read';
  readonly read_only: true;
}

export interface ExpectedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

interface DriverQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

interface DriverQueryable {
  query<Row = Record<string, unknown>>(query: string | Readonly<Record<string, unknown>>): Promise<DriverQueryResult<Row>>;
}

interface DriverClient extends DriverQueryable {
  release(destroy?: boolean): void;
}

interface DriverPool extends DriverQueryable {
  connect(): Promise<DriverClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface PostgresRuntimeOptions {
  readonly approved_statements: readonly FixedSqlStatement[];
  readonly expected_migrations: readonly ExpectedMigration[];
  readonly maximum_rows?: number;
}

export interface CreatePostgresRuntimeOptions {
  readonly connection_string_file: string;
  readonly migration_manifest_file: string;
  readonly approved_statements: readonly FixedSqlStatement[];
  readonly maximum_rows?: number;
  readonly maximum_connections?: number;
  readonly connection_timeout_ms?: number;
  readonly statement_timeout_ms?: number;
  readonly lock_timeout_ms?: number;
  readonly idle_transaction_timeout_ms?: number;
  readonly idle_timeout_ms?: number;
  readonly maximum_connection_lifetime_seconds?: number;
}

export type PostgresRuntimeErrorCode =
  | 'invalid-configuration'
  | 'statement-not-approved'
  | 'database-unavailable'
  | 'result-invalid'
  | 'runtime-closed';

export class PostgresRuntimeError extends Error {
  readonly code: PostgresRuntimeErrorCode;

  constructor(code: PostgresRuntimeErrorCode) {
    super(`postgres runtime ${code}`);
    this.name = 'PostgresRuntimeError';
    this.code = code;
  }
}

const STATEMENT_NAME = /^[a-z][a-z0-9-]{0,127}$/;
const MIGRATION_NAME = /^[a-z][a-z0-9_]{0,127}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const MAX_STATEMENT_BYTES = 256 * 1024;
const MAX_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_VALUES = 10_000;
const READINESS_STATEMENT = Object.freeze({
  name: 'control-plane-migration-readiness-v1',
  text: `SELECT version, name, encode(checksum, 'hex') AS checksum
    FROM ue_mcp.schema_migrations
    ORDER BY version`,
});

function invalid(): never {
  throw new PostgresRuntimeError('invalid-configuration');
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function transactionCommand(options: PostgresTransactionOptions | undefined): string {
  if (options === undefined) return 'BEGIN';
  if (!exactObject(options, ['isolation', 'read_only'])
      || options.isolation !== 'repeatable-read' || options.read_only !== true) invalid();
  return 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) invalid();
  return result as number;
}

function statementPolicy(statements: readonly FixedSqlStatement[]): ReadonlyMap<string, string> {
  if (!Array.isArray(statements) || statements.length < 1 || statements.length > 256) invalid();
  const policy = new Map<string, string>();
  for (const statement of statements) {
    if (!exactObject(statement, ['name', 'text']) || typeof statement.name !== 'string' || !STATEMENT_NAME.test(statement.name)
        || typeof statement.text !== 'string' || statement.text.trim().length === 0
        || Buffer.byteLength(statement.text, 'utf8') > MAX_STATEMENT_BYTES || statement.text.includes('\0')
        || policy.has(statement.name) || statement.name === READINESS_STATEMENT.name) invalid();
    policy.set(statement.name, statement.text);
  }
  return policy;
}

function migrationPolicy(migrations: readonly ExpectedMigration[]): readonly ExpectedMigration[] {
  if (!Array.isArray(migrations) || migrations.length < 1 || migrations.length > 128) invalid();
  return Object.freeze(migrations.map((migration, index) => {
    if (!exactObject(migration, ['version', 'name', 'checksum']) || migration.version !== index + 1
        || typeof migration.name !== 'string' || !MIGRATION_NAME.test(migration.name)
        || typeof migration.checksum !== 'string' || !CHECKSUM.test(migration.checksum)) invalid();
    return Object.freeze({ version: migration.version, name: migration.name, checksum: migration.checksum });
  }));
}

function validValue(value: unknown): value is PostgresValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (typeof value === 'string') return !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES;
  if (value instanceof Uint8Array) return value.byteLength <= MAX_VALUE_BYTES;
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validatedStatement(statement: FixedSqlStatement, policy: ReadonlyMap<string, string>): FixedSqlStatement {
  if (!exactObject(statement, ['name', 'text']) || typeof statement.name !== 'string' || typeof statement.text !== 'string'
      || policy.get(statement.name) !== statement.text) throw new PostgresRuntimeError('statement-not-approved');
  return statement;
}

function validatedValues(values: readonly PostgresValue[]): readonly PostgresValue[] {
  if (!Array.isArray(values) || values.length > MAX_VALUES || !values.every(validValue)) {
    throw new PostgresRuntimeError('invalid-configuration');
  }
  return values;
}

function result<Row>(value: DriverQueryResult<Row>, maximumRows: number): FixedSqlResult<Row> {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.rows)
      || !Number.isSafeInteger(value.rowCount) || (value.rowCount as number) < 0
      || value.rows.length > maximumRows || value.rows.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new PostgresRuntimeError('result-invalid');
  }
  return Object.freeze({ rows: Object.freeze(value.rows.map((row) => Object.freeze(row))), row_count: value.rowCount as number });
}

async function execute<Row>(queryable: DriverQueryable, statement: FixedSqlStatement, values: readonly PostgresValue[],
  policy: ReadonlyMap<string, string>, maximumRows: number): Promise<FixedSqlResult<Row>> {
  const approved = validatedStatement(statement, policy);
  const parameters = validatedValues(values);
  try {
    const queryResult = await queryable.query<Row>({ name: approved.name, text: approved.text,
      values: parameters, rowMode: 'object' });
    return result(queryResult, maximumRows);
  } catch (error) {
    if (error instanceof PostgresRuntimeError) throw error;
    throw new PostgresRuntimeError('database-unavailable');
  }
}

function migrationRows(value: DriverQueryResult<Record<string, unknown>>, expected: readonly ExpectedMigration[]): boolean {
  if (!Array.isArray(value.rows) || value.rowCount !== expected.length || value.rows.length !== expected.length) return false;
  return value.rows.every((row, index) => exactObject(row, ['version', 'name', 'checksum'])
    && row.version === expected[index].version && row.name === expected[index].name && row.checksum === expected[index].checksum);
}

export class PostgresRuntimeDatabase {
  readonly #pool: DriverPool;
  readonly #statements: ReadonlyMap<string, string>;
  readonly #migrations: readonly ExpectedMigration[];
  readonly #maximumRows: number;
  #closed = false;
  #idleFailure = false;

  constructor(pool: DriverPool, options: PostgresRuntimeOptions) {
    if (typeof pool !== 'object' || pool === null || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
        || typeof pool.end !== 'function' || typeof pool.on !== 'function' || typeof options !== 'object' || options === null) invalid();
    this.#pool = pool;
    this.#statements = statementPolicy(options.approved_statements);
    this.#migrations = migrationPolicy(options.expected_migrations);
    this.#maximumRows = boundedInteger(options.maximum_rows, 10_000, 1, 100_000);
    this.#pool.on('error', () => { this.#idleFailure = true; });
  }

  async execute<Row>(statement: FixedSqlStatement, values: readonly PostgresValue[]): Promise<FixedSqlResult<Row>> {
    if (this.#closed) throw new PostgresRuntimeError('runtime-closed');
    return execute<Row>(this.#pool, statement, values, this.#statements, this.#maximumRows);
  }

  async transaction<Result>(operation: (transaction: { execute<Row>(statement: FixedSqlStatement,
    values: readonly PostgresValue[]): Promise<FixedSqlResult<Row>> }) => Promise<Result>,
  options?: PostgresTransactionOptions): Promise<Result> {
    if (this.#closed) throw new PostgresRuntimeError('runtime-closed');
    if (typeof operation !== 'function') invalid();
    const begin = transactionCommand(options);
    let client: DriverClient;
    try { client = await this.#pool.connect(); } catch { throw new PostgresRuntimeError('database-unavailable'); }
    let destroy = false;
    let began = false;
    try {
      await client.query(begin);
      began = true;
      const transaction = Object.freeze({ execute: <Row>(statement: FixedSqlStatement, values: readonly PostgresValue[]) =>
        execute<Row>(client, statement, values, this.#statements, this.#maximumRows) });
      const operationResult = await operation(transaction);
      await client.query('COMMIT');
      return operationResult;
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; }
      } else destroy = true;
      if (error instanceof PostgresRuntimeError) throw error;
      throw error;
    } finally {
      client.release(destroy);
    }
  }

  async check(): Promise<boolean> {
    if (this.#closed) return false;
    try {
      const value = await this.#pool.query<Record<string, unknown>>({ ...READINESS_STATEMENT,
        values: Object.freeze([]), rowMode: 'object', query_timeout: 1_500 });
      const ready = migrationRows(value, this.#migrations);
      if (ready) this.#idleFailure = false;
      return ready && !this.#idleFailure;
    } catch { return false; }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#pool.end(); } catch { throw new PostgresRuntimeError('database-unavailable'); }
  }
}

async function regularFile(file: string, maximumBytes: number): Promise<Buffer> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) invalid();
  let handle;
  try {
    const parsed = path.parse(file);
    let current = parsed.root;
    let metadata = await lstat(current);
    for (const part of file.slice(parsed.root.length).split(path.sep).filter((value) => value.length > 0)) {
      current = path.join(current, part);
      metadata = await lstat(current);
      if (metadata.isSymbolicLink()) invalid();
    }
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) invalid();
    handle = await open(file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== metadata.size || opened.size > maximumBytes
        || opened.dev !== metadata.dev || opened.ino !== metadata.ino) invalid();
    const value = await handle.readFile();
    const after = await lstat(file);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || value.byteLength !== opened.size) invalid();
    return value;
  } catch (error) {
    if (error instanceof PostgresRuntimeError) throw error;
    invalid();
  } finally {
    try { await handle?.close(); } catch { invalid(); }
  }
}

async function connectionString(file: string): Promise<string> {
  const bytes = await regularFile(file, 4_096);
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); }
  value = value.replace(/\n$/u, '');
  if (value.length < 1 || /[\r\n\0]/u.test(value)) invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username.length === 0 || parsed.password.length === 0
      || parsed.hostname.length === 0 || parsed.pathname.length < 2 || parsed.pathname.slice(1).includes('/') || parsed.hash.length > 0) invalid();
  try {
    const decoded = [decodeURIComponent(parsed.username), decodeURIComponent(parsed.password), decodeURIComponent(parsed.pathname.slice(1))];
    if (decoded.some((part) => part.length === 0 || /[\u0000-\u001f\u007f]/u.test(part)) || decoded[2].includes('/')) invalid();
  } catch (error) {
    if (error instanceof PostgresRuntimeError) throw error;
    invalid();
  }
  const allowed = new Set(['sslmode', 'sslnegotiation']);
  const seen = new Set<string>();
  for (const [name, option] of parsed.searchParams) {
    if (!allowed.has(name) || seen.has(name)) invalid();
    seen.add(name);
    if (name === 'sslmode' && !['disable', 'require', 'verify-ca', 'verify-full'].includes(option)) invalid();
    if (name === 'sslnegotiation' && !['postgres', 'direct'].includes(option)) invalid();
  }
  if (!seen.has('sslmode')) invalid();
  if (parsed.searchParams.get('sslmode') === 'disable' && parsed.searchParams.has('sslnegotiation')) invalid();
  return value;
}

export async function loadExpectedMigrations(manifestFile: string): Promise<readonly ExpectedMigration[]> {
  const manifestBytes = await regularFile(manifestFile, 64 * 1024);
  let manifest: unknown;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch { invalid(); }
  if (!exactObject(manifest, ['schema', 'migrations']) || manifest.schema !== 'ue_mcp' || !Array.isArray(manifest.migrations)) invalid();
  const root = path.dirname(manifestFile);
  const migrations: ExpectedMigration[] = [];
  for (const [index, entry] of manifest.migrations.entries()) {
    if (!exactObject(entry, ['version', 'name', 'up', 'down']) || entry.version !== index + 1
        || typeof entry.name !== 'string' || !MIGRATION_NAME.test(entry.name) || typeof entry.up !== 'string'
        || !/^[0-9]{4}_[a-z0-9_]+\.up\.sql$/u.test(entry.up) || typeof entry.down !== 'string'
        || !/^[0-9]{4}_[a-z0-9_]+\.down\.sql$/u.test(entry.down)) invalid();
    const source = await regularFile(path.join(root, entry.up), 4 * 1024 * 1024);
    migrations.push(Object.freeze({ version: entry.version, name: entry.name,
      checksum: createHash('sha256').update(source).digest('hex') }));
  }
  return migrationPolicy(migrations);
}

export async function createPostgresRuntime(options: CreatePostgresRuntimeOptions): Promise<PostgresRuntimeDatabase> {
  if (typeof options !== 'object' || options === null) invalid();
  const [dsn, expectedMigrations] = await Promise.all([
    connectionString(options.connection_string_file),
    loadExpectedMigrations(options.migration_manifest_file),
  ]);
  const maximumConnections = boundedInteger(options.maximum_connections, 16, 1, 64);
  const connectionTimeout = boundedInteger(options.connection_timeout_ms, 2_000, 250, 10_000);
  const statementTimeout = boundedInteger(options.statement_timeout_ms, 30_000, 1_000, 60_000);
  const lockTimeout = boundedInteger(options.lock_timeout_ms, 5_000, 100, 30_000);
  const idleTransactionTimeout = boundedInteger(options.idle_transaction_timeout_ms, 30_000, 1_000, 60_000);
  const idleTimeout = boundedInteger(options.idle_timeout_ms, 30_000, 1_000, 300_000);
  const maximumLifetime = boundedInteger(options.maximum_connection_lifetime_seconds, 300, 30, 3_600);
  let pool;
  try {
    pool = new Pool({ connectionString: dsn, application_name: 'ue-codebase-mcp-control-plane', max: maximumConnections,
      min: 0, connectionTimeoutMillis: connectionTimeout, idleTimeoutMillis: idleTimeout, maxLifetimeSeconds: maximumLifetime,
      statement_timeout: statementTimeout, query_timeout: statementTimeout, lock_timeout: lockTimeout,
      idle_in_transaction_session_timeout: idleTransactionTimeout, keepAlive: true, keepAliveInitialDelayMillis: 10_000,
      enableChannelBinding: true, allowExitOnIdle: false });
    return new PostgresRuntimeDatabase(pool as unknown as DriverPool, {
      approved_statements: options.approved_statements,
      expected_migrations: expectedMigrations,
      ...(options.maximum_rows === undefined ? {} : { maximum_rows: options.maximum_rows }),
    });
  } catch (error) {
    try { await pool?.end(); } catch {}
    if (error instanceof PostgresRuntimeError) throw error;
    invalid();
  }
}
