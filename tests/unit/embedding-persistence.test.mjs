import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createPersistentEmbeddingCache,
  persistChunkEmbeddings,
  EmbeddingPersistenceError,
} from '../../services/index-coordinator/src/embedding-persistence.ts';

const generationId = '10000000-0000-4000-8000-000000000001';
const projectId = '10000000-0000-4000-8000-000000000002';
const chunkAId = '20000000-0000-4000-8000-000000000001';
const chunkBId = '20000000-0000-4000-8000-000000000002';
const chunkA = createHash('sha256').update('chunk-a').digest('hex');
const chunkB = createHash('sha256').update('chunk-b').digest('hex');
const contentA = createHash('sha256').update('content-a').digest('hex');
const contentB = createHash('sha256').update('content-b').digest('hex');

function request(overrides = {}) {
  return {
    generation_id: generationId,
    provider_id: 'approved-provider',
    model: 'embedding-model',
    dimensions: 3,
    vectors: [
      { chunk_key: chunkA, content_hash: contentA, embedding: [0, 1, 2], cached: false },
      { chunk_key: chunkB, content_hash: contentB, embedding: [3, 4, 5], cached: true },
    ],
    batch_size: 1,
    ...overrides,
  };
}

class FakeDatabase {
  constructor(options = {}) {
    this.state = {
      generation: { status: options.status ?? 'building', chunks_imported_at: options.chunksImported === false ? null : '2026-08-31T00:00:00Z' },
      chunks: new Map(options.chunks ?? [
        [chunkA, { id: chunkAId, content_hash: contentA }],
        [chunkB, { id: chunkBId, content_hash: contentB }],
      ]),
      embeddings: [],
    };
    this.failAt = options.failAt;
    this.shortWrite = options.shortWrite ?? false;
  }

  run(state, statement, values) {
    if (this.failAt === statement.name) throw new Error('private database detail');
    switch (statement.name) {
      case 'embedding-persistence-read-cache-v1': {
        const row = state.embeddings.find((item) => values[0] === projectId && item.provider === values[1] && item.model === values[2]
          && item.dimensions === values[3] && item.content_hash === values[4]);
        return { rows: row === undefined ? [] : [{ embedding: JSON.stringify(row.embedding) }], row_count: row === undefined ? 0 : 1 };
      }
      case 'embedding-persistence-lock-generation-v1':
        return { rows: values[0] === generationId ? [{ ...state.generation }] : [], row_count: values[0] === generationId ? 1 : 0 };
      case 'embedding-persistence-resolve-chunks-v1': {
        const rows = JSON.parse(values[1]).flatMap(({ stable_key }) => {
          const chunk = state.chunks.get(stable_key);
          return chunk === undefined ? [] : [{ stable_key, content_hash: chunk.content_hash, id: chunk.id }];
        });
        return { rows, row_count: rows.length };
      }
      case 'embedding-persistence-load-existing-v1': {
        const ids = new Map([...state.chunks].map(([stable_key, chunk]) => [chunk.id, { stable_key, content_hash: chunk.content_hash }]));
        const rows = state.embeddings.filter((item) => item.provider === values[1] && item.model === values[2] && ids.has(item.chunk_id))
          .map((item) => ({ stable_key: ids.get(item.chunk_id).stable_key, content_hash: item.content_hash, dimensions: item.dimensions }));
        return { rows, row_count: rows.length };
      }
      case 'embedding-persistence-insert-v1': {
        const rows = JSON.parse(values[4]);
        state.embeddings.push(...rows.map((row) => ({
          ...row,
          provider: values[1],
          model: values[2],
          dimensions: values[3],
          embedding: JSON.parse(row.embedding),
        })));
        return { rows: [], row_count: this.shortWrite ? rows.length - 1 : rows.length };
      }
      default:
        throw new Error('unexpected statement');
    }
  }

  async execute(statement, values) {
    return this.run(this.state, statement, values);
  }

  async transaction(operation) {
    const draft = structuredClone(this.state);
    const result = await operation({ execute: async (statement, values) => this.run(draft, statement, values) });
    this.state = draft;
    return result;
  }
}

test('embedding persistence binds exact chunk content atomically and resumes without rewriting', async () => {
  const database = new FakeDatabase();
  const first = await persistChunkEmbeddings(database, request());
  assert.equal(first.embedding_count, 2);
  assert.equal(first.cached_input_count, 1);
  assert.equal(first.already_persisted, false);
  assert.equal(database.state.embeddings.length, 2);

  const resumed = await persistChunkEmbeddings(database, request());
  assert.equal(resumed.already_persisted, true);
  assert.equal(database.state.embeddings.length, 2);
});

test('persistent embedding cache reuses stored content across chunk and task boundaries', async () => {
  const database = new FakeDatabase();
  await persistChunkEmbeddings(database, request());
  const cache = createPersistentEmbeddingCache(database);
  const key = {
    project_id: projectId,
    provider_id: 'approved-provider',
    model: 'embedding-model',
    dimensions: 3,
    content_hash: contentA,
  };
  const keyed = { ...key, cache_key: createHash('sha256').update(JSON.stringify({ schema_version: 1, project_id: key.project_id, provider: key.provider_id, model: key.model, dimensions: key.dimensions, content_hash: key.content_hash })).digest('hex') };
  assert.deepEqual(await cache.get(keyed), [0, 1, 2]);
  database.state.embeddings = [];
  assert.deepEqual(await cache.get(keyed), [0, 1, 2]);
  const second = { ...key, content_hash: contentB };
  const secondKeyed = { ...second, cache_key: createHash('sha256').update(JSON.stringify({ schema_version: 1, project_id: second.project_id, provider: second.provider_id, model: second.model, dimensions: second.dimensions, content_hash: second.content_hash })).digest('hex') };
  await cache.set(secondKeyed, [6, 7, 8]);
  assert.deepEqual(await cache.get(secondKeyed), [6, 7, 8]);
});

test('embedding persistence rejects partial state and chunk-content drift', async () => {
  const partial = new FakeDatabase();
  partial.state.embeddings.push({ chunk_id: chunkAId, provider: 'approved-provider', model: 'embedding-model', dimensions: 3, content_hash: contentA, embedding: [0, 1, 2] });
  await assert.rejects(
    persistChunkEmbeddings(partial, request()),
    (error) => error instanceof EmbeddingPersistenceError && error.code === 'dirty-generation',
  );
  await assert.rejects(
    persistChunkEmbeddings(new FakeDatabase(), request({ vectors: [{ chunk_key: chunkA, content_hash: contentB, embedding: [0, 1, 2], cached: false }] })),
    (error) => error instanceof EmbeddingPersistenceError && error.code === 'chunk-mismatch',
  );
  await assert.rejects(
    persistChunkEmbeddings(new FakeDatabase({ chunksImported: false }), request()),
    (error) => error instanceof EmbeddingPersistenceError && error.code === 'chunks-not-imported',
  );
});

test('embedding persistence rolls back short writes and redacts database errors', async () => {
  const short = new FakeDatabase({ shortWrite: true });
  await assert.rejects(
    persistChunkEmbeddings(short, request()),
    (error) => error instanceof EmbeddingPersistenceError && error.code === 'write-mismatch',
  );
  assert.equal(short.state.embeddings.length, 0);
  const failed = new FakeDatabase({ failAt: 'embedding-persistence-insert-v1' });
  await assert.rejects(
    persistChunkEmbeddings(failed, request()),
    (error) => error instanceof EmbeddingPersistenceError && error.code === 'transaction-failed' && !error.message.includes('private database detail'),
  );
  assert.equal(failed.state.embeddings.length, 0);
});
