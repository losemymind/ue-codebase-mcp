import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  persistIndexedRelations,
  RelationPersistenceError,
} from '../../services/index-coordinator/src/relation-persistence.ts';

const generationId = '10000000-0000-4000-8000-000000000001';
const fileAId = '20000000-0000-4000-8000-000000000001';
const fileBId = '20000000-0000-4000-8000-000000000002';
const fileCId = '20000000-0000-4000-8000-000000000003';
const fileA = 'C:\\workspace\\Source\\A.cpp';
const fileB = 'C:\\workspace\\Source\\B.h';
const fileC = 'C:\\workspace\\Source\\Unused.h';
const revisionSetHash = createHash('sha256').update('revision').digest('hex');
const planHash = createHash('sha256').update('plan').digest('hex');
const ownerUsr = 'c:@S@Owner';
const runUsr = 'c:@S@Owner@F@Run#';
const helperUsr = 'c:@F@Helper#';

function relations(overrides = {}) {
  return {
    schema_version: 1,
    symbol_edges: [
      { edge_type: 'calls', src_usr: runUsr, dst_usr: helperUsr, file: fileA, line: 10, column: 3, confidence: 1 },
      { edge_type: 'calls', src_usr: runUsr, dst_usr: helperUsr, file: fileA, line: 10, column: 18, confidence: 0.5 },
      { edge_type: 'references', src_usr: runUsr, dst_usr: ownerUsr, file: fileA, line: 8, column: 5, confidence: 1 },
      { edge_type: 'owns', src_usr: ownerUsr, dst_usr: runUsr, confidence: 1 },
    ],
    file_edges: [
      { edge_type: 'include', src_file: fileA, dst_file: fileB, line: 1, column: 1 },
      { edge_type: 'include', src_file: fileA, dst_file: fileB, line: 2, column: 1 },
    ],
    source_symbol_edge_records: 4,
    source_file_edge_records: 2,
    deduplicated_symbol_edges: 0,
    deduplicated_file_edges: 0,
    unresolved_symbol_edges: 0,
    unresolved_owner_edges: 0,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    generation_id: generationId,
    revision_set_hash: revisionSetHash,
    plan_hash: planHash,
    relations: relations(),
    files: [{ id: fileAId, absolute_path: fileA }, { id: fileBId, absolute_path: fileB }],
    batch_size: 2,
    ...overrides,
  };
}

function uuid(index) {
  return `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

class FakeDatabase {
  constructor(options = {}) {
    this.state = {
      generation: {
        revision_set_hash: revisionSetHash,
        status: 'building',
        symbols_imported_at: options.symbolsImported === false ? null : '2026-08-31T00:00:00Z',
        relation_plan_hash: null,
        relation_payload_hash: null,
        symbol_edge_count: null,
        file_dependency_count: null,
        relations_imported_at: null,
      },
      knownFiles: new Set(options.knownFiles ?? [fileAId, fileBId]),
      knownSymbols: new Map(options.knownSymbols ?? [[ownerUsr, uuid(1)], [runUsr, uuid(2)], [helperUsr, uuid(3)]]),
      symbolEdges: [],
      fileDependencies: [],
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
        case 'relation-persistence-lock-generation-v1':
          return { rows: values[0] === generationId ? [{ ...draft.generation }] : [], row_count: values[0] === generationId ? 1 : 0 };
        case 'relation-persistence-count-existing-v1':
          return { rows: [{ symbol_edge_count: draft.symbolEdges.length, file_dependency_count: draft.fileDependencies.length }], row_count: 1 };
        case 'relation-persistence-validate-files-v1': {
          const rows = JSON.parse(values[1]).filter(({ id }) => draft.knownFiles.has(id)).map(({ id }) => ({ id }));
          return { rows, row_count: rows.length };
        }
        case 'relation-persistence-resolve-symbols-v1': {
          const rows = JSON.parse(values[1]).flatMap(({ stable_usr }) => {
            const id = draft.knownSymbols.get(stable_usr);
            return id === undefined ? [] : [{ stable_usr, id }];
          });
          return { rows, row_count: rows.length };
        }
        case 'relation-persistence-insert-symbol-edges-v1': {
          const rows = JSON.parse(values[1]);
          draft.symbolEdges.push(...rows);
          return { rows: [], row_count: this.shortWriteAt === statement.name ? Math.max(0, rows.length - 1) : rows.length };
        }
        case 'relation-persistence-insert-file-dependencies-v1': {
          const rows = JSON.parse(values[1]);
          draft.fileDependencies.push(...rows);
          return { rows: [], row_count: this.shortWriteAt === statement.name ? Math.max(0, rows.length - 1) : rows.length };
        }
        case 'relation-persistence-complete-v1':
          draft.generation.relation_plan_hash = values[1];
          draft.generation.relation_payload_hash = values[2];
          draft.generation.symbol_edge_count = values[3];
          draft.generation.file_dependency_count = values[4];
          draft.generation.relations_imported_at = '2026-08-31T01:00:00Z';
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

test('relation persistence atomically resolves generation symbols/files and records a deterministic fingerprint', async () => {
  const database = new FakeDatabase();
  const report = await persistIndexedRelations(database, request());
  assert.deepEqual({
    extractedSymbols: report.extracted_symbol_edge_record_count,
    acceptedSymbols: report.accepted_symbol_edge_count,
    symbols: report.symbol_edge_count,
    coalescedSymbols: report.coalesced_symbol_edge_count,
    extractedFiles: report.extracted_file_edge_record_count,
    acceptedFiles: report.accepted_file_edge_count,
    files: report.file_dependency_count,
    coalescedFiles: report.coalesced_file_edge_count,
    already: report.already_persisted,
  }, {
    extractedSymbols: 4, acceptedSymbols: 4, symbols: 3, coalescedSymbols: 1,
    extractedFiles: 2, acceptedFiles: 2, files: 1, coalescedFiles: 1, already: false,
  });
  assert.match(report.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(database.state.symbolEdges.length, 3);
  assert.equal(database.state.fileDependencies.length, 1);
  assert.equal(database.state.symbolEdges.find(({ edge_type }) => edge_type === 'calls').confidence, 1);
  assert.ok(database.statements.every(({ name, text }) => name.startsWith('relation-persistence-') && !text.includes(ownerUsr)));
  const dirtyCount = database.statements.find(({ name }) => name === 'relation-persistence-count-existing-v1').text;
  assert.match(dirtyCount, /edge\.edge_type IN \('calls', 'references', 'inherits', 'overrides', 'owns'\)/);
  assert.match(dirtyCount, /dependency\.edge_type = 'include'/);
  assert.doesNotMatch(database.statements.find(({ name }) => name === 'relation-persistence-complete-v1').text, /SET\s+status/i);

  const resumed = await persistIndexedRelations(database, request());
  assert.equal(resumed.already_persisted, true);
  assert.equal(database.state.symbolEdges.length, 3);
});

test('an empty accepted relation index is fingerprinted without requiring symbol or file lookups', async () => {
  const database = new FakeDatabase();
  const empty = relations({
    symbol_edges: [], file_edges: [], source_symbol_edge_records: 0, source_file_edge_records: 0,
  });
  const result = await persistIndexedRelations(database, request({ relations: empty, files: [] }));
  assert.equal(result.symbol_edge_count, 0);
  assert.equal(result.file_dependency_count, 0);
  assert.equal(database.statements.some(({ name }) => name === 'relation-persistence-resolve-symbols-v1'), false);
  assert.equal(database.statements.some(({ name }) => name === 'relation-persistence-validate-files-v1'), false);
  assert.ok(database.state.generation.relations_imported_at);
});

test('relation payload hashing is order-independent and completed imports reject plan or revision drift', async () => {
  const first = await persistIndexedRelations(new FakeDatabase(), request());
  const reordered = relations({
    symbol_edges: [...relations().symbol_edges].reverse(),
    file_edges: [...relations().file_edges].reverse(),
  });
  const second = await persistIndexedRelations(new FakeDatabase(), request({
    relations: reordered,
    files: [...request().files].reverse(),
  }));
  assert.equal(second.payload_hash, first.payload_hash);

  const provenanceDrift = await persistIndexedRelations(new FakeDatabase(), request({
    relations: relations({ unresolved_symbol_edges: 1 }),
  }));
  assert.notEqual(provenanceDrift.payload_hash, first.payload_hash);

  const completed = new FakeDatabase();
  await persistIndexedRelations(completed, request());
  await assert.rejects(persistIndexedRelations(completed, request({ plan_hash: '3'.repeat(64) })), { code: 'plan-conflict' });
  await assert.rejects(persistIndexedRelations(completed, request({
    relations: relations({ unresolved_symbol_edges: 1 }),
  })), { code: 'plan-conflict' });
  await assert.rejects(persistIndexedRelations(new FakeDatabase(), request({ revision_set_hash: '4'.repeat(64) })), { code: 'generation-mismatch' });
});

test('relation persistence fails closed for missing prerequisites, bindings, dirty state, and short writes', async () => {
  await assert.rejects(persistIndexedRelations(new FakeDatabase({ symbolsImported: false }), request()), { code: 'symbols-not-imported' });
  await assert.rejects(persistIndexedRelations(new FakeDatabase({ knownFiles: [fileAId] }), request()), { code: 'file-mismatch' });
  await assert.rejects(persistIndexedRelations(new FakeDatabase({ knownSymbols: [[ownerUsr, uuid(1)], [runUsr, uuid(2)]] }), request()), { code: 'symbol-mismatch' });
  const dirty = new FakeDatabase();
  dirty.state.symbolEdges.push({ private: 'existing-edge' });
  await assert.rejects(persistIndexedRelations(dirty, request()), { code: 'dirty-generation' });
  await assert.rejects(persistIndexedRelations(
    new FakeDatabase({ shortWriteAt: 'relation-persistence-insert-symbol-edges-v1' }), request(),
  ), { code: 'write-mismatch' });
});

test('relation persistence rolls back all writes and redacts adapter failures', async () => {
  const database = new FakeDatabase({ failAt: 'relation-persistence-insert-file-dependencies-v1' });
  await assert.rejects(persistIndexedRelations(database, request()), (error) => {
    assert.ok(error instanceof RelationPersistenceError);
    assert.equal(error.code, 'transaction-failed');
    assert.doesNotMatch(error.message, /private database detail/);
    return true;
  });
  assert.equal(database.state.symbolEdges.length, 0);
  assert.equal(database.state.fileDependencies.length, 0);
  database.failAt = undefined;
  assert.equal((await persistIndexedRelations(database, request())).already_persisted, false);
});

test('relation persistence rejects malformed or irrelevant payloads before opening a transaction', async () => {
  const database = new FakeDatabase();
  await assert.rejects(persistIndexedRelations(database, request({ generation_id: 'not-a-uuid' })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedRelations(database, request({
    files: [...request().files, { id: fileCId, absolute_path: fileC }],
  })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedRelations(database, request({
    relations: { ...relations(), extension: true },
  })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedRelations(database, request({
    relations: relations({ symbol_edges: [relations().symbol_edges[0], { ...relations().symbol_edges[0] }] }),
  })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedRelations(database, request({
    relations: relations({
      symbol_edges: [relations().symbol_edges[0], { ...relations().symbol_edges[0], confidence: 0.25 }],
    }),
  })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedRelations(database, request({
    relations: relations({ symbol_edges: [{ ...relations().symbol_edges[0], column: undefined }] }),
  })), { code: 'invalid-request' });
  assert.equal(database.statements.length, 0);
});
