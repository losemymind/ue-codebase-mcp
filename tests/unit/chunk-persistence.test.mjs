import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { persistCodeChunks, ChunkPersistenceError } from '../../services/index-coordinator/src/chunk-persistence.ts';
import { createAstAwareCodeChunks } from '../../workers/clang-indexer/src/code-chunking.ts';

const generationId = '10000000-0000-4000-8000-000000000001';
const fileId = '20000000-0000-4000-8000-000000000001';
const symbolId = '30000000-0000-4000-8000-000000000001';
const file = 'C:\\workspace\\Source\\Example.cpp';
const usr = 'c:@F@Example#';
const revisionSetHash = createHash('sha256').update('revision').digest('hex');
const planHash = createHash('sha256').update('chunk-plan').digest('hex');

function chunks() {
  return createAstAwareCodeChunks([{
    stable_usr: usr,
    qualified_name: 'Example',
    name: 'Example',
    display_name: 'Example()',
    kind: 'function',
    type_spelling: 'void ()',
    result_type: 'void',
    documentation: 'Example documentation.',
    signature_hash: 'a'.repeat(64),
    locations: [{ kind: 'definition', file, start_line: 1, start_column: 1, end_line: 1, end_column: 18 }],
    template_parameters: [],
    uht_specifiers: [],
    uht_metadata: {},
    blueprint_exposure: 'none',
  }], [{ absolute_path: file, text: 'void Example() {}\n' }]).chunks;
}

function request(overrides = {}) {
  return {
    generation_id: generationId,
    revision_set_hash: revisionSetHash,
    plan_hash: planHash,
    chunks: chunks(),
    files: [{ id: fileId, absolute_path: file }],
    batch_size: 1,
    ...overrides,
  };
}

class FakeDatabase {
  constructor(options = {}) {
    this.state = {
      generation: {
        revision_set_hash: revisionSetHash,
        status: options.status ?? 'building',
        symbols_imported_at: options.symbolsImported === false ? null : '2026-08-31T00:00:00Z',
        chunk_plan_hash: null,
        chunk_payload_hash: null,
        code_chunk_count: null,
        chunks_imported_at: null,
      },
      files: new Set(options.files ?? [fileId]),
      symbols: new Map(options.symbols ?? [[usr, symbolId]]),
      chunks: [],
    };
    this.failAt = options.failAt;
    this.shortWriteAt = options.shortWriteAt;
    this.statements = [];
  }

  async transaction(operation) {
    const draft = structuredClone(this.state);
    const execute = async (statement, values) => {
      this.statements.push(statement);
      if (this.failAt === statement.name) throw new Error('private database detail');
      switch (statement.name) {
        case 'chunk-persistence-lock-generation-v1':
          return { rows: values[0] === generationId ? [{ ...draft.generation }] : [], row_count: values[0] === generationId ? 1 : 0 };
        case 'chunk-persistence-count-existing-v1':
          return { rows: [{ code_chunk_count: draft.chunks.length }], row_count: 1 };
        case 'chunk-persistence-validate-files-v1': {
          const rows = JSON.parse(values[1]).filter(({ id }) => draft.files.has(id)).map(({ id }) => ({ id }));
          return { rows, row_count: rows.length };
        }
        case 'chunk-persistence-resolve-symbols-v1': {
          const rows = JSON.parse(values[1]).flatMap(({ stable_usr }) => draft.symbols.has(stable_usr) ? [{ stable_usr, id: draft.symbols.get(stable_usr) }] : []);
          return { rows, row_count: rows.length };
        }
        case 'chunk-persistence-insert-chunks-v1': {
          const rows = JSON.parse(values[1]);
          draft.chunks.push(...rows);
          return { rows: [], row_count: this.shortWriteAt === statement.name ? rows.length - 1 : rows.length };
        }
        case 'chunk-persistence-complete-v1':
          draft.generation.chunk_plan_hash = values[1];
          draft.generation.chunk_payload_hash = values[2];
          draft.generation.code_chunk_count = values[3];
          draft.generation.chunks_imported_at = '2026-08-31T01:00:00Z';
          return { rows: [], row_count: this.shortWriteAt === statement.name ? 0 : 1 };
        default:
          throw new Error('unexpected statement');
      }
    };
    const result = await operation({ execute });
    this.state = draft;
    return result;
  }
}

test('chunk persistence atomically binds stable chunks to same-generation symbols and files', async () => {
  const database = new FakeDatabase();
  const first = await persistCodeChunks(database, request());
  assert.equal(first.code_chunk_count, 2);
  assert.equal(first.unique_content_count, 2);
  assert.equal(first.already_persisted, false);
  assert.equal(database.state.chunks.length, 2);
  assert.ok(database.state.chunks.every(({ symbol_id, file_id }) => symbol_id === symbolId && file_id === fileId));
  assert.ok(database.statements.every(({ name, text }) => name.startsWith('chunk-persistence-') && !text.includes(usr)));

  const resumed = await persistCodeChunks(database, request());
  assert.equal(resumed.already_persisted, true);
  assert.equal(database.state.chunks.length, 2);
});

test('chunk persistence rejects changed replays, dirty generations, and unresolved bindings', async () => {
  const completed = new FakeDatabase();
  await persistCodeChunks(completed, request());
  await assert.rejects(
    persistCodeChunks(completed, request({ plan_hash: 'b'.repeat(64) })),
    (error) => error instanceof ChunkPersistenceError && error.code === 'plan-conflict',
  );
  const dirty = new FakeDatabase();
  dirty.state.chunks.push({});
  await assert.rejects(persistCodeChunks(dirty, request()), (error) => error instanceof ChunkPersistenceError && error.code === 'dirty-generation');
  await assert.rejects(
    persistCodeChunks(new FakeDatabase({ files: [] }), request()),
    (error) => error instanceof ChunkPersistenceError && error.code === 'file-mismatch',
  );
  await assert.rejects(
    persistCodeChunks(new FakeDatabase({ symbols: [] }), request()),
    (error) => error instanceof ChunkPersistenceError && error.code === 'symbol-mismatch',
  );
});

test('chunk persistence rolls back short writes and redacts database failures', async () => {
  const short = new FakeDatabase({ shortWriteAt: 'chunk-persistence-insert-chunks-v1' });
  await assert.rejects(persistCodeChunks(short, request()), (error) => error instanceof ChunkPersistenceError && error.code === 'write-mismatch');
  assert.equal(short.state.chunks.length, 0);
  assert.equal(short.state.generation.chunks_imported_at, null);

  const failed = new FakeDatabase({ failAt: 'chunk-persistence-insert-chunks-v1' });
  await assert.rejects(
    persistCodeChunks(failed, request()),
    (error) => error instanceof ChunkPersistenceError && error.code === 'transaction-failed' && !error.message.includes('private database detail'),
  );
  assert.equal(failed.state.chunks.length, 0);
});

test('chunk persistence requires symbol import and validates content hashes before opening a transaction', async () => {
  await assert.rejects(
    persistCodeChunks(new FakeDatabase({ symbolsImported: false }), request()),
    (error) => error instanceof ChunkPersistenceError && error.code === 'symbols-not-imported',
  );
  const database = new FakeDatabase();
  const invalid = chunks().map((chunk, index) => index === 0 ? { ...chunk, content_hash: '0'.repeat(64) } : chunk);
  await assert.rejects(
    persistCodeChunks(database, request({ chunks: invalid })),
    (error) => error instanceof ChunkPersistenceError && error.code === 'invalid-request',
  );
  assert.equal(database.statements.length, 0);
});
