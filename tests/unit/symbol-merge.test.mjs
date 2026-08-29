import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseCursorIndexerJsonLines } from '../../workers/clang-indexer/src/cursor-stream.ts';
import { normalizeClangDocYaml } from '../../workers/clang-indexer/src/symbol-model.ts';
import { mergeCursorSymbols } from '../../workers/clang-indexer/src/symbol-merge.ts';
import { extractUhtAnnotations } from '../../workers/clang-indexer/src/uht-metadata.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-symbols');
const header = path.join(workspace, 'SymbolGold.h');
const source = path.join(workspace, 'SymbolGold.cpp');

function record({ kind, usr, name, displayName, qualifiedName, owner = null, file = header, line, definition = true, type = '', result = '' }) {
  return {
    type: 'symbol', kind, usr, name, display_name: displayName, qualified_name: qualifiedName, owner_usr: owner,
    is_definition: definition, file, start_line: line, start_column: 1, end_line: line, end_column: 20,
    type_spelling: type, result_type: result, documentation: null,
  };
}

test('raw USRs merge exact locations, clang-doc templates/docs, overloads, fields, and UHT metadata', async () => {
  const owner = 'c:@N@Gold@S@UGoldActor';
  const records = [
    { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 },
    record({ kind: 'class', usr: 'c:@N@Gold@ST>1#T@Box', name: 'Box', displayName: 'Box<T>', qualifiedName: 'Gold::Box', line: 12, type: 'Gold::Box<T>' }),
    record({ kind: 'class', usr: owner, name: 'UGoldActor', displayName: 'UGoldActor', qualifiedName: 'Gold::UGoldActor', line: 18, type: 'Gold::UGoldActor' }),
    record({ kind: 'method', usr: 'c:@N@Gold@S@UGoldActor@F@Overload#I#1', name: 'Overload', displayName: 'Overload(int)', qualifiedName: 'Gold::UGoldActor::Overload', owner, line: 24, definition: false, type: 'int (int) const', result: 'int' }),
    record({ kind: 'method', usr: 'c:@N@Gold@S@UGoldActor@F@Overload#I#1', name: 'Overload', displayName: 'Overload(int)', qualifiedName: 'Gold::UGoldActor::Overload', owner, file: source, line: 3, type: 'int (int) const', result: 'int' }),
    record({ kind: 'method', usr: 'c:@N@Gold@S@UGoldActor@F@Overload#d#1', name: 'Overload', displayName: 'Overload(double)', qualifiedName: 'Gold::UGoldActor::Overload', owner, line: 28, definition: false, type: 'double (double) const', result: 'double' }),
    record({ kind: 'field', usr: 'c:@N@Gold@S@UGoldActor@FI@Count', name: 'Count', displayName: 'Count', qualifiedName: 'Gold::UGoldActor::Count', owner, line: 31, type: 'int' }),
  ];
  const cursorIndex = parseCursorIndexerJsonLines(records.map((value) => JSON.stringify(value)).join('\n'), [workspace]);
  const clangDocumentation = [
    ...normalizeClangDocYaml(await readFile('packages/test-fixtures/cpp-symbols/Box.yaml', 'utf8')),
    ...normalizeClangDocYaml(await readFile('packages/test-fixtures/cpp-symbols/UGoldActor.yaml', 'utf8')),
  ];
  const annotations = extractUhtAnnotations(await readFile('packages/test-fixtures/cpp-symbols/SymbolGold.h', 'utf8'));
  const report = mergeCursorSymbols(cursorIndex, clangDocumentation, annotations);
  assert.equal(report.symbols.length, 5);
  assert.equal(report.matched_clang_documentation, 4);
  assert.deepEqual(report.unmatched_clang_documentation_ids, []);
  assert.deepEqual(report.unmatched_uht_annotations, []);
  assert.deepEqual(report.ambiguous_uht_annotations, []);
  assert.deepEqual(report.symbols.find(({ qualified_name }) => qualified_name === 'Gold::Box').template_parameters, ['typename T']);
  assert.equal(report.symbols.find(({ qualified_name }) => qualified_name === 'Gold::Box').documentation, 'A documented template used to verify stable symbol identities.');
  const overloads = report.symbols.filter(({ qualified_name }) => qualified_name === 'Gold::UGoldActor::Overload');
  assert.equal(overloads.length, 2);
  assert.notEqual(overloads[0].stable_usr, overloads[1].stable_usr);
  assert.equal(overloads.find(({ result_type }) => result_type === 'int').locations.length, 2);
  assert.deepEqual(overloads.map(({ blueprint_exposure }) => blueprint_exposure).sort(), ['callable', 'pure']);
  const field = report.symbols.find(({ kind }) => kind === 'field');
  assert.match(field.stable_usr, /@FI@Count$/);
  assert.equal(field.blueprint_exposure, 'property');
  assert.equal(field.uht_metadata.Category, 'Gold');
});

test('merge fails closed when a raw USR maps to contradictory clang documentation', async () => {
  const cursorIndex = parseCursorIndexerJsonLines([
    { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 },
    record({ kind: 'struct', usr: 'c:@N@Gold@S@UGoldActor', name: 'UGoldActor', displayName: 'UGoldActor', qualifiedName: 'Gold::UGoldActor', line: 18 }),
  ].map((value) => JSON.stringify(value)).join('\n'), [workspace]);
  const clangDocumentation = normalizeClangDocYaml(await readFile('packages/test-fixtures/cpp-symbols/UGoldActor.yaml', 'utf8'));
  assert.throws(() => mergeCursorSymbols(cursorIndex, clangDocumentation, []), /disagree/);
});
