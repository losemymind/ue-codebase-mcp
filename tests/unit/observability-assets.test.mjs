import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('Phase 1 Grafana dashboard uses only committed low-cardinality metric labels', async () => {
  const dashboard = JSON.parse(await readFile(path.join(root, 'deploy', 'observability', 'grafana', 'dashboards', 'phase-1-overview.json'), 'utf8'));
  assert.equal(dashboard.uid, 'ue-codebase-mcp-p1');
  assert.equal(dashboard.panels.length, 6);
  const queries = dashboard.panels.flatMap((panel) => panel.targets.map((target) => target.expr)).join('\n');
  assert.match(queries, /ue_codebase_requests_total/u);
  assert.match(queries, /ue_codebase_request_duration_ms_bucket/u);
  assert.match(queries, /ue_codebase_telemetry_dropped_total/u);
  assert.doesNotMatch(queries, /actor|agent_id|correlation|job_id|project_id|query|source|token|trace_id|user/u);
});

test('observability runbook declares payload exclusions and retention', async () => {
  const runbook = await readFile(path.join(root, 'docs', 'operations', 'observability.md'), 'utf8');
  for (const prohibited of ['bearer tokens', 'secret references', 'paths', 'queries', 'source excerpts', 'request/response bodies']) {
    assert.match(runbook, new RegExp(prohibited, 'u'));
  }
  assert.match(runbook, /metrics are retained for 90 days/u);
  assert.match(runbook, /redacted traces for 30 days/u);
});
