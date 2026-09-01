import assert from 'node:assert/strict';
import test from 'node:test';
import { OpaqueCursorCodec } from '../../apps/mcp-server/src/cursor.ts';
import { ReadOnlyMcpServer } from '../../apps/mcp-server/src/server.ts';
import { createBearerAuthenticator, StreamableHttpMcpEndpoint } from '../../apps/mcp-server/src/streamable-http.ts';
import { ObservabilityRecorder } from '../../packages/observability/src/index.ts';

const principal = Object.freeze({ type: 'service', id: 'ci', credential_id: 'token-1', scopes: Object.freeze(['mcp:read']) });
const observability = () => new ObservabilityRecorder({ emit() {} });

function endpoint(authenticator = { async authenticate() { return principal; } }) {
  const server = new ReadOnlyMcpServer(
    { async execute() { return { items: [] }; } },
    new OpaqueCursorCodec(Buffer.alloc(32, 5)),
    { async record() {} },
    observability(),
  );
  return new StreamableHttpMcpEndpoint(server, authenticator, {
    resource_uri: 'https://mcp.example.test/mcp',
    authorization_servers: ['https://auth.example.test'],
    allowed_origins: ['https://client.example.test'],
    allowed_hosts: ['mcp.example.test'],
    rate_limiter: { async allow() { return true; } },
    observability: observability(),
  });
}

const baseHeaders = Object.freeze({
  host: 'mcp.example.test',
  origin: 'https://client.example.test',
  authorization: 'Bearer token',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
});

const initialize = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
});

test('protected resource metadata is discoverable while the MCP endpoint requires bearer auth', async () => {
  const target = endpoint();
  const metadata = await target.handle({ method: 'GET', path: '/.well-known/oauth-protected-resource', headers: { host: 'mcp.example.test' } });
  assert.equal(metadata.status, 200);
  assert.deepEqual(JSON.parse(metadata.body), {
    resource: 'https://mcp.example.test/mcp', authorization_servers: ['https://auth.example.test'],
    scopes_supported: ['mcp:read'], bearer_methods_supported: ['header'],
  });
  const denied = await target.handle({ method: 'POST', path: '/mcp', headers: { host: 'mcp.example.test' }, body: initialize });
  assert.equal(denied.status, 401);
  assert.match(denied.headers['WWW-Authenticate'], /oauth-protected-resource/u);
});

test('Streamable HTTP validates Host, Origin, media types and unsupported GET', async () => {
  const target = endpoint();
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, host: 'evil.test' }, body: initialize })).status, 403);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, origin: 'https://evil.test' }, body: initialize })).status, 403);
  assert.equal((await target.handle({ method: 'GET', path: '/mcp', headers: baseHeaders })).status, 405);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, 'content-type': 'text/plain' }, body: initialize })).status, 415);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: { ...baseHeaders, accept: 'application/json' }, body: initialize })).status, 406);
});

test('Streamable HTTP returns JSON for requests and 202 for notifications', async () => {
  const target = endpoint();
  const initialized = await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize });
  assert.equal(initialized.status, 200);
  assert.match(initialized.headers['X-Correlation-ID'], /^[a-f0-9-]{36}$/u);
  assert.match(initialized.headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
  assert.equal(JSON.parse(initialized.body).result.protocolVersion, '2025-11-25');
  const notification = await target.handle({
    method: 'POST', path: '/mcp', headers: { ...baseHeaders, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notification.status, 202);
  assert.equal(notification.body, undefined);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: '{' })).status, 400);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: '[]' })).status, 400);
});

test('bearer adapter requires the mcp:read scope', async () => {
  const service = { async authenticate() {
    return { kind: 'bearer', tokenId: 'token-1', ownerType: 'service', ownerId: 'ci', scopes: ['profile'], expiresAt: Date.now() + 60_000 };
  } };
  const target = endpoint(createBearerAuthenticator(service));
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize })).status, 401);
  service.authenticate = async () => ({
    kind: 'bearer', tokenId: 'token-1', ownerType: 'service', ownerId: 'ci', scopes: ['mcp:read'], expiresAt: Date.now() + 60_000,
  });
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize })).status, 200);
});

test('the HTTP boundary enforces mcp:read for every authenticator implementation', async () => {
  const target = endpoint({ async authenticate() { return { ...principal, scopes: ['profile'] }; } });
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize })).status, 401);
});

test('the HTTP boundary rate limits authenticated requests and fails limiter outages closed', async () => {
  const make = (rate_limiter) => {
    const server = new ReadOnlyMcpServer(
      { async execute() { return { items: [] }; } }, new OpaqueCursorCodec(Buffer.alloc(32, 6)), { async record() {} }, observability(),
    );
    return new StreamableHttpMcpEndpoint(server, { async authenticate() { return principal; } }, {
      resource_uri: 'https://mcp.example.test/mcp', authorization_servers: ['https://auth.example.test'],
      allowed_origins: ['https://client.example.test'], allowed_hosts: ['mcp.example.test'], rate_limiter, observability: observability(),
    });
  };
  assert.equal((await make({ async allow() { return false; } }).handle({
    method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize,
  })).status, 429);
  assert.equal((await make({ async allow() { throw new Error('limiter unavailable'); } }).handle({
    method: 'POST', path: '/mcp', headers: baseHeaders, body: initialize,
  })).status, 503);
});

test('Streamable HTTP continues valid correlation and trace IDs and rejects injected values', async () => {
  const target = endpoint();
  const correlation = '10000000-0000-4000-8000-000000000099';
  const parentTrace = '00-11111111111111111111111111111111-2222222222222222-01';
  const result = await target.handle({ method: 'POST', path: '/mcp', headers: {
    ...baseHeaders, 'x-correlation-id': correlation, traceparent: parentTrace,
  }, body: initialize });
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Correlation-ID'], correlation);
  assert.match(result.headers.traceparent, /^00-11111111111111111111111111111111-[a-f0-9]{16}-01$/u);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: {
    ...baseHeaders, 'x-correlation-id': 'source\nBearer secret',
  }, body: initialize })).status, 400);
  assert.equal((await target.handle({ method: 'POST', path: '/mcp', headers: {
    ...baseHeaders, traceparent: '00-00000000000000000000000000000000-2222222222222222-01',
  }, body: initialize })).status, 400);
});
