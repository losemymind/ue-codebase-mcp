import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { persistIndexedSymbols, SymbolPersistenceError } from '../../services/index-coordinator/src/symbol-persistence.ts';

const generationId = '10000000-0000-4000-8000-000000000001';
const fileAId = '20000000-0000-4000-8000-000000000001';
const fileBId = '20000000-0000-4000-8000-000000000002';
const revisionSetHash = '1'.repeat(64);
const planHash = '2'.repeat(64);
const fileA = path.resolve('packages/test-fixtures/cpp-symbols/SymbolGold.h');
const fileB = path.resolve('packages/test-fixtures/cpp-symbols/SymbolGold.cpp');

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function symbol(overrides = {}) {
  return {
    stable_usr: 'c:@S@Owner', qualified_name: 'Gold::Owner', name: 'Owner', display_name: 'Owner', kind: 'class',
    type_spelling: 'Gold::Owner', result_type: '', signature_hash: sha('owner'),
    locations: [{ kind: 'declaration', file: fileA, start_line: 1, start_column: 1, end_line: 2, end_column: 2 }],
    documentation: 'Owner documentation.', clang_documentation_id: 'A'.repeat(40), template_parameters: [],
    uht_specifiers: ['BlueprintType'], uht_metadata: { DisplayName: 'Owner' }, blueprint_exposure: 'type',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    generation_id: generationId,
    revision_set_hash: revisionSetHash,
    plan_hash: planHash,
    files: [{ id: fileAId, absolute_path: fileA }, { id: fileBId, absolute_path: fileB }],
    symbols: [
      symbol(),
      symbol({
        stable_usr: 'c:@S@Owner@F@Run#', qualified_name: 'Gold::Owner::Run', name: 'Run', display_name: 'Run()', kind: 'method',
        owner_usr: 'c:@S@Owner', type_spelling: 'void ()', result_type: 'void', signature_hash: sha('run'),
        locations: [{ kind: 'definition', file: fileB, start_line: 4, start_column: 1, end_line: 6, end_column: 2 }],
        documentation: undefined, clang_documentation_id: undefined, uht_specifiers: ['BlueprintCallable'],
        uht_metadata: {}, blueprint_exposure: 'callable',
      }),
      symbol({
        stable_usr: 'c:@F@Detached#', qualified_name: 'Gold::Detached', name: 'Detached', display_name: 'Detached()', kind: 'function',
        owner_usr: 'c:@N@Unavailable', type_spelling: 'int ()', result_type: 'int', signature_hash: sha('detached'),
        locations: [{ kind: 'definition', file: fileB, start_line: 8, start_column: 1, end_line: 9, end_column: 2 }],
        documentation: undefined, clang_documentation_id: undefined, uht_specifiers: [], uht_metadata: {}, blueprint_exposure: 'none',
      }),
    ],
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
        revision_set_hash: revisionSetHash, status: 'building', symbol_plan_hash: null, symbol_payload_hash: null,
        symbol_count: null, symbol_location_count: null, symbols_imported_at: null,
      },
      knownFiles: new Set(options.knownFiles ?? [fileAId, fileBId]),
      symbols: new Map(),
      locations: [],
      metadata: [],
      ownerWrites: [],
    };
    this.failAt = options.failAt;
    this.statements = [];
  }

  async transaction(operation) {
    const draft = structuredClone(this.state);
    const execute = async (statement, values) => {
      this.statements.push(statement);
      if (this.failAt === statement.name) throw new Error('private database detail');
      switch (statement.name) {
        case 'symbol-persistence-lock-generation-v1':
          return { rows: values[0] === generationId ? [{ ...draft.generation }] : [], row_count: values[0] === generationId ? 1 : 0 };
        case 'symbol-persistence-count-existing-v1':
          return { rows: [{ symbol_count: draft.symbols.size, location_count: draft.locations.length }], row_count: 1 };
        case 'symbol-persistence-validate-files-v1': {
          const rows = JSON.parse(values[1]).filter(({ id }) => draft.knownFiles.has(id)).map(({ id }) => ({ id }));
          return { rows, row_count: rows.length };
        }
        case 'symbol-persistence-insert-symbols-v1': {
          const rows = JSON.parse(values[1]).map((input) => {
            const id = uuid(draft.symbols.size + 1);
            draft.symbols.set(input.stable_usr, { id, ...input });
            return { stable_usr: input.stable_usr, id };
          });
          return { rows, row_count: rows.length };
        }
        case 'symbol-persistence-update-owners-v1': {
          const rows = JSON.parse(values[1]);
          draft.ownerWrites.push(...rows);
          return { rows: [], row_count: rows.length };
        }
        case 'symbol-persistence-insert-locations-v1': {
          const rows = JSON.parse(values[1]);
          draft.locations.push(...rows);
          return { rows: [], row_count: rows.length };
        }
        case 'symbol-persistence-insert-metadata-v1': {
          const rows = JSON.parse(values[1]);
          draft.metadata.push(...rows);
          return { rows: [], row_count: rows.length };
        }
        case 'symbol-persistence-complete-v1':
          draft.generation.symbol_plan_hash = values[1];
          draft.generation.symbol_payload_hash = values[2];
          draft.generation.symbol_count = values[3];
          draft.generation.symbol_location_count = values[4];
          draft.generation.symbols_imported_at = '2026-08-31T00:00:00Z';
          return { rows: [], row_count: 1 };
        default:
          throw new Error('unexpected statement');
      }
    };
    const result = await operation({ execute });
    this.state = draft;
    return result;
  }
}

test('symbol persistence atomically writes full symbols, owners, locations, metadata, and an import fingerprint', async () => {
  const database = new FakeDatabase();
  const report = await persistIndexedSymbols(database, request());
  assert.deepEqual({
    symbols: report.symbol_count, locations: report.location_count, unresolved: report.unresolved_owner_count,
    already: report.already_persisted,
  }, { symbols: 3, locations: 3, unresolved: 1, already: false });
  assert.match(report.payload_hash, /^[a-f0-9]{64}$/);
  assert.equal(database.state.symbols.size, 3);
  assert.equal(database.state.ownerWrites.length, 1);
  assert.equal(database.state.metadata.length, 3);
  const documented = database.state.metadata.find(({ documentation }) => documentation === 'Owner documentation.');
  assert.ok(documented);
  assert.deepEqual(documented.template_parameters, []);
  assert.equal(database.state.generation.symbol_plan_hash, planHash);
  assert.ok(database.statements.every(({ name, text }) => name.startsWith('symbol-persistence-') && !text.includes('Gold::')));

  const resumed = await persistIndexedSymbols(database, request());
  assert.equal(resumed.already_persisted, true);
  assert.equal(database.state.symbols.size, 3);
});

test('symbol persistence is order-independent and rejects plan, revision, file, and dirty-generation drift', async () => {
  const first = await persistIndexedSymbols(new FakeDatabase(), request());
  const second = await persistIndexedSymbols(new FakeDatabase(), request({ symbols: [...request().symbols].reverse(), files: [...request().files].reverse() }));
  assert.equal(second.payload_hash, first.payload_hash);

  const completed = new FakeDatabase();
  await persistIndexedSymbols(completed, request());
  await assert.rejects(persistIndexedSymbols(completed, request({ plan_hash: '3'.repeat(64) })), { code: 'plan-conflict' });
  await assert.rejects(persistIndexedSymbols(new FakeDatabase(), request({ revision_set_hash: '4'.repeat(64) })), { code: 'generation-mismatch' });
  await assert.rejects(persistIndexedSymbols(new FakeDatabase({ knownFiles: [fileAId] }), request()), { code: 'file-mismatch' });
  const dirty = new FakeDatabase();
  dirty.state.symbols.set('preexisting', { id: uuid(99) });
  await assert.rejects(persistIndexedSymbols(dirty, request()), { code: 'dirty-generation' });
});

test('symbol persistence rolls the whole import back and redacts adapter failures', async () => {
  const database = new FakeDatabase({ failAt: 'symbol-persistence-insert-metadata-v1' });
  await assert.rejects(persistIndexedSymbols(database, request()), (error) => {
    assert.ok(error instanceof SymbolPersistenceError);
    assert.equal(error.code, 'transaction-failed');
    assert.doesNotMatch(error.message, /private database detail/);
    return true;
  });
  assert.equal(database.state.symbols.size, 0);
  assert.equal(database.state.locations.length, 0);
  database.failAt = undefined;
  assert.equal((await persistIndexedSymbols(database, request())).already_persisted, false);
});

test('symbol persistence rejects malformed payloads before opening a transaction', async () => {
  const database = new FakeDatabase();
  await assert.rejects(persistIndexedSymbols(database, request({ generation_id: 'not-a-uuid' })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedSymbols(database, request({ files: [{ id: fileAId, absolute_path: fileA }] })), { code: 'invalid-request' });
  await assert.rejects(persistIndexedSymbols(database, request({
    symbols: [symbol({ stable_usr: 'duplicate' }), symbol({ stable_usr: 'duplicate' })],
  })), { code: 'invalid-request' });
  const duplicateLocation = symbol().locations[0];
  await assert.rejects(persistIndexedSymbols(database, request({
    symbols: [symbol({ locations: [duplicateLocation, { ...duplicateLocation }] })],
  })), { code: 'invalid-request' });
  assert.equal(database.statements.length, 0);
});
