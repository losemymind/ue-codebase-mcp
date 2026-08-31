import assert from 'node:assert/strict';
import test from 'node:test';
import { rankHybridCandidates } from '../../services/retrieval/src/hybrid-ranking.ts';
import { applyRerankScores, requestRerankScores, RerankError } from '../../services/retrieval/src/rerank.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const chunkA = 'a'.repeat(64);
const chunkB = 'b'.repeat(64);

function provider(overrides = {}) {
  return {
    schema: 'ue-codebase-mcp/provider', version: 1, id: 'approved-provider', kind: 'openai-compatible',
    endpoint: 'https://provider.example.invalid/v1', allowed_hosts: ['provider.example.invalid'],
    credential: { secret_ref: 'secret://provider/credential' }, embedding: { model: 'embedding-model', dimensions: 3 },
    rerank: { model: 'rerank-model' }, data_processing_approved: true, enabled: true, ...overrides,
  };
}

test('rerank request is bounded, retry-idempotent, and returns exact candidate scores', async () => {
  const keys = [];
  let attempts = 0;
  const report = await requestRerankScores(provider(), projectId, 'find Run', [
    { chunk_key: chunkA, text: 'void Run();' },
    { chunk_key: chunkB, text: 'void Stop();' },
  ], async (request) => {
    attempts += 1;
    keys.push(request.idempotency_key);
    if (attempts === 1) throw new Error('private transient detail');
    return { scores: [{ chunk_key: chunkA, score: 0.9 }, { chunk_key: chunkB, score: 0.1 }] };
  }, { is_transient_error: () => true });
  assert.equal(report.attempt_count, 2);
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(report.scores.map(({ chunk_key }) => chunk_key), [chunkA, chunkB]);
});

test('rerank only reorders the authorized hybrid set and preserves top exact by default', () => {
  const hybrid = rankHybridCandidates({ exact: [
    { chunk_key: chunkA, symbol_key: 'symbol-a', file_key: 'file-a', score: 1 },
  ], vector: [
    { chunk_key: chunkB, symbol_key: 'symbol-b', file_key: 'file-b', score: 1 },
  ] });
  const preserved = applyRerankScores(hybrid, [{ chunk_key: chunkA, score: 0 }, { chunk_key: chunkB, score: 1 }]);
  assert.equal(preserved[0].chunk_key, chunkA);
  assert.deepEqual(new Set(preserved.map(({ chunk_key }) => chunk_key)), new Set([chunkA, chunkB]));
  const reordered = applyRerankScores(hybrid, [{ chunk_key: chunkA, score: 0 }, { chunk_key: chunkB, score: 1 }], { preserve_top_exact: false });
  assert.equal(reordered[0].chunk_key, chunkB);
  assert.deepEqual(reordered.map(({ pre_rerank_rank }) => pre_rerank_rank).sort(), [1, 2]);
});

test('provider policy and response validation fail closed without leaking request bodies', async () => {
  const input = [{ chunk_key: chunkA, text: 'PRIVATE_SOURCE_CANARY' }];
  await assert.rejects(requestRerankScores(provider({ enabled: false }), projectId, 'query', input, async () => ({ scores: [] })),
    (error) => error instanceof RerankError && error.code === 'provider-disabled');
  await assert.rejects(requestRerankScores(provider({ data_processing_approved: false }), projectId, 'query', input, async () => ({ scores: [] })),
    (error) => error instanceof RerankError && error.code === 'provider-approval-required');
  await assert.rejects(requestRerankScores(provider({ rerank: undefined }), projectId, 'query', input, async () => ({ scores: [] })),
    (error) => error instanceof RerankError && error.code === 'rerank-not-configured');
  await assert.rejects(requestRerankScores(provider(), projectId, 'query', input, async () => ({ scores: [{ chunk_key: chunkA, score: Number.NaN }] })),
    (error) => error instanceof RerankError && error.code === 'invalid-provider-response' && !error.message.includes('PRIVATE_SOURCE_CANARY'));
});

test('rerank application rejects additions, omissions, duplicates, and invalid weights', () => {
  const hybrid = rankHybridCandidates({ fts: [
    { chunk_key: chunkA, symbol_key: 'symbol-a', file_key: 'file-a', score: 1 },
  ] });
  for (const action of [
    () => applyRerankScores(hybrid, []),
    () => applyRerankScores(hybrid, [{ chunk_key: chunkB, score: 1 }]),
    () => applyRerankScores(hybrid, [{ chunk_key: chunkA, score: 1 }], { rerank_weight: 2 }),
  ]) assert.throws(action, (error) => error instanceof RerankError && error.code === 'invalid-input');
});
