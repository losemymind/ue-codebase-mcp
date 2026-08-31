import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveHybrid, HybridRetrievalError } from '../../services/retrieval/src/hybrid-retrieval.ts';
import { RetrievalStoreError } from '../../services/retrieval/src/retrieval-store.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const chunkA = 'a'.repeat(64);
const chunkB = 'b'.repeat(64);

function candidate(signal, chunk_key, score, overrides = {}) {
  return {
    signal, candidate_type: 'chunk', symbol_id: '20000000-0000-4000-8000-000000000001',
    stable_usr: `usr-${chunk_key}`, qualified_name: `Name-${chunk_key}`, symbol_kind: 'function',
    chunk_id: '30000000-0000-4000-8000-000000000001', chunk_key, chunk_kind: 'definition',
    file_id: `40000000-0000-4000-8000-00000000000${chunk_key === chunkA ? 1 : 2}`,
    file_path: `Source/${chunk_key}.cpp`, text: `text-${chunk_key}`, raw_score: score, edge_type: signal === 'graph' ? 'calls' : null,
    ...overrides,
  };
}

function store(overrides = {}) {
  return {
    async exactSymbols() { return [candidate('exact', chunkA, 1)]; },
    async ftsChunks() { return [candidate('fts', chunkB, 0.8)]; },
    async vectorChunks() { return [candidate('vector', chunkB, 0.9)]; },
    async graphSignals() { return [candidate('graph', chunkB, 1)]; },
    ...overrides,
  };
}

function provider() {
  return {
    schema: 'ue-codebase-mcp/provider', version: 1, id: 'approved-provider', kind: 'openai-compatible',
    endpoint: 'https://provider.example.invalid/v1', allowed_hosts: ['provider.example.invalid'],
    credential: { secret_ref: 'secret://provider/credential' }, embedding: { model: 'embed', dimensions: 3 },
    rerank: { model: 'rerank' }, data_processing_approved: true, enabled: true,
  };
}

test('hybrid retrieval combines authorized chunk signals and preserves the top exact result', async () => {
  const report = await retrieveHybrid(store(), {
    query: ' Run ', limit: 2, candidate_limit: 4,
    query_vector: { provider_id: 'approved', model: 'embed', dimensions: 3, embedding: [0, 0, 0] },
    graph_anchor_usr: 'anchor-usr',
  });
  assert.deepEqual(report.requested_signals, ['exact', 'fts', 'vector', 'graph']);
  assert.deepEqual(report.degraded_signals, []);
  assert.equal(report.hits[0].chunk_key, chunkA);
  assert.equal(report.hits[1].chunk_key, chunkB);
  assert.deepEqual(report.hits[1].evidence.map(({ source }) => source), ['fts', 'vector', 'graph']);
  assert.equal(report.rerank_applied, false);
});

test('optional vector and graph outages degrade while mandatory lexical failures are redacted', async () => {
  const degraded = await retrieveHybrid(store({
    async vectorChunks() { throw new Error('private vector detail'); },
    async graphSignals() { throw new RetrievalStoreError('database-failed'); },
  }), {
    query: 'Run', query_vector: { provider_id: 'approved', model: 'embed', dimensions: 3, embedding: [0, 0, 0] },
    graph_anchor_usr: 'anchor',
  });
  assert.deepEqual(degraded.degraded_signals, ['vector', 'graph']);
  assert.equal(degraded.hits[0].chunk_key, chunkA);
  await assert.rejects(retrieveHybrid(store({ async ftsChunks() { throw new Error('PRIVATE_QUERY_DETAIL'); } }), { query: 'Run' }),
    (error) => error instanceof HybridRetrievalError && error.code === 'mandatory-signal-failed' && !error.message.includes('PRIVATE'));
});

test('approved rerank only reorders the bounded hybrid set and safely degrades on failure', async () => {
  const reranked = await retrieveHybrid(store(), { query: 'Run', limit: 2 }, {
    rerank: {
      provider: provider(), project_id: projectId,
      execute: async (request) => ({ scores: request.inputs.map(({ chunk_key }) => ({ chunk_key, score: chunk_key === chunkB ? 1 : 0 })) }),
      options: { preserve_top_exact: false },
    },
  });
  assert.equal(reranked.rerank_applied, true);
  assert.equal(reranked.hits[0].chunk_key, chunkB);
  assert.deepEqual(new Set(reranked.hits.map(({ chunk_key }) => chunk_key)), new Set([chunkA, chunkB]));

  const fallback = await retrieveHybrid(store(), { query: 'Run', limit: 2 }, {
    rerank: { provider: provider(), project_id: projectId, execute: async () => { throw new Error('private provider body'); } },
  });
  assert.equal(fallback.rerank_applied, false);
  assert.deepEqual(fallback.degraded_signals, ['rerank']);
  assert.equal(fallback.hits[0].chunk_key, chunkA);
});

test('hybrid retrieval rejects invalid request bounds and conflicting channel metadata', async () => {
  await assert.rejects(retrieveHybrid(store(), { query: '', limit: 20 }), (error) => error instanceof HybridRetrievalError && error.code === 'invalid-request');
  await assert.rejects(retrieveHybrid(store(), { query: 'Run', limit: 21, candidate_limit: 20 }), (error) => error instanceof HybridRetrievalError && error.code === 'invalid-request');
  await assert.rejects(retrieveHybrid(store(), { query: 'Run', max_output_utf8_bytes: 100 }), (error) => error instanceof HybridRetrievalError && error.code === 'invalid-request');
  await assert.rejects(retrieveHybrid(store({
    async ftsChunks() { return [candidate('fts', chunkA, 1, { file_path: 'Source/Conflict.cpp' })]; },
  }), { query: 'Run' }), (error) => error instanceof HybridRetrievalError && error.code === 'candidate-conflict');
});

test('hybrid retrieval packs diverse hits within one bounded UTF-8 response budget', async () => {
  const report = await retrieveHybrid(store({
    async exactSymbols() { return [candidate('exact', chunkA, 1, { text: 'a'.repeat(900) })]; },
    async ftsChunks() { return [candidate('fts', chunkB, 1, { text: 'b'.repeat(900) })]; },
  }), { query: 'Run', limit: 2, max_output_utf8_bytes: 1024 });
  assert.equal(report.hits.length, 1);
  assert.ok(Buffer.byteLength(report.hits[0].text, 'utf8') <= 1024);
  assert.equal(report.hits[0].rank, 1);
});
