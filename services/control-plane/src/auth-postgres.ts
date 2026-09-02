import type {
  BearerTokenRecord,
  BearerTokenRepository,
} from '../../../packages/auth/src/bearer.ts';
import type {
  AuthorizationPrincipal,
  AuthorizationReadView,
  AuthorizationRepository,
  PrincipalRecord,
  ProjectPermission,
  ProjectRecord,
  RepositoryRecord,
  SvnAccessSnapshot,
} from '../../../packages/auth/src/policy.ts';
import type {
  FixedSqlResult,
  FixedSqlStatement,
  PostgresTransactionOptions,
  PostgresValue,
} from './postgres.ts';

interface SqlExecutor {
  execute<Row>(statement: FixedSqlStatement, values: readonly PostgresValue[]): Promise<FixedSqlResult<Row>>;
}

interface AuthDatabase extends SqlExecutor {
  transaction<Result>(operation: (transaction: SqlExecutor) => Promise<Result>,
    options?: PostgresTransactionOptions): Promise<Result>;
}

export type AuthPostgresErrorCode = 'invalid-input' | 'record-invalid' | 'write-conflict' | 'database-failed';

export class AuthPostgresError extends Error {
  readonly code: AuthPostgresErrorCode;

  constructor(code: AuthPostgresErrorCode) {
    super(`authentication persistence ${code}`);
    this.name = 'AuthPostgresError';
    this.code = code;
  }
}

const FIND_TOKEN = Object.freeze({
  name: 'auth-token-find-v1',
  text: `SELECT id::text AS id, owner_type, owner_id, token_hash, scopes,
      floor(extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_at_ms,
      CASE WHEN revoked_at IS NULL THEN NULL
        ELSE floor(extract(epoch FROM revoked_at) * 1000)::bigint::text END AS revoked_at_ms,
      floor(extract(epoch FROM created_at) * 1000)::bigint::text AS created_at_ms
    FROM ue_mcp.api_tokens
    WHERE id = $1::uuid`,
});

const INSERT_TOKEN = Object.freeze({
  name: 'auth-token-insert-v1',
  text: `INSERT INTO ue_mcp.api_tokens
      (id, owner_type, owner_id, token_hash, scopes, expires_at, revoked_at, created_at, updated_at)
    VALUES ($1::uuid, $2, $3, $4,
      ARRAY(SELECT jsonb_array_elements_text($5::jsonb)),
      to_timestamp($6::double precision / 1000.0), NULL,
      to_timestamp($7::double precision / 1000.0),
      to_timestamp($7::double precision / 1000.0))
    RETURNING id::text AS id`,
});

const REVOKE_CURRENT_TOKEN = Object.freeze({
  name: 'auth-token-revoke-current-v1',
  text: `UPDATE ue_mcp.api_tokens
    SET revoked_at = to_timestamp($2::double precision / 1000.0),
      updated_at = GREATEST(updated_at, to_timestamp($2::double precision / 1000.0))
    WHERE id = $1::uuid AND revoked_at IS NULL
      AND created_at <= to_timestamp($2::double precision / 1000.0)
      AND expires_at > to_timestamp($2::double precision / 1000.0)
    RETURNING id::text AS id, owner_type, owner_id, scopes`,
});

const REVOKE_TOKEN = Object.freeze({
  name: 'auth-token-revoke-v1',
  text: `UPDATE ue_mcp.api_tokens
    SET revoked_at = COALESCE(revoked_at, to_timestamp($2::double precision / 1000.0)),
      updated_at = GREATEST(updated_at, to_timestamp($2::double precision / 1000.0))
    WHERE id = $1::uuid
      AND created_at <= to_timestamp($2::double precision / 1000.0)
    RETURNING id::text AS id`,
});

const GET_USER_PRINCIPAL = Object.freeze({
  name: 'auth-user-principal-get-v1',
  text: `SELECT 'user'::text AS type, external_subject AS id, svn_subject,
      (status = 'active') AS active
    FROM ue_mcp.users
    WHERE external_subject = $1 AND svn_subject IS NOT NULL`,
});

const GET_SERVICE_PRINCIPAL = Object.freeze({
  name: 'auth-service-principal-get-v1',
  text: `SELECT 'service'::text AS type, id, svn_subject,
      (status = 'active') AS active
    FROM ue_mcp.service_principals
    WHERE id = $1`,
});

const LIST_ACTIVE_TEAMS = Object.freeze({
  name: 'auth-active-teams-list-v1',
  text: `SELECT membership.team_id::text AS team_id
    FROM ue_mcp.users AS principal
    JOIN ue_mcp.team_memberships AS membership ON membership.user_id = principal.id
    JOIN ue_mcp.teams AS team ON team.id = membership.team_id
    WHERE principal.external_subject = $1
      AND principal.status = 'active' AND team.status = 'active'
    ORDER BY membership.team_id`,
});

const GET_PROJECT = Object.freeze({
  name: 'auth-project-get-v1',
  text: `SELECT id::text AS id, status
    FROM ue_mcp.projects
    WHERE id = $1::uuid`,
});

const GET_REPOSITORY = Object.freeze({
  name: 'auth-repository-get-v1',
  text: `SELECT id::text AS id, project_id::text AS project_id, kind, enabled
    FROM ue_mcp.repositories
    WHERE id = $1::uuid`,
});

const LIST_PROJECT_PERMISSIONS = Object.freeze({
  name: 'auth-project-permissions-list-v1',
  text: `SELECT project_id::text AS project_id, principal_type, principal_id, role
    FROM ue_mcp.project_permissions
    WHERE project_id = $1::uuid
    ORDER BY principal_type, principal_id`,
});

const GET_SVN_ACCESS = Object.freeze({
  name: 'auth-svn-access-get-v1',
  text: `SELECT repository_id::text AS repository_id, revision::text AS revision,
      subject, $4::text AS path, effective_access,
      floor(extract(epoch FROM captured_at) * 1000)::bigint::text AS captured_at_ms,
      floor(extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_at_ms
    FROM ue_mcp.svn_access_snapshots
    WHERE repository_id = $1::uuid AND revision = $2::bigint AND subject = $3
      AND path_prefix IS NOT NULL
      AND (path_prefix = '' OR path_prefix = $4
        OR starts_with($4, path_prefix || '/'))
    ORDER BY length(path_prefix) DESC
    LIMIT 1`,
});

export const AUTH_POSTGRES_STATEMENTS: readonly FixedSqlStatement[] = Object.freeze([
  FIND_TOKEN,
  INSERT_TOKEN,
  REVOKE_CURRENT_TOKEN,
  REVOKE_TOKEN,
  GET_USER_PRINCIPAL,
  GET_SERVICE_PRINCIPAL,
  LIST_ACTIVE_TEAMS,
  GET_PROJECT,
  GET_REPOSITORY,
  LIST_PROJECT_PERMISSIONS,
  GET_SVN_ACCESS,
]);

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,511}$/u;
const SCOPE = /^[A-Za-z0-9:_-]{1,128}$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const READ_ONLY_SNAPSHOT = Object.freeze({ isolation: 'repeatable-read', read_only: true } as const);

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function invalid(code: AuthPostgresErrorCode = 'record-invalid'): never {
  throw new AuthPostgresError(code);
}

function database(value: unknown): asserts value is AuthDatabase {
  if (typeof value !== 'object' || value === null
      || typeof (value as AuthDatabase).execute !== 'function'
      || typeof (value as AuthDatabase).transaction !== 'function') invalid('invalid-input');
}

async function reduced<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthPostgresError) throw error;
    throw new AuthPostgresError('database-failed');
  }
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function subject(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value === value.normalize('NFC') && !/[\u0000-\u001f\u007f]/u.test(value);
}

function path(value: unknown): value is string {
  if (value === '') return true;
  return typeof value === 'string' && value.length <= 2_048 && value === value.normalize('NFC')
    && !value.includes('\\') && !value.includes('%') && !value.startsWith('/') && !value.endsWith('/')
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function milliseconds(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function scopes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => typeof entry !== 'string' || !SCOPE.test(entry))
      || new Set(value).size !== value.length) invalid();
  return Object.freeze([...value]);
}

function oneRow<Row>(result: FixedSqlResult<Row>): Row {
  if (result.row_count !== 1 || result.rows.length !== 1) invalid('write-conflict');
  return result.rows[0];
}

function optionalRow<Row>(result: FixedSqlResult<Row>): Row | null {
  if (result.row_count === 0 && result.rows.length === 0) return null;
  if (result.row_count !== 1 || result.rows.length !== 1) invalid();
  return result.rows[0];
}

function tokenInput(record: Readonly<BearerTokenRecord>, requireActive: boolean): readonly PostgresValue[] {
  if (!exactObject(record, ['id', 'ownerType', 'ownerId', 'tokenHash', 'scopes', 'expiresAt', 'revokedAt', 'createdAt'])
      || !uuid(record.id) || !['user', 'service'].includes(record.ownerType) || !identifier(record.ownerId)
      || !(record.tokenHash instanceof Uint8Array) || record.tokenHash.byteLength !== 58
      || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)
      || record.createdAt < 0 || record.expiresAt <= record.createdAt
      || (requireActive && record.revokedAt !== null)
      || (!requireActive && record.revokedAt !== null && (!Number.isSafeInteger(record.revokedAt)
        || record.revokedAt < record.createdAt))) invalid('invalid-input');
  const approvedScopes = scopes(record.scopes);
  return Object.freeze([record.id, record.ownerType, record.ownerId, new Uint8Array(record.tokenHash),
    JSON.stringify(approvedScopes), record.expiresAt, record.createdAt]);
}

function tokenRow(value: unknown): BearerTokenRecord {
  if (!exactObject(value, ['id', 'owner_type', 'owner_id', 'token_hash', 'scopes', 'expires_at_ms', 'revoked_at_ms', 'created_at_ms'])
      || !uuid(value.id) || !['user', 'service'].includes(value.owner_type) || !identifier(value.owner_id)
      || !(value.token_hash instanceof Uint8Array) || value.token_hash.byteLength !== 58) invalid();
  const createdAt = milliseconds(value.created_at_ms);
  const expiresAt = milliseconds(value.expires_at_ms);
  const revokedAt = value.revoked_at_ms === null ? null : milliseconds(value.revoked_at_ms);
  if (expiresAt <= createdAt || (revokedAt !== null && revokedAt < createdAt)) invalid();
  return Object.freeze({ id: value.id.toLowerCase(), ownerType: value.owner_type, ownerId: value.owner_id,
    tokenHash: new Uint8Array(value.token_hash), scopes: scopes(value.scopes), expiresAt, revokedAt, createdAt });
}

async function insertToken(executor: SqlExecutor, record: Readonly<BearerTokenRecord>): Promise<void> {
  const values = tokenInput(record, true);
  const row = oneRow(await executor.execute<Record<string, unknown>>(INSERT_TOKEN, values));
  if (!exactObject(row, ['id']) || !uuid(row.id) || row.id.toLowerCase() !== record.id.toLowerCase()) invalid();
}

export class PostgresBearerTokenRepository implements BearerTokenRepository {
  readonly #database: AuthDatabase;

  constructor(value: AuthDatabase) {
    database(value);
    this.#database = value;
  }

  async findById(id: string): Promise<BearerTokenRecord | null> {
    if (!uuid(id)) invalid('invalid-input');
    return reduced(async () => {
      const row = optionalRow(await this.#database.execute<Record<string, unknown>>(FIND_TOKEN, [id]));
      return row === null ? null : tokenRow(row);
    });
  }

  async insert(record: Readonly<BearerTokenRecord>): Promise<void> {
    return reduced(() => insertToken(this.#database, record));
  }

  async replace(currentId: string, replacement: Readonly<BearerTokenRecord>, revokedAt: number): Promise<void> {
    if (!uuid(currentId) || !Number.isSafeInteger(revokedAt) || revokedAt < 0) invalid('invalid-input');
    tokenInput(replacement, true);
    if (currentId.toLowerCase() === replacement.id.toLowerCase()) invalid('invalid-input');
    return reduced(() => this.#database.transaction(async (transaction) => {
      const current = oneRow(await transaction.execute<Record<string, unknown>>(REVOKE_CURRENT_TOKEN, [currentId, revokedAt]));
      if (!exactObject(current, ['id', 'owner_type', 'owner_id', 'scopes']) || !uuid(current.id)
          || current.id.toLowerCase() !== currentId.toLowerCase() || current.owner_type !== replacement.ownerType
          || current.owner_id !== replacement.ownerId
          || JSON.stringify(scopes(current.scopes)) !== JSON.stringify(replacement.scopes)) invalid('write-conflict');
      await insertToken(transaction, replacement);
    }));
  }

  async revoke(id: string, revokedAt: number): Promise<void> {
    if (!uuid(id) || !Number.isSafeInteger(revokedAt) || revokedAt < 0) invalid('invalid-input');
    return reduced(async () => {
      const row = oneRow(await this.#database.execute<Record<string, unknown>>(REVOKE_TOKEN, [id, revokedAt]));
      if (!exactObject(row, ['id']) || !uuid(row.id) || row.id.toLowerCase() !== id.toLowerCase()) invalid();
    });
  }
}

function principalRow(value: unknown, expected: AuthorizationPrincipal): PrincipalRecord {
  if (!exactObject(value, ['type', 'id', 'svn_subject', 'active']) || value.type !== expected.type
      || value.id !== expected.id || !identifier(value.id) || !subject(value.svn_subject)
      || typeof value.active !== 'boolean') invalid();
  return Object.freeze({ type: value.type, id: value.id, svnSubject: value.svn_subject, active: value.active });
}

function projectRow(value: unknown): ProjectRecord {
  if (!exactObject(value, ['id', 'status']) || !uuid(value.id)
      || !['active', 'disabled', 'archived'].includes(value.status as string)) invalid();
  return Object.freeze({ id: value.id.toLowerCase(), status: value.status as ProjectRecord['status'] });
}

function repositoryRow(value: unknown): RepositoryRecord {
  if (!exactObject(value, ['id', 'project_id', 'kind', 'enabled']) || !uuid(value.id) || !uuid(value.project_id)
      || value.kind !== 'svn' || typeof value.enabled !== 'boolean') invalid();
  return Object.freeze({ id: value.id.toLowerCase(), projectId: value.project_id.toLowerCase(),
    kind: 'svn', enabled: value.enabled });
}

function permissionRow(value: unknown): ProjectPermission {
  if (!exactObject(value, ['project_id', 'principal_type', 'principal_id', 'role']) || !uuid(value.project_id)
      || !['user', 'team', 'service'].includes(value.principal_type as string) || !identifier(value.principal_id)
      || !['reader', 'operator', 'administrator'].includes(value.role as string)) invalid();
  return Object.freeze({ projectId: value.project_id.toLowerCase(),
    principalType: value.principal_type as ProjectPermission['principalType'], principalId: value.principal_id,
    role: value.role as ProjectPermission['role'] });
}

function svnAccessRow(value: unknown, query: Readonly<{ repositoryId: string; revision: string; subject: string; path: string }>): SvnAccessSnapshot {
  if (!exactObject(value, ['repository_id', 'revision', 'subject', 'path', 'effective_access', 'captured_at_ms', 'expires_at_ms'])
      || !uuid(value.repository_id) || value.repository_id.toLowerCase() !== query.repositoryId.toLowerCase()
      || value.revision !== query.revision || value.subject !== query.subject || value.path !== query.path
      || !['none', 'read'].includes(value.effective_access as string)) invalid();
  const capturedAt = milliseconds(value.captured_at_ms);
  const expiresAt = milliseconds(value.expires_at_ms);
  if (expiresAt <= capturedAt) invalid();
  return Object.freeze({ repositoryId: value.repository_id.toLowerCase(), revision: value.revision,
    subject: value.subject, path: value.path, effectiveAccess: value.effective_access as 'none' | 'read',
    capturedAt, expiresAt });
}

function readView(executor: SqlExecutor, active: () => boolean): AuthorizationReadView {
  const ensureActive = (): void => { if (!active()) invalid('database-failed'); };
  return Object.freeze({
    async getPrincipal(principal: Readonly<AuthorizationPrincipal>): Promise<PrincipalRecord | null> {
      ensureActive();
      if (!exactObject(principal, ['type', 'id']) || !['user', 'service'].includes(principal.type)
          || !identifier(principal.id)) invalid('invalid-input');
      const statement = principal.type === 'user' ? GET_USER_PRINCIPAL : GET_SERVICE_PRINCIPAL;
      const row = optionalRow(await executor.execute<Record<string, unknown>>(statement, [principal.id]));
      return row === null ? null : principalRow(row, principal);
    },
    async listActiveTeamIds(userId: string): Promise<readonly string[]> {
      ensureActive();
      if (!identifier(userId)) invalid('invalid-input');
      const result = await executor.execute<Record<string, unknown>>(LIST_ACTIVE_TEAMS, [userId]);
      if (result.row_count !== result.rows.length) invalid();
      const ids = result.rows.map((row) => {
        if (!exactObject(row, ['team_id']) || !uuid(row.team_id)) invalid();
        return row.team_id.toLowerCase();
      });
      if (new Set(ids).size !== ids.length) invalid();
      return Object.freeze(ids);
    },
    async getProject(projectId: string): Promise<ProjectRecord | null> {
      ensureActive();
      if (!uuid(projectId)) invalid('invalid-input');
      const row = optionalRow(await executor.execute<Record<string, unknown>>(GET_PROJECT, [projectId]));
      return row === null ? null : projectRow(row);
    },
    async getRepository(repositoryId: string): Promise<RepositoryRecord | null> {
      ensureActive();
      if (!uuid(repositoryId)) invalid('invalid-input');
      const row = optionalRow(await executor.execute<Record<string, unknown>>(GET_REPOSITORY, [repositoryId]));
      return row === null ? null : repositoryRow(row);
    },
    async listProjectPermissions(projectId: string): Promise<readonly ProjectPermission[]> {
      ensureActive();
      if (!uuid(projectId)) invalid('invalid-input');
      const result = await executor.execute<Record<string, unknown>>(LIST_PROJECT_PERMISSIONS, [projectId]);
      if (result.row_count !== result.rows.length) invalid();
      return Object.freeze(result.rows.map(permissionRow));
    },
    async getSvnAccessSnapshot(query: Readonly<{ repositoryId: string; revision: string; subject: string; path: string }>): Promise<SvnAccessSnapshot | null> {
      ensureActive();
      if (!exactObject(query, ['repositoryId', 'revision', 'subject', 'path']) || !uuid(query.repositoryId)
          || typeof query.revision !== 'string' || !REVISION.test(query.revision)
          || !subject(query.subject) || !path(query.path)) invalid('invalid-input');
      const row = optionalRow(await executor.execute<Record<string, unknown>>(GET_SVN_ACCESS,
        [query.repositoryId, query.revision, query.subject, query.path]));
      return row === null ? null : svnAccessRow(row, query);
    },
  });
}

export class PostgresAuthorizationRepository implements AuthorizationRepository {
  readonly #database: AuthDatabase;

  constructor(value: AuthDatabase) {
    database(value);
    this.#database = value;
  }

  async readSnapshot<T>(work: (view: AuthorizationReadView) => Promise<T>): Promise<T> {
    if (typeof work !== 'function') invalid('invalid-input');
    return reduced(() => this.#database.transaction(async (transaction) => {
      let active = true;
      const view = readView(transaction, () => active);
      try {
        return await work(view);
      } finally {
        active = false;
      }
    }, READ_ONLY_SNAPSHOT));
  }
}
