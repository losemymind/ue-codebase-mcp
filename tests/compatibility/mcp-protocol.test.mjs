import assert from 'node:assert/strict';
import test from 'node:test';
import { OpaqueCursorCodec } from '../../apps/mcp-server/src/cursor.ts';
import {
  MCP_LATEST_PROTOCOL_VERSION,
  ReadOnlyMcpServer,
  ToolExecutionError,
} from '../../apps/mcp-server/src/server.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const principal = Object.freeze({ type: 'user', id: 'alice', credential_id: 'token-1', scopes: Object.freeze(['mcp:read']) });
const context = Object.freeze({ principal, protocol_version: '2025-11-25' });

function fixture(overrides = {}) {
  const calls = [];
  const audits = [];
  const backend = {
    async execute(request) {
      calls.push(request);
      return { items: [{ path: 'Source/A.cpp', line: 7 }], next_position: 'page:2' };
    },
    ...overrides.backend,
  };
  const audit = { async record(event) { audits.push(event); }, ...overrides.audit };
  return { server: new ReadOnlyMcpServer(backend, new OpaqueCursorCodec(Buffer.alloc(32, 3)), audit), calls, audits };
}

async function request(server, id, method, params) {
  return server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, context);
}

test('initialize negotiates a stable version and advertises only tool capability', async () => {
  const { server } = fixture();
  const reply = await request(server, 1, 'initialize', {
    protocolVersion: 'future-version', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' },
  });
  assert.equal(reply.body.result.protocolVersion, MCP_LATEST_PROTOCOL_VERSION);
  assert.deepEqual(reply.body.result.capabilities, { tools: { listChanged: false } });
  assert.match(reply.body.result.instructions, /read-only/u);
  assert.match(reply.body.result.instructions, /never writes source/u);
  assert.equal((await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, context)).kind, 'accepted');
});

test('tools/list paginates with an opaque caller-bound cursor', async () => {
  const { server } = fixture();
  const first = await request(server, 2, 'tools/list');
  assert.equal(first.body.result.tools.length, 5);
  assert.equal(typeof first.body.result.nextCursor, 'string');
  const second = await request(server, 3, 'tools/list', { cursor: first.body.result.nextCursor });
  assert.equal(second.body.result.tools.length, 4);
  assert.equal(second.body.result.nextCursor, undefined);
  const invalid = await request(server, 4, 'tools/list', { cursor: `${first.body.result.nextCursor}x` });
  assert.equal(invalid.body.error.code, -32602);
});

test('tools/call returns structured and text content and resumes an unchanged request', async () => {
  const { server, calls, audits } = fixture();
  const first = await request(server, 5, 'tools/call', { name: 'search_code', arguments: { project_id: projectId, query: 'Actor', limit: 2 } });
  assert.equal(first.body.result.isError, false);
  assert.deepEqual(JSON.parse(first.body.result.content[0].text), first.body.result.structuredContent);
  const cursor = first.body.result.structuredContent.next_cursor;
  const second = await request(server, 6, 'tools/call', {
    name: 'search_code', arguments: { project_id: projectId, query: 'Actor', limit: 2, cursor },
  });
  assert.equal(second.body.result.isError, false);
  assert.equal(calls[1].position, 'page:2');
  assert.equal(audits.length, 2);
  assert.equal('query' in audits[0], false);
  const changed = await request(server, 7, 'tools/call', {
    name: 'search_code', arguments: { project_id: projectId, query: 'Different', limit: 2, cursor },
  });
  assert.equal(changed.body.result.structuredContent.error.code, 'invalid_cursor');
});

test('tool failures are redacted and malformed backend output fails closed', async () => {
  const unavailable = fixture({ backend: { async execute() { throw new Error('PRIVATE DATABASE DETAIL'); } } });
  const reply = await request(unavailable.server, 8, 'tools/call', { name: 'index_status', arguments: { project_id: projectId } });
  assert.equal(reply.body.result.structuredContent.error.code, 'temporarily_unavailable');
  assert.doesNotMatch(JSON.stringify(reply.body), /PRIVATE/u);

  const malformed = fixture({ backend: { async execute() { return { items: ['not-an-object'] }; } } });
  const invalid = await request(malformed.server, 9, 'tools/call', { name: 'index_status', arguments: { project_id: projectId } });
  assert.equal(invalid.body.result.structuredContent.error.code, 'response_invalid');

  const semantic = fixture({ backend: { async execute() { throw new ToolExecutionError('not_visible'); } } });
  const denied = await request(semantic.server, 10, 'tools/call', { name: 'index_status', arguments: { project_id: projectId } });
  assert.equal(denied.body.result.structuredContent.error.code, 'not_visible');
});

test('unknown tools and ambiguous JSON-RPC envelopes are protocol errors', async () => {
  const { server } = fixture();
  const unknown = await request(server, 11, 'tools/call', { name: 'write_file', arguments: {} });
  assert.equal(unknown.body.error.code, -32602);
  const ambiguous = await server.handle({ jsonrpc: '2.0', id: 12, method: 'ping', result: {} }, context);
  assert.equal(ambiguous.body.error.code, -32600);
});

test('audit persistence failure fails the tool call closed', async () => {
  const { server } = fixture({ audit: { async record() { throw new Error('audit unavailable'); } } });
  const reply = await request(server, 13, 'tools/call', { name: 'index_status', arguments: { project_id: projectId } });
  assert.equal(reply.body.result.isError, true);
  assert.equal(reply.body.result.structuredContent.error.code, 'temporarily_unavailable');
});
