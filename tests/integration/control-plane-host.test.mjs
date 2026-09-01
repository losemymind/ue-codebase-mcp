import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { OpaqueCursorCodec } from '../../apps/mcp-server/src/cursor.ts';
import { OperationsHttpEndpoint } from '../../apps/mcp-server/src/operations-http.ts';
import { ReadOnlyMcpServer } from '../../apps/mcp-server/src/server.ts';
import { StreamableHttpMcpEndpoint } from '../../apps/mcp-server/src/streamable-http.ts';
import { ObservabilityRecorder } from '../../packages/observability/src/index.ts';
import { ControlPlaneHttpHost, parseControlPlaneListen } from '../../services/control-plane/src/host.ts';

function recorder() {
  return new ObservabilityRecorder({ emit() {} });
}

function endpoints() {
  const observability = recorder();
  const server = new ReadOnlyMcpServer(
    { async execute() { return Object.freeze({ items: Object.freeze([]) }); } },
    new OpaqueCursorCodec(new Uint8Array(32).fill(7)),
    { async record() {} },
    observability,
  );
  const publicEndpoint = new StreamableHttpMcpEndpoint(server, {
    async authenticate() { throw new Error('authentication unavailable'); },
  }, {
    resource_uri: 'https://public.test/mcp',
    authorization_servers: ['https://identity.test'],
    allowed_origins: ['https://client.test'],
    allowed_hosts: ['public.test'],
    rate_limiter: { async allow() { return true; } },
    observability,
  });
  const operationsEndpoint = new OperationsHttpEndpoint({
    allowed_hosts: ['operations.internal'],
    readiness: { async check() { return true; } },
    metrics_authorizer: { async authorize(value) { return value === 'Bearer metrics-token'; } },
    observability,
  });
  return { publicEndpoint, operationsEndpoint };
}

function request(port, path, host, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const operation = httpRequest({ hostname: '127.0.0.1', port, path, method,
      headers: { Host: host, Connection: 'close', ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Object.freeze({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString('utf8') })));
    });
    operation.on('error', reject);
    if (body !== undefined) operation.write(body);
    operation.end();
  });
}

test('listen parsing accepts explicit IP addresses and rejects ambiguous production binds', () => {
  assert.deepEqual(parseControlPlaneListen('0.0.0.0:8080'), { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(parseControlPlaneListen('[::1]:8081'), { host: '::1', port: 8081 });
  for (const value of ['localhost:8080', '127.0.0.1:0', '127.0.0.1:080', '127.0.0.1:65536',
    '127.0.0.1', '127.0.0.1:8080 extra', '[::1:8080']) {
    assert.throws(() => parseControlPlaneListen(value), /invalid control-plane listen/u);
  }
});

test('control-plane host binds isolated public and operations listeners with bounded surfaces', async (context) => {
  const { publicEndpoint, operationsEndpoint } = endpoints();
  const host = new ControlPlaneHttpHost(publicEndpoint, operationsEndpoint, {
    public_listen: { host: '127.0.0.1', port: 0 },
    operations_listen: { host: '127.0.0.1', port: 0 },
    shutdown_timeout_ms: 1_000,
  });
  context.after(() => host.close());
  const bindings = await host.start();
  assert.notEqual(bindings.public.port, bindings.operations.port);

  const metadata = await request(bindings.public.port, '/.well-known/oauth-protected-resource', 'public.test');
  assert.equal(metadata.status, 200);
  assert.equal(JSON.parse(metadata.body).resource, 'https://public.test/mcp');
  assert.equal((await request(bindings.public.port, '/metrics', 'public.test')).status, 404);

  const live = await request(bindings.operations.port, '/health/live', 'operations.internal');
  assert.equal(live.status, 200);
  assert.deepEqual(JSON.parse(live.body), { status: 'live' });
  assert.equal((await request(bindings.operations.port, '/metrics', 'operations.internal')).status, 401);
  assert.equal((await request(bindings.operations.port, '/metrics', 'operations.internal', {
    headers: { Authorization: 'Bearer metrics-token' },
  })).status, 200);
  assert.equal((await request(bindings.operations.port, '/health/live?detail=1', 'operations.internal')).status, 404);
  assert.equal((await request(bindings.operations.port, '/health/live', 'operations.internal', {
    method: 'GET', body: 'not-allowed', headers: { 'Content-Length': '11' },
  })).status, 400);

  await host.close();
  await assert.rejects(host.start(), /cannot be started/u);
});

test('control-plane host rejects shared sockets and unsafe timeout ordering before listening', () => {
  const { publicEndpoint, operationsEndpoint } = endpoints();
  assert.throws(() => new ControlPlaneHttpHost(publicEndpoint, operationsEndpoint, {
    public_listen: { host: '127.0.0.1', port: 8080 },
    operations_listen: { host: '127.0.0.1', port: 8080 },
  }), /listeners must be distinct/u);
  assert.throws(() => new ControlPlaneHttpHost(publicEndpoint, operationsEndpoint, {
    public_listen: { host: '127.0.0.1', port: 8080 },
    operations_listen: { host: '127.0.0.1', port: 8081 },
    headers_timeout_ms: 10_000,
    request_timeout_ms: 5_000,
  }), /timeout ordering/u);
});

test('control-plane host closes the public listener when the operations bind fails', async (context) => {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  context.after(() => new Promise((resolve) => occupied.close(resolve)));
  const address = occupied.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const { publicEndpoint, operationsEndpoint } = endpoints();
  const host = new ControlPlaneHttpHost(publicEndpoint, operationsEndpoint, {
    public_listen: { host: '127.0.0.1', port: 0 },
    operations_listen: { host: '127.0.0.1', port: address.port },
    shutdown_timeout_ms: 1_000,
  });
  await assert.rejects(host.start(), (error) => error?.code === 'EADDRINUSE');
  await host.close();
  await assert.rejects(host.start(), /cannot be started/u);
});
