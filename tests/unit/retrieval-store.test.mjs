import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetrievalStore, RetrievalStoreError } from '../../services/retrieval/src/retrieval-store.ts';

const projectId = '10000000-0000-4000-8000-000000000001';
const generationId = '20000000-0000-4000-8000-000000000001';
const symbolId = '30000000-0000-4000-8000-000000000001';
const chunkId = '40000000-0000-4000-8000-000000000001';
const fileId = '50000000-0000-4000-8000-000000000001';
const repositoryId = '60000000-0000-4000-8000-000000000001';
const chunkKey = 'a'.repeat(64);
const aclContextHash = 'b'.repeat(64);

const symbolRow = {
  scope_generation_id: generationId,
  candidate_type: 'symbol',
  symbol_id: symbolId,
  stable_usr: 'c:@N@Demo@F@Run#',
  qualified_name: 'Demo::Run',
  symbol_kind: 'function',
  chunk_id: null,
  chunk_key: null,
  chunk_kind: null,
  file_id: null,
  file_path: null,
  text: null,
  raw_score: 1,
  edge_type: null,
};

const chunkRow = {
  ...symbolRow,
  candidate_type: 'chunk',
  chunk_id: chunkId,
  chunk_key: chunkKey,
  chunk_kind: 'definition',
  file_id: fileId,
  file_path: 'Source/Demo.cpp',
  text: 'void Demo::Run() {}',
  raw_score: 0.75,
};

class FakeDatabase {
  constructor(rowsByStatement = {}) {
    this.rowsByStatement = rowsByStatement;
    this.calls = [];
    this.failure = null;
  }

  async execute(statement, values) {
    this.calls.push({ statement, values });
    if (this.failure !== null) throw this.failure;
    const rows = this.rowsByStatement[statement.name] ?? [{ ...symbolRow, candidate_type: null, symbol_id: null,
      stable_usr: null, qualified_name: null, symbol_kind: null, raw_score: null }];
    return { rows, row_count: rows.length };
  }
}

function store(database = new FakeDatabase(), scopeOverrides = {}) {
  return createRetrievalStore(database, {
    project_id: projectId,
    generation_id: generationId,
    authorized_paths: [{ repository_id: repositoryId, path_prefix: 'Source' }],
    acl_context_hash: aclContextHash,
    embedding_profile: { provider_id: 'approved', model: 'embed-v1', dimensions: 3 },
    ...scopeOverrides,
  });
}

test('retrieval store exposes fixed named parameterized SQL and unified candidate metadata', async () => {
  const database = new FakeDatabase({
    'retrieval-store-exact-symbols-v1': [{ ...chunkRow, raw_score: 1 }],
    'retrieval-store-fts-chunks-v1': [chunkRow],
    'retrieval-store-vector-chunks-generic-v1': [{ ...chunkRow, raw_score: '0.82' }],
    'retrieval-store-graph-signals-v1': [{ ...chunkRow, edge_type: 'calls', raw_score: 0.9 }],
  });
  const retrieval = store(database);
  const exact = await retrieval.exactSymbols({ query: 'Demo::Run', limit: 3 });
  const fts = await retrieval.ftsChunks({ query: 'run demo' });
  const vector = await retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [0, 0.5, -0.5], limit: 4 });
  const graph = await retrieval.graphSignals({ anchor_usr: 'c:@N@Demo@F@Start#', edge_types: ['calls'], direction: 'outgoing' });

  assert.deepEqual(exact[0], { signal: 'exact', candidate_type: 'chunk', symbol_id: symbolId,
    stable_usr: 'c:@N@Demo@F@Run#', qualified_name: 'Demo::Run', symbol_kind: 'function', chunk_id: chunkId,
    chunk_key: chunkKey, chunk_kind: 'definition', file_id: fileId, file_path: 'Source/Demo.cpp',
    text: 'void Demo::Run() {}', raw_score: 1, edge_type: null });
  assert.equal(fts[0].signal, 'fts');
  assert.equal(vector[0].signal, 'vector');
  assert.equal(graph[0].signal, 'graph');
  assert.equal(graph[0].edge_type, 'calls');
  assert.deepEqual(database.calls.map(({ statement }) => statement.name), [
    'retrieval-store-exact-symbols-v1', 'retrieval-store-fts-chunks-v1',
    'retrieval-store-vector-chunks-generic-v1', 'retrieval-store-graph-signals-v1',
  ]);
  for (const { statement, values } of database.calls) {
    assert.match(statement.text, /^WITH scope AS/);
    assert.match(statement.text, /project\.id = \$1::uuid AND generation\.id = \$2::uuid/);
    assert.match(statement.text, /generation\.status = 'active'/);
    assert.match(statement.text, /jsonb_to_recordset\(\$3::jsonb\)/);
    assert.match(statement.text, /repository\.project_id = \$1::uuid/);
    assert.match(statement.text, /starts_with\(/);
    assert.equal(values[0], projectId);
    assert.equal(values[1], generationId);
    assert.ok(!statement.text.includes('Demo::Run'));
    assert.ok(!statement.text.includes('approved'));
    assert.equal(values[2], JSON.stringify([{ repository_id: repositoryId, path_prefix: 'Source' }]));
  }
});

test('retrieval scope requires nonempty canonical path authorization and a fixed embedding profile', async () => {
  const database = new FakeDatabase();
  for (const authorized_paths of [
    [],
    [{ repository_id: repositoryId, path_prefix: '../Secret' }],
    [{ repository_id: repositoryId, path_prefix: 'Source' }, { repository_id: repositoryId, path_prefix: 'Source/' }],
  ]) assert.throws(() => store(database, { authorized_paths }),
    (error) => error instanceof RetrievalStoreError && error.code === 'invalid-request');
  assert.throws(
    () => store(database, { embedding_profile: undefined }).vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [0, 0, 0] }),
    (error) => error instanceof RetrievalStoreError && error.code === 'invalid-request',
  );
  assert.throws(
    () => store(database).vectorChunks({ provider_id: 'other', model: 'embed-v1', dimensions: 3, embedding: [0, 0, 0] }),
    (error) => error instanceof RetrievalStoreError && error.code === 'invalid-request',
  );
});

test('retrieval scope fails closed for inactive or mismatched project-generation binding', async () => {
  const inactive = new FakeDatabase({ 'retrieval-store-exact-symbols-v1': [] });
  await assert.rejects(store(inactive).exactSymbols({ query: 'Demo::Run' }),
    (error) => error instanceof RetrievalStoreError && error.code === 'scope-not-active');

  const wrongScope = new FakeDatabase({ 'retrieval-store-exact-symbols-v1': [{ ...symbolRow, scope_generation_id: '20000000-0000-4000-8000-000000000002' }] });
  await assert.rejects(store(wrongScope).exactSymbols({ query: 'Demo::Run' }),
    (error) => error instanceof RetrievalStoreError && error.code === 'result-invalid');
  assert.throws(() => createRetrievalStore(inactive, {
    project_id: 'not-a-uuid', generation_id: generationId,
    authorized_paths: [{ repository_id: repositoryId, path_prefix: 'Source' }], acl_context_hash: aclContextHash,
    embedding_profile: { provider_id: 'approved', model: 'embed-v1', dimensions: 3 },
  }),
    (error) => error instanceof RetrievalStoreError && error.code === 'invalid-request');
});

test('empty candidate sets retain an active-scope sentinel without leaking it', async () => {
  const result = await store().ftsChunks({ query: 'nothing-found' });
  assert.deepEqual(result, []);
});

test('file-context chunks may omit optional symbol metadata', async () => {
  const fileContext = { ...chunkRow, symbol_id: null, stable_usr: null, qualified_name: null,
    symbol_kind: null, chunk_kind: 'file_context', text: '#include "Demo.h"' };
  const database = new FakeDatabase({ 'retrieval-store-fts-chunks-v1': [fileContext] });
  const [candidate] = await store(database).ftsChunks({ query: 'Demo' });
  assert.equal(candidate.candidate_type, 'chunk');
  assert.equal(candidate.symbol_id, null);
  assert.equal(candidate.chunk_kind, 'file_context');
});

test('all query, limit, provider, vector and graph inputs are strictly bounded', async () => {
  const retrieval = store();
  const invalidCalls = [
    () => retrieval.exactSymbols({ query: '' }),
    () => retrieval.exactSymbols({ query: 'x'.repeat(4_097) }),
    () => retrieval.ftsChunks({ query: '\u0000bad' }),
    () => retrieval.ftsChunks({ query: 'valid', limit: 101 }),
    () => retrieval.vectorChunks({ provider_id: 'bad provider', model: 'm', dimensions: 1, embedding: [0] }),
    () => retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 2, embedding: [0] }),
    () => retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [Number.NaN, 0, 0] }),
    () => retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [1_000_001, 0, 0] }),
    () => retrieval.graphSignals({ anchor_usr: 'usr', edge_types: [] }),
    () => retrieval.graphSignals({ anchor_usr: 'usr', edge_types: ['calls', 'calls'] }),
    () => retrieval.graphSignals({ anchor_usr: 'usr', direction: 'sideways' }),
  ];
  for (const invoke of invalidCalls) {
    await assert.rejects(async () => invoke(),
      (error) => error instanceof RetrievalStoreError && error.code === 'invalid-request');
  }
});

test('vector and graph values are encoded internally and never alter SQL text', async () => {
  const database = new FakeDatabase({
    'retrieval-store-vector-chunks-generic-v1': [chunkRow],
    'retrieval-store-graph-signals-v1': [{ ...chunkRow, edge_type: 'inherits' }],
  });
  const retrieval = store(database);
  await retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [0.25, -0.75, 0] });
  await retrieval.graphSignals({ anchor_usr: 'anchor', edge_types: ['owns', 'inherits'] });
  assert.equal(database.calls[0].values[6], '[0.25,-0.75,0]');
  assert.equal(database.calls[1].values[4], '["inherits","owns"]');
  assert.ok(!database.calls[0].statement.text.includes('0.25'));
  assert.ok(!database.calls[1].statement.text.includes('inherits","owns'));
});

test('1536-dimensional vectors use the model-filtered partial ANN expression while other dimensions stay generic', async () => {
  const database = new FakeDatabase({ 'retrieval-store-vector-chunks-1536-v1': [chunkRow] });
  const retrieval = store(database, { embedding_profile: { provider_id: 'approved', model: 'embed-1536', dimensions: 1536 } });
  await retrieval.vectorChunks({ provider_id: 'approved', model: 'embed-1536', dimensions: 1536, embedding: Array(1536).fill(0) });
  assert.equal(database.calls[0].statement.name, 'retrieval-store-vector-chunks-1536-v1');
  assert.match(database.calls[0].statement.text, /embedding\.embedding::vector\(1536\) <=> \$7::vector\(1536\)/);
  assert.match(database.calls[0].statement.text, /embedding\.provider = \$4 AND embedding\.model = \$5/);
});

test('database failures and malformed rows are redacted', async () => {
  const failed = new FakeDatabase();
  failed.failure = new Error('password=private internal database detail');
  await assert.rejects(store(failed).exactSymbols({ query: 'Demo::Run' }),
    (error) => error instanceof RetrievalStoreError && error.code === 'database-failed'
      && !error.message.includes('private'));

  const malformed = new FakeDatabase({ 'retrieval-store-vector-chunks-generic-v1': [{ ...chunkRow, text: 'x'.repeat(256 * 1024 + 1) }] });
  await assert.rejects(store(malformed).vectorChunks({ provider_id: 'approved', model: 'embed-v1', dimensions: 3, embedding: [0, 0, 0] }),
    (error) => error instanceof RetrievalStoreError && error.code === 'result-invalid');
});
