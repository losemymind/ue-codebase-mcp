import assert from 'node:assert/strict';
import test from 'node:test';
import {
  childObservationContext,
  createObservationContext,
  ObservabilityRecorder,
  PostgresAuditSink,
  sanitizeTelemetryAttributes,
  traceparent,
} from '../../packages/observability/src/index.ts';

test('observation contexts continue correlation and W3C trace identity with a fresh span', () => {
  const context = createObservationContext({
    'X-Correlation-ID': '10000000-0000-4000-8000-000000000001',
    traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
  });
  assert.equal(context.correlation_id, '10000000-0000-4000-8000-000000000001');
  assert.equal(context.trace_id, '11111111111111111111111111111111');
  assert.notEqual(context.span_id, '2222222222222222');
  assert.match(traceparent(context), /^00-11111111111111111111111111111111-[a-f0-9]{16}-01$/u);
  const child = childObservationContext(context);
  assert.equal(child.correlation_id, context.correlation_id);
  assert.equal(child.trace_id, context.trace_id);
  assert.notEqual(child.span_id, context.span_id);
});

test('observation carriers and telemetry attributes reject injection and payload fields', () => {
  assert.throws(() => createObservationContext({ 'x-correlation-id': 'bad\nvalue' }));
  assert.throws(() => createObservationContext({ traceparent: '00-00000000000000000000000000000000-2222222222222222-01' }));
  assert.throws(() => createObservationContext({ Traceparent: '00-11111111111111111111111111111111-2222222222222222-01', traceparent: 'duplicate' }));
  for (const key of ['authorization', 'token', 'query', 'source', 'code', 'path', 'actor_id', 'job_id']) {
    assert.throws(() => sanitizeTelemetryAttributes({ [key]: 'PRIVATE_SOURCE_CANARY' }));
  }
  assert.deepEqual(sanitizeTelemetryAttributes({ tool: 'search_code', status_code: 200, retryable: false }), {
    tool: 'search_code', status_code: 200, retryable: false,
  });
});

test('structured logs and spans share context while Prometheus labels stay low-cardinality', () => {
  const records = [];
  const recorder = new ObservabilityRecorder({ emit(record) { records.push(record); } }, undefined,
    () => new Date('2026-09-01T00:00:00.000Z'));
  const context = createObservationContext();
  recorder.record({ context, component: 'mcp-server', operation: 'tool-call', outcome: 'failed', duration_ms: 12.25,
    attributes: { tool: 'search_code', error_code: 'not_visible' } });
  assert.deepEqual(records.map(({ kind }) => kind), ['log', 'span']);
  assert.equal(records[0].correlation_id, context.correlation_id);
  assert.equal(records[0].attributes.tool, 'search_code');
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_SOURCE_CANARY|authorization|request_hash/u);
  const metrics = recorder.metrics();
  assert.match(metrics, /ue_codebase_requests_total\{component="mcp-server",operation="tool-call",outcome="failed"\} 1/u);
  assert.doesNotMatch(metrics, new RegExp(context.correlation_id, 'u'));
  assert.doesNotMatch(metrics, /search_code/u);
  assert.throws(() => recorder.record({ context, component: 'project-10000000', operation: 'request',
    outcome: 'succeeded', duration_ms: 1 }));
  assert.throws(() => recorder.record({ context, component: 'mcp-http', operation: 'query-PRIVATE_SOURCE_CANARY',
    outcome: 'succeeded', duration_ms: 1 }));
});

test('telemetry sink failures never trigger raw fallback and are counted', () => {
  const recorder = new ObservabilityRecorder({ emit() { throw new Error('PRIVATE_SOURCE_CANARY'); } });
  assert.doesNotThrow(() => recorder.record({ context: createObservationContext(), component: 'windows-agent',
    operation: 'iteration', outcome: 'succeeded', duration_ms: 1 }));
  assert.match(recorder.metrics(), /ue_codebase_telemetry_dropped_total 2/u);
  assert.doesNotMatch(recorder.metrics(), /PRIVATE_SOURCE_CANARY/u);
});

test('PostgreSQL audit sink uses one fixed statement and rejects content-bearing fields', async () => {
  const calls = [];
  const sink = new PostgresAuditSink({ async execute(statement, values) { calls.push({ statement, values }); return { row_count: 1 }; } });
  const context = createObservationContext();
  await sink.record({ actor_type: 'user', actor_id: 'alice', action: 'mcp.tool.call',
    project_id: '10000000-0000-4000-8000-000000000001', tool: 'search_code', outcome: 'succeeded',
    request_hash: 'a'.repeat(64), correlation_id: context.correlation_id, trace_id: context.trace_id, span_id: context.span_id,
    resource_type: 'project', resource_id: '10000000-0000-4000-8000-000000000001', error_code: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].statement.name, 'observability-insert-audit-event-v1');
  assert.match(calls[0].statement.text, /decode\(\$7, 'hex'\)/u);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_SOURCE_CANARY/u);
  await assert.rejects(sink.record({ actor_type: 'user', actor_id: 'alice', action: 'mcp.tool.call',
    project_id: null, tool: 'PRIVATE SOURCE BODY WITH SPACES', outcome: 'failed', request_hash: 'a'.repeat(64),
    correlation_id: context.correlation_id, trace_id: context.trace_id, span_id: context.span_id,
    resource_type: null, resource_id: null, error_code: null }));
});
