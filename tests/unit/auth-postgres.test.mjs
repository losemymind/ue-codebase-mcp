import assert from 'node:assert/strict';
import test from 'node:test';
import { AclPolicyEngine } from '../../packages/auth/src/policy.ts';
import {
  AUTH_POSTGRES_STATEMENTS,
  AuthPostgresError,
  PostgresAuthorizationRepository,
  PostgresBearerTokenRepository,
} from '../../services/control-plane/src/auth-postgres.ts';

const tokenId = '11111111-1111-4111-8111-111111111111';
const replacementId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const repositoryId = '44444444-4444-4444-8444-444444444444';
const teamId = '55555555-5555-4555-8555-555555555555';

class FakeDatabase {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.transactions = [];
  }

  async execute(statement, values) {
    this.calls.push({ statement, values, transaction: false });
    return this.handler(statement, values, false);
  }

  async transaction(operation, options) {
    const transaction = { options, calls: [] };
    this.transactions.push(transaction);
    return operation(Object.freeze({
      execute: async (statement, values) => {
        transaction.calls.push({ statement, values });
        return this.handler(statement, values, true);
      },
    }));
  }
}

function result(rows) {
  return { rows, row_count: rows.length };
}

function tokenRecord(id = tokenId) {
  return Object.freeze({
    id,
    ownerType: 'user',
    ownerId: 'user-1',
    tokenHash: new Uint8Array(58).fill(7),
    scopes: Object.freeze(['mcp:read']),
    expiresAt: 2_000_000,
    revokedAt: null,
    createdAt: 1_000_000,
  });
}

test('auth SQL policy is fixed, named, unique and path-scoped', () => {
  assert.equal(AUTH_POSTGRES_STATEMENTS.length, 11);
  assert.equal(new Set(AUTH_POSTGRES_STATEMENTS.map(({ name }) => name)).size, AUTH_POSTGRES_STATEMENTS.length);
  assert.ok(AUTH_POSTGRES_STATEMENTS.every(({ name, text }) => /^[a-z][a-z0-9-]+$/u.test(name) && text.includes('$')));
  const svn = AUTH_POSTGRES_STATEMENTS.find(({ name }) => name === 'auth-svn-access-get-v1');
  assert.match(svn.text, /path_prefix IS NOT NULL/u);
  assert.match(svn.text, /path_prefix = '' OR path_prefix = \$4/u);
  assert.match(svn.text, /starts_with\(\$4, path_prefix \|\| '\/'\)/u);
  assert.match(svn.text, /ORDER BY length\(path_prefix\) DESC/u);
});

test('bearer token repository validates rows and performs fenced rotation atomically', async () => {
  const database = new FakeDatabase((statement, values) => {
    if (statement.name === 'auth-token-find-v1') return result([{
      id: tokenId, owner_type: 'user', owner_id: 'user-1', token_hash: new Uint8Array(58).fill(7),
      scopes: ['mcp:read'], expires_at_ms: '2000000', revoked_at_ms: null, created_at_ms: '1000000',
    }]);
    if (statement.name === 'auth-token-revoke-current-v1') return result([{
      id: tokenId, owner_type: 'user', owner_id: 'user-1', scopes: ['mcp:read'],
    }]);
    if (statement.name === 'auth-token-insert-v1') return result([{ id: values[0] }]);
    if (statement.name === 'auth-token-revoke-v1') return result([{ id: tokenId }]);
    throw new Error('unexpected statement');
  });
  const repository = new PostgresBearerTokenRepository(database);
  assert.deepEqual(await repository.findById(tokenId), tokenRecord());
  await repository.insert(tokenRecord(replacementId));
  await repository.replace(tokenId, tokenRecord(replacementId), 1_000_000);
  await repository.revoke(tokenId, 1_000_001);

  assert.deepEqual(database.transactions[0].calls.map(({ statement }) => statement.name),
    ['auth-token-revoke-current-v1', 'auth-token-insert-v1']);
  assert.equal(database.calls.find(({ statement }) => statement.name === 'auth-token-insert-v1').values[4], '["mcp:read"]');
});

test('bearer token repository fails closed on conflicts and redacts database diagnostics', async () => {
  const conflict = new PostgresBearerTokenRepository(new FakeDatabase(() => result([])));
  await assert.rejects(conflict.replace(tokenId, tokenRecord(replacementId), 1_000_000),
    (error) => error instanceof AuthPostgresError && error.code === 'write-conflict');

  const failed = new PostgresBearerTokenRepository(new FakeDatabase(() => {
    throw new Error('PRIVATE DATABASE DETAIL');
  }));
  await assert.rejects(failed.findById(tokenId), (error) => {
    assert.equal(error.code, 'database-failed');
    assert.doesNotMatch(error.message, /PRIVATE|DATABASE DETAIL/u);
    return true;
  });
});

function authorizationHandler(statement, values) {
  switch (statement.name) {
    case 'auth-user-principal-get-v1':
      return result([{ type: 'user', id: values[0], svn_subject: 'corp\\user-1', active: true }]);
    case 'auth-active-teams-list-v1': return result([{ team_id: teamId }]);
    case 'auth-project-get-v1': return result([{ id: projectId, status: 'active' }]);
    case 'auth-repository-get-v1':
      return result([{ id: repositoryId, project_id: projectId, kind: 'svn', enabled: true }]);
    case 'auth-project-permissions-list-v1':
      return result([{ project_id: projectId, principal_type: 'team', principal_id: teamId, role: 'reader' }]);
    case 'auth-svn-access-get-v1':
      return result([{ repository_id: repositoryId, revision: values[1], subject: values[2], path: values[3],
        effective_access: 'read', captured_at_ms: '1900000', expires_at_ms: '2100000' }]);
    default: throw new Error('unexpected statement');
  }
}

test('authorization repository uses one read-only repeatable-read snapshot and supports path ACLs', async () => {
  const database = new FakeDatabase(authorizationHandler);
  const repository = new PostgresAuthorizationRepository(database);
  const policy = new AclPolicyEngine(repository, 300_000, { now: () => 2_000_000 });
  const decision = await policy.evaluate({
    principal: { type: 'user', id: 'user-1' }, action: 'read', projectId, repositoryId,
    revision: '42', path: 'Source/Game.cpp',
  });
  assert.deepEqual(decision, { allowed: true, reason: 'allowed', role: 'reader' });
  assert.deepEqual(database.transactions[0].options, { isolation: 'repeatable-read', read_only: true });
  assert.deepEqual(database.transactions[0].calls.map(({ statement }) => statement.name), [
    'auth-user-principal-get-v1', 'auth-project-get-v1', 'auth-repository-get-v1',
    'auth-active-teams-list-v1', 'auth-project-permissions-list-v1', 'auth-svn-access-get-v1',
  ]);
});

test('authorization repository denies missing SVN mapping, malformed rows and escaped snapshot views', async () => {
  const missing = new PostgresAuthorizationRepository(new FakeDatabase((statement, values) =>
    statement.name === 'auth-user-principal-get-v1' ? result([]) : authorizationHandler(statement, values)));
  const request = { principal: { type: 'user', id: 'user-1' }, action: 'read', projectId, repositoryId,
    revision: '42', path: 'Source/Game.cpp' };
  assert.deepEqual(await new AclPolicyEngine(missing, 300_000, { now: () => 2_000_000 }).evaluate(request),
    { allowed: false, reason: 'not_visible' });

  const malformed = new PostgresAuthorizationRepository(new FakeDatabase((statement, values) =>
    statement.name === 'auth-project-get-v1' ? result([{ id: projectId, status: 'unknown' }])
      : authorizationHandler(statement, values)));
  assert.deepEqual(await new AclPolicyEngine(malformed, 300_000, { now: () => 2_000_000 }).evaluate(request),
    { allowed: false, reason: 'not_visible' });

  let escaped;
  const valid = new PostgresAuthorizationRepository(new FakeDatabase(authorizationHandler));
  await valid.readSnapshot(async (view) => { escaped = view; return undefined; });
  await assert.rejects(escaped.getProject(projectId),
    (error) => error instanceof AuthPostgresError && error.code === 'database-failed');
});

test('service principals use a separate durable mapping', async () => {
  const repository = new PostgresAuthorizationRepository(new FakeDatabase((statement, values) => {
    if (statement.name === 'auth-service-principal-get-v1') {
      return result([{ type: 'service', id: values[0], svn_subject: 'svc-indexer', active: true }]);
    }
    throw new Error('unexpected statement');
  }));
  const principal = await repository.readSnapshot((view) => view.getPrincipal({ type: 'service', id: 'service-1' }));
  assert.deepEqual(principal, { type: 'service', id: 'service-1', svnSubject: 'svc-indexer', active: true });
});
