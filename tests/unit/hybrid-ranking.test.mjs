import assert from 'node:assert/strict';
import test from 'node:test';
import { HybridRankingError, rankHybridCandidates } from '../../services/retrieval/src/hybrid-ranking.ts';

function candidate(chunk_key, score, symbol_key = `symbol-${chunk_key}`, file_key = `file-${chunk_key}`) {
  return { chunk_key, score, symbol_key, file_key };
}

test('hybrid ranking fuses all sources, deduplicates chunks, and preserves source evidence', () => {
  const result = rankHybridCandidates({
    exact: [candidate('shared', 100), candidate('exact-only', 50)],
    fts: [candidate('shared', 0.7), candidate('fts-only', 0.9)],
    vector: [candidate('shared', 0.5), candidate('vector-only', 0.99)],
    graph: [candidate('shared', 20), candidate('graph-only', 30)],
  }, { limit: 10 });

  assert.equal(result.filter(({ chunk_key }) => chunk_key === 'shared').length, 1);
  assert.deepEqual(result[0].evidence.map(({ source }) => source), ['exact', 'fts', 'vector', 'graph']);
  assert.equal(result[0].rank, 1);
  assert.equal(new Set(result.map(({ chunk_key }) => chunk_key)).size, result.length);
  assert.ok(result[0].evidence.every(({ source_rank, source_score, weighted_rrf_score }) =>
    source_rank > 0 && source_score >= 0 && weighted_rrf_score >= 0));
});

test('source-local duplicate candidates keep the best score without duplicate evidence', () => {
  const result = rankHybridCandidates({
    fts: [candidate('same', 0.2), candidate('same', 0.9)],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence.length, 1);
  assert.equal(result[0].evidence[0].source_score, 0.9);
  assert.equal(result[0].evidence[0].source_rank, 1);
});

test('bounded weights disable zero-only candidates while retaining evidence on fused candidates', () => {
  const result = rankHybridCandidates({
    exact: [candidate('exact-only', 1), candidate('shared', 0.5)],
    vector: [candidate('vector', 1), candidate('shared', 1)],
  }, { weights: { exact: 0, fts: 0, vector: 1, graph: 0 } });
  assert.deepEqual(result.map(({ chunk_key }) => chunk_key), ['shared', 'vector']);
  assert.equal(result.some(({ chunk_key }) => chunk_key === 'exact-only'), false);
  assert.equal(result.find(({ chunk_key }) => chunk_key === 'shared').evidence.find(({ source }) => source === 'exact').weighted_rrf_score, 0);
});

test('top exact match is preserved ahead of multi-channel semantic candidates by default', () => {
  const result = rankHybridCandidates({
    exact: [candidate('exact', 1)],
    fts: [candidate('semantic', 1)],
    vector: [candidate('semantic', 1)],
    graph: [candidate('semantic', 1)],
  });
  assert.equal(result[0].chunk_key, 'exact');
  const unpinned = rankHybridCandidates({
    exact: [candidate('exact', 1)],
    fts: [candidate('semantic', 1)],
    vector: [candidate('semantic', 1)],
    graph: [candidate('semantic', 1)],
  }, { preserve_top_exact: false });
  assert.equal(unpinned[0].chunk_key, 'semantic');
});

test('ties are resolved deterministically by chunk key regardless of input ordering', () => {
  const ascending = rankHybridCandidates({ fts: [candidate('a', 1), candidate('b', 1)] });
  const descending = rankHybridCandidates({ fts: [candidate('b', 1), candidate('a', 1)] });
  assert.deepEqual(ascending, descending);
  assert.deepEqual(ascending.map(({ chunk_key }) => chunk_key), ['a', 'b']);
});

test('diversity limits cap repeated symbols and files while filling the requested limit', () => {
  const result = rankHybridCandidates({ exact: [
    candidate('a', 10, 'symbol-one', 'file-one'),
    candidate('b', 9, 'symbol-one', 'file-two'),
    candidate('c', 8, 'symbol-two', 'file-one'),
    candidate('d', 7, 'symbol-three', 'file-three'),
  ] }, { limit: 3, max_per_symbol: 1, max_per_file: 1 });
  assert.deepEqual(result.map(({ chunk_key }) => chunk_key), ['a', 'd']);
});

test('anonymous chunks are limited by file but not grouped as one synthetic symbol', () => {
  const result = rankHybridCandidates({ graph: [
    candidate('a', 3, null, 'file-a'),
    candidate('b', 2, null, 'file-b'),
  ] }, { max_per_symbol: 1, max_per_file: 1 });
  assert.deepEqual(result.map(({ chunk_key }) => chunk_key), ['a', 'b']);
});

test('runtime validation rejects invalid and conflicting data with content-safe errors', () => {
  const secret = 'private source body that must not leak';
  const assertions = [
    () => rankHybridCandidates({ vector: [{ ...candidate('x', 1), score: Number.NaN, text: secret }] }),
    () => rankHybridCandidates({ exact: [candidate('same', 2, 'one')], fts: [candidate('same', 1, 'two')] }),
    () => rankHybridCandidates({ exact: [candidate('same', 1, 'one'), candidate('same', 2, 'two')] }),
    () => rankHybridCandidates({ exact: [] }, { weights: { exact: 2 } }),
    () => rankHybridCandidates({ exact: [] }, { weights: { exact: 0, fts: 0, vector: 0, graph: 0 } }),
    () => rankHybridCandidates({ unsupported: [] }),
  ];
  for (const invoke of assertions) {
    assert.throws(invoke, (error) =>
      error instanceof HybridRankingError && !error.message.includes(secret));
  }
});
