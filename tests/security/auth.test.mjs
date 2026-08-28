import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import test from 'node:test';
import {
  AclPolicyEngine,
  AuthenticationError,
  AuthorizationError,
  BearerTokenService,
  OidcJwtVerifier,
} from '../../packages/auth/src/index.ts';

class MillisecondClock {
  constructor(now) { this.value = now; }
  now() { return this.value; }
}

function jwt(privateKey, kid, claims, header = { alg: 'RS256', kid, typ: 'JWT' }) {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${encodedHeader}.${encodedClaims}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function rsaFixture(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid, use: 'sig' } };
}

function claims(nowSeconds, overrides = {}) {
  return {
    iss: 'https://identity.example.invalid',
    aud: 'ue-codebase-mcp',
    sub: 'user-1',
    iat: nowSeconds - 10,
    nbf: nowSeconds - 10,
    exp: nowSeconds + 300,
    scope: 'code:read',
    ...overrides,
  };
}

test('OIDC verifies RS256 and uniformly rejects expiry, issuer, audience, and signature failures', async () => {
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  const key = rsaFixture('key-1');
  const other = rsaFixture('other');
  const verifier = new OidcJwtVerifier({
    id: 'corp', issuer: 'https://identity.example.invalid', audiences: ['ue-codebase-mcp'],
    jwksUri: 'https://identity.example.invalid/jwks', allowedAlgorithms: ['RS256'], jwksCacheTtlMs: 60_000,
  }, { fetchJwks: async () => ({ keys: [key.jwk] }) }, new MillisecondClock(now));

  const identity = await verifier.verify(jwt(key.privateKey, 'key-1', claims(nowSeconds)));
  assert.equal(identity.subject, 'user-1');
  assert.deepEqual(identity.scopes, ['code:read']);

  const invalid = [
    jwt(key.privateKey, 'key-1', claims(nowSeconds, { exp: nowSeconds - 61 })),
    jwt(key.privateKey, 'key-1', claims(nowSeconds, { iss: 'https://attacker.invalid' })),
    jwt(key.privateKey, 'key-1', claims(nowSeconds, { aud: 'another-service' })),
    jwt(other.privateKey, 'key-1', claims(nowSeconds)),
    jwt(key.privateKey, 'key-1', claims(nowSeconds), { alg: 'none', kid: 'key-1' }),
  ];
  for (const token of invalid) {
    await assert.rejects(() => verifier.verify(token), (error) => error instanceof AuthenticationError && error.message === 'authentication failed');
  }
});

test('OIDC refreshes a fresh JWKS cache once when an unknown rotated kid appears', async () => {
  const now = 1_800_000_000_000;
  const oldKey = rsaFixture('old');
  const newKey = rsaFixture('new');
  let fetches = 0;
  const verifier = new OidcJwtVerifier({
    id: 'corp', issuer: 'https://identity.example.invalid', audiences: ['ue-codebase-mcp'],
    jwksUri: 'https://identity.example.invalid/jwks', allowedAlgorithms: ['RS256'], jwksCacheTtlMs: 60_000,
  }, { fetchJwks: async () => ({ keys: [fetches++ === 0 ? oldKey.jwk : newKey.jwk] }) }, new MillisecondClock(now));
  await verifier.verify(jwt(oldKey.privateKey, 'old', claims(Math.floor(now / 1000))));
  await verifier.verify(jwt(newKey.privateKey, 'new', claims(Math.floor(now / 1000))));
  assert.equal(fetches, 2);
});

class MemoryTokenRepository {
  records = new Map();
  async findById(id) { return this.records.get(id) ?? null; }
  async insert(record) { if (this.records.has(record.id)) throw new Error('duplicate'); this.records.set(record.id, record); }
  async replace(currentId, replacement, revokedAt) {
    const current = this.records.get(currentId);
    if (!current || current.revokedAt !== null) throw new Error('stale');
    this.records.set(currentId, { ...current, revokedAt });
    this.records.set(replacement.id, replacement);
  }
  async revoke(id, revokedAt) {
    const current = this.records.get(id);
    if (!current) throw new Error('missing');
    this.records.set(id, { ...current, revokedAt });
  }
}

test('bearer tokens persist only a memory-hard hash and enforce expiry, revocation, and rotation', async () => {
  const clock = new MillisecondClock(1_800_000_000_000);
  const repository = new MemoryTokenRepository();
  const service = new BearerTokenService(repository, randomBytes(32), clock);
  const issued = await service.issue({ ownerType: 'user', ownerId: 'user-1', scopes: ['code:read'], expiresAt: clock.now() + 60_000 });
  assert.doesNotMatch(JSON.stringify([...repository.records.values()]), new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(issued.record.tokenHash instanceof Uint8Array);
  assert.equal((await service.authenticate(`Bearer ${issued.token}`)).ownerId, 'user-1');

  const rotated = await service.rotate(issued.record.id, clock.now() + 120_000);
  await assert.rejects(() => service.authenticate(`Bearer ${issued.token}`), AuthenticationError);
  assert.equal((await service.authenticate(`Bearer ${rotated.token}`)).tokenId, rotated.record.id);
  await service.revoke(rotated.record.id);
  await assert.rejects(() => service.authenticate(`Bearer ${rotated.token}`), AuthenticationError);
});

function policyFixture(now) {
  const state = {
    principal: { type: 'user', id: 'user-1', svnSubject: 'corp\\user-1', active: true },
    project: { id: 'project-1', status: 'active' },
    repository: { id: 'repo-1', projectId: 'project-1', kind: 'svn', enabled: true },
    teams: ['team-1'],
    permissions: [{ projectId: 'project-1', principalType: 'team', principalId: 'team-1', role: 'reader' }],
    svn: { repositoryId: 'repo-1', revision: '42', subject: 'corp\\user-1', path: 'Source/Foo.cpp', effectiveAccess: 'read', capturedAt: now - 1_000, expiresAt: now + 60_000 },
  };
  const view = {
    getPrincipal: async () => state.principal,
    listActiveTeamIds: async () => state.teams,
    getProject: async () => state.project,
    getRepository: async () => state.repository,
    listProjectPermissions: async () => state.permissions,
    getSvnAccessSnapshot: async () => state.svn,
  };
  return { state, repository: { readSnapshot: async (work) => work(view) } };
}

test('ACL policy is fail-closed and requires fresh SVN access intersected with current MCP grants', async () => {
  const now = 1_800_000_000_000;
  const fixture = policyFixture(now);
  const engine = new AclPolicyEngine(fixture.repository, 300_000, new MillisecondClock(now));
  const request = { principal: { type: 'user', id: 'user-1' }, action: 'read', projectId: 'project-1', repositoryId: 'repo-1', revision: '42', path: 'Source/Foo.cpp' };
  assert.equal((await engine.evaluate(request)).allowed, true);

  fixture.state.permissions = [];
  assert.deepEqual(await engine.evaluate(request), { allowed: false, reason: 'not_visible' });
  fixture.state.permissions = [{ projectId: 'project-1', principalType: 'user', principalId: 'user-1', role: 'reader' }];
  fixture.state.svn = { ...fixture.state.svn, effectiveAccess: 'none' };
  assert.deepEqual(await engine.evaluate(request), { allowed: false, reason: 'not_visible' });
  fixture.state.svn = { ...fixture.state.svn, effectiveAccess: 'read', capturedAt: now - 301_000 };
  await assert.rejects(() => engine.authorize(request), (error) => error instanceof AuthorizationError && error.message === 'resource is not visible');
  fixture.state.svn = { ...fixture.state.svn, capturedAt: now - 1_000 };
  assert.deepEqual(await engine.evaluate({ ...request, projectId: 'other-project' }), { allowed: false, reason: 'not_visible' });
  assert.deepEqual(await engine.evaluate({ ...request, path: '../secret' }), { allowed: false, reason: 'not_visible' });
});

