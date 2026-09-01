import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationsHttpEndpoint } from '../../apps/mcp-server/src/operations-http.ts';
import { ObservabilityRecorder } from '../../packages/observability/src/index.ts';

function endpoint(overrides = {}) {
  const records = [];
  const observability = new ObservabilityRecorder({ emit(record) { records.push(record); } });
  const target = new OperationsHttpEndpoint({
    allowed_hosts: ['operations.internal:8090'], readiness: { async check() { return true; } },
    metrics_authorizer: { async authorize(header) { return header === 'Bearer metrics-token'; } },
    observability, ...overrides,
  });
  return { target, records, observability };
}

const headers = Object.freeze({ host: 'operations.internal:8090' });

test('liveness is process-only and readiness fails closed without leaking component details', async () => {
  const live = await endpoint().target.handle({ method: 'GET', path: '/health/live', headers });
  assert.equal(live.status, 200);
  assert.deepEqual(JSON.parse(live.body), { status: 'live' });
  assert.match(live.headers['X-Correlation-ID'], /^[a-f0-9-]{36}$/u);

  const notReady = await endpoint({ readiness: { async check() { throw new Error('PRIVATE DATABASE DETAIL'); } } }).target
    .handle({ method: 'GET', path: '/health/ready', headers });
  assert.equal(notReady.status, 503);
  assert.deepEqual(JSON.parse(notReady.body), { status: 'not_ready' });
  assert.doesNotMatch(notReady.body, /PRIVATE|database/u);
});

test('metrics require a distinct bearer and expose only Prometheus text', async () => {
  const { target, observability } = endpoint();
  observability.record({ context: {
    correlation_id: '10000000-0000-4000-8000-000000000001', trace_id: '1'.repeat(32), span_id: '2'.repeat(16),
  }, component: 'mcp-server', operation: 'tool-call', outcome: 'succeeded', duration_ms: 5, attributes: { tool: 'search_code' } });
  assert.equal((await target.handle({ method: 'GET', path: '/metrics', headers })).status, 401);
  assert.equal((await target.handle({ method: 'GET', path: '/metrics', headers: { ...headers, authorization: 'Bearer wrong' } })).status, 403);
  const result = await target.handle({ method: 'GET', path: '/metrics', headers: { ...headers, authorization: 'Bearer metrics-token' } });
  assert.equal(result.status, 200);
  assert.match(result.headers['Content-Type'], /version=0\.0\.4/u);
  assert.match(result.body, /ue_codebase_requests_total/u);
  assert.doesNotMatch(result.body, /search_code|10000000-0000/u);
});

test('operations endpoint rejects hostile hosts, browser origins, bodies, methods and carrier injection', async () => {
  const { target } = endpoint();
  assert.equal((await target.handle({ method: 'GET', path: '/health/live', headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await target.handle({ method: 'GET', path: '/health/live', headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await target.handle({ method: 'POST', path: '/health/live', headers })).status, 405);
  assert.equal((await target.handle({ method: 'GET', path: '/health/live', headers, body: 'payload' })).status, 400);
  assert.equal((await target.handle({ method: 'GET', path: '/unknown', headers })).status, 404);
  assert.equal((await target.handle({ method: 'GET', path: '/health/live', headers: {
    ...headers, 'x-correlation-id': 'bad\nvalue',
  } })).status, 400);
});
