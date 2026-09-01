import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentBearerAuthenticator,
  InternalJobHttpEndpoint,
} from '../../services/index-coordinator/src/job-http.ts';
import { DurableJobLeaseError } from '../../services/index-coordinator/src/job-lease.ts';

const jobId = '20000000-0000-4000-8000-000000000001';
const lease = {
  job_id: jobId, agent_id: 'agent-01', attempt: 1,
  lease_token: '30000000-0000-4000-8000-000000000001', lease_expires_at: '2026-09-01T00:01:00.000Z',
};
const headers = Object.freeze({
  host: 'coordinator.example.test', authorization: 'Bearer agent-token',
  'content-type': 'application/json', accept: 'application/json',
});

function service(overrides = {}) {
  return {
    async register(request, identity) { return { accepted: true, registered_at: '2026-09-01T00:00:00.000Z', request, identity }; },
    async claim() { return null; },
    async heartbeat() { return { accepted: true, disposition: 'accepted', lease_expires_at: '2026-09-01T00:01:30.000Z' }; },
    async event() { return { accepted: true, disposition: 'accepted' }; },
    async complete() { return { accepted: true, disposition: 'accepted' }; },
    async fail() { return { accepted: true, disposition: 'accepted' }; },
    ...overrides,
  };
}

function endpoint(serviceValue = service(), authenticator = { async authenticate() { return { agent_id: 'agent-01' }; } }) {
  return new InternalJobHttpEndpoint(serviceValue, authenticator, { allowed_hosts: ['coordinator.example.test'] });
}

function post(target, path, body, headerOverrides = {}) {
  return target.handle({ method: 'POST', path, headers: { ...headers, ...headerOverrides }, body: JSON.stringify(body) });
}

test('internal job HTTP authenticates and routes protocol-v2 registration and claims', async () => {
  const target = endpoint();
  const registered = await post(target, '/internal/v1/agents/register', {
    schema: 'ue-codebase-mcp/agent-register', version: 2, agent_id: 'agent-01', agent_version: '0.1.0',
    ue_version: '5.6', vcs: ['svn'], capabilities: ['svn-sync', 'clang-index', 'module-index'],
  });
  assert.equal(registered.status, 200);
  assert.equal(JSON.parse(registered.body).identity.agent_id, 'agent-01');
  const claimed = await post(target, '/internal/v1/jobs/claim', {
    schema: 'ue-codebase-mcp/job-claim', version: 2, agent_id: 'agent-01', supported_kinds: ['reindex'], wait_ms: 0,
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body, 'null');
});

test('internal job HTTP binds job IDs in paths and routes all fenced operations', async () => {
  const calls = [];
  const target = endpoint(service({
    async heartbeat(value) { calls.push('heartbeat'); return { accepted: true, disposition: 'accepted' }; },
    async event(value) { calls.push('event'); return { accepted: true, disposition: 'accepted' }; },
    async complete(value) { calls.push('complete'); return { accepted: true, disposition: 'accepted' }; },
    async fail(value) { calls.push('fail'); return { accepted: true, disposition: 'accepted' }; },
  }));
  assert.equal((await post(target, `/internal/v1/jobs/${jobId}/heartbeat`, {
    ...lease, progress_percent: 1, resources: { memory_mb: 1, cpu_percent: 1 },
  })).status, 200);
  assert.equal((await post(target, `/internal/v1/jobs/${jobId}/events`, {
    ...lease, sequence: 0, level: 'info', event_type: 'index.started', fields: {},
  })).status, 200);
  assert.equal((await post(target, `/internal/v1/jobs/${jobId}/complete`, { ...lease, result: {} })).status, 200);
  assert.equal((await post(target, `/internal/v1/jobs/${jobId}/fail`, {
    ...lease, error_code: 'RESOURCE_LIMIT', retryable: false, diagnostic: 'resource limit exceeded',
  })).status, 200);
  assert.deepEqual(calls, ['heartbeat', 'event', 'complete', 'fail']);
  const mismatch = await post(target, `/internal/v1/jobs/${jobId}/heartbeat`, {
    ...lease, job_id: '20000000-0000-4000-8000-000000000002', progress_percent: 1, resources: { memory_mb: 1, cpu_percent: 1 },
  });
  assert.equal(mismatch.status, 400);
});

test('internal job HTTP rejects missing auth, hostile hosts/origins and invalid media', async () => {
  const target = endpoint();
  assert.equal((await post(target, '/internal/v1/jobs/claim', {}, { authorization: undefined })).status, 401);
  assert.equal((await post(target, '/internal/v1/jobs/claim', {}, { host: 'evil.test' })).status, 403);
  assert.equal((await post(target, '/internal/v1/jobs/claim', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post(target, '/internal/v1/jobs/claim', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(target, '/internal/v1/jobs/claim', {}, { accept: 'text/plain' })).status, 406);
  assert.equal((await target.handle({ method: 'GET', path: '/internal/v1/jobs/claim', headers })).status, 405);
});

test('agent bearer adapter requires a service identity and agent:work scope', async () => {
  const identity = { kind: 'bearer', tokenId: 'token-1', ownerType: 'service', ownerId: 'agent-01', scopes: ['profile'], expiresAt: Date.now() + 60_000 };
  const authenticator = createAgentBearerAuthenticator({ async authenticate() { return identity; } });
  await assert.rejects(authenticator.authenticate('Bearer token'));
  identity.scopes = ['agent:work'];
  assert.deepEqual(await authenticator.authenticate('Bearer token'), { agent_id: 'agent-01' });
  identity.ownerType = 'user';
  await assert.rejects(authenticator.authenticate('Bearer token'));
});

test('internal job HTTP maps durable failures to stable content-safe statuses', async () => {
  const target = endpoint(service({ async claim() { throw new DurableJobLeaseError('database-failed'); } }));
  const result = await post(target, '/internal/v1/jobs/claim', {});
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { error: 'database-failed' });
  assert.doesNotMatch(result.body, /database detail/u);
});
