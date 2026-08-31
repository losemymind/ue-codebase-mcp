import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { compareSymbolGold, goldSuitePayloadSha256, parseSymbolGoldSuite } from '../../workers/clang-indexer/src/gold-comparison.ts';
import { parseCursorIndexerJsonLines } from '../../workers/clang-indexer/src/cursor-stream.ts';
import { normalizeClangDocYaml } from '../../workers/clang-indexer/src/symbol-model.ts';
import { mergeCursorSymbols } from '../../workers/clang-indexer/src/symbol-merge.ts';
import { extractUhtAnnotations } from '../../workers/clang-indexer/src/uht-metadata.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-symbols');
const header = path.join(workspace, 'SymbolGold.h');
const source = path.join(workspace, 'SymbolGold.cpp');
const goldPath = 'packages/test-fixtures/cpp-symbols/symbol-gold-v1.json';

function record({ kind, usr, name, displayName = name, qualifiedName = name, owner = null, file = header, startLine, startColumn, endLine, endColumn, definition = true, type = '', result = '', documentation = null }) {
  return {
    type: 'symbol', kind, usr, name, display_name: displayName, qualified_name: qualifiedName, owner_usr: owner,
    is_definition: definition, file, start_line: startLine, start_column: startColumn, end_line: endLine, end_column: endColumn,
    type_spelling: type, result_type: result, documentation,
  };
}

function nativeGoldRecords() {
  const namespace = 'c:@N@Gold';
  const box = 'c:@N@Gold@ST>1#T@Box';
  const actor = 'c:@N@Gold@S@UGoldActor';
  const integerOverload = `${actor}@F@Overload#I#1`;
  const doubleOverload = `${actor}@F@Overload#d#1`;
  return [
    { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 },
    record({ kind: 'macro', usr: 'c:SymbolGold.h@22@macro@UCLASS', name: 'UCLASS', startLine: 3, startColumn: 9, endLine: 3, endColumn: 20, definition: false }),
    record({ kind: 'macro', usr: 'c:SymbolGold.h@42@macro@UFUNCTION', name: 'UFUNCTION', startLine: 4, startColumn: 9, endLine: 4, endColumn: 23, definition: false }),
    record({ kind: 'macro', usr: 'c:SymbolGold.h@65@macro@UPROPERTY', name: 'UPROPERTY', startLine: 5, startColumn: 9, endLine: 5, endColumn: 23, definition: false }),
    record({ kind: 'macro', usr: 'c:SymbolGold.h@88@macro@GENERATED_BODY', name: 'GENERATED_BODY', startLine: 6, startColumn: 9, endLine: 6, endColumn: 25, definition: false }),
    record({ kind: 'namespace', usr: namespace, name: 'Gold', startLine: 8, startColumn: 1, endLine: 34, endColumn: 2 }),
    record({ kind: 'class', usr: box, name: 'Box', displayName: 'Box<T>', qualifiedName: 'Gold::Box', owner: namespace, startLine: 11, startColumn: 1, endLine: 15, endColumn: 2, documentation: '/// A documented template used to verify stable symbol identities.' }),
    record({ kind: 'field', usr: `${box}@FI@Value`, name: 'Value', qualifiedName: 'Gold::Box::Value', owner: box, startLine: 14, startColumn: 3, endLine: 14, endColumn: 12, type: 'T' }),
    record({ kind: 'class', usr: actor, name: 'UGoldActor', qualifiedName: 'Gold::UGoldActor', owner: namespace, startLine: 18, startColumn: 1, endLine: 32, endColumn: 2, type: 'Gold::UGoldActor' }),
    record({ kind: 'method', usr: integerOverload, name: 'Overload', displayName: 'Overload(int)', qualifiedName: 'Gold::UGoldActor::Overload', owner: actor, startLine: 24, startColumn: 3, endLine: 24, endColumn: 32, definition: false, type: 'int (int) const', result: 'int', documentation: '/// Returns the integer value unchanged.' }),
    record({ kind: 'parameter', usr: 'c:SymbolGold.h@464@N@Gold@S@UGoldActor@F@Overload#I#1@Value', name: 'Value', qualifiedName: 'Gold::UGoldActor::Overload::Value', owner: integerOverload, startLine: 24, startColumn: 16, endLine: 24, endColumn: 25, type: 'int' }),
    record({ kind: 'method', usr: doubleOverload, name: 'Overload', displayName: 'Overload(double)', qualifiedName: 'Gold::UGoldActor::Overload', owner: actor, startLine: 28, startColumn: 3, endLine: 28, endColumn: 38, definition: false, type: 'double (double) const', result: 'double', documentation: '/// Returns the floating-point value unchanged.' }),
    record({ kind: 'parameter', usr: 'c:SymbolGold.h@597@N@Gold@S@UGoldActor@F@Overload#d#1@Value', name: 'Value', qualifiedName: 'Gold::UGoldActor::Overload::Value', owner: doubleOverload, startLine: 28, startColumn: 19, endLine: 28, endColumn: 31, type: 'double' }),
    record({ kind: 'field', usr: `${actor}@FI@Count`, name: 'Count', qualifiedName: 'Gold::UGoldActor::Count', owner: actor, startLine: 31, startColumn: 3, endLine: 31, endColumn: 16, type: 'int' }),
    record({ kind: 'method', usr: integerOverload, name: 'Overload', displayName: 'Overload(int)', qualifiedName: 'Gold::UGoldActor::Overload', owner: actor, file: source, startLine: 3, startColumn: 1, endLine: 5, endColumn: 2, type: 'int (int) const', result: 'int', documentation: '/// Returns the integer value unchanged.' }),
    record({ kind: 'parameter', usr: 'c:SymbolGold.cpp@56@N@Gold@S@UGoldActor@F@Overload#I#1@Value', name: 'Value', qualifiedName: 'Gold::UGoldActor::Overload::Value', owner: integerOverload, file: source, startLine: 3, startColumn: 32, endLine: 3, endColumn: 41, type: 'int' }),
    record({ kind: 'method', usr: doubleOverload, name: 'Overload', displayName: 'Overload(double)', qualifiedName: 'Gold::UGoldActor::Overload', owner: actor, file: source, startLine: 7, startColumn: 1, endLine: 9, endColumn: 2, type: 'double (double) const', result: 'double', documentation: '/// Returns the floating-point value unchanged.' }),
    record({ kind: 'parameter', usr: 'c:SymbolGold.cpp@128@N@Gold@S@UGoldActor@F@Overload#d#1@Value', name: 'Value', qualifiedName: 'Gold::UGoldActor::Overload::Value', owner: doubleOverload, file: source, startLine: 7, startColumn: 35, endLine: 7, endColumn: 47, type: 'double' }),
  ];
}

async function mergedGoldSymbols() {
  const cursorIndex = parseCursorIndexerJsonLines(nativeGoldRecords().map((value) => JSON.stringify(value)).join('\n'), [workspace]);
  const clangDocumentation = [
    ...normalizeClangDocYaml(await readFile('packages/test-fixtures/cpp-symbols/Box.yaml', 'utf8')),
    ...normalizeClangDocYaml(await readFile('packages/test-fixtures/cpp-symbols/UGoldActor.yaml', 'utf8')),
  ];
  const annotations = extractUhtAnnotations(await readFile('packages/test-fixtures/cpp-symbols/SymbolGold.h', 'utf8'));
  const merged = mergeCursorSymbols(cursorIndex, clangDocumentation, annotations);
  assert.equal(merged.matched_clang_documentation, 4);
  assert.deepEqual(merged.unmatched_clang_documentation_ids, []);
  assert.deepEqual(merged.unmatched_uht_annotations, []);
  assert.deepEqual(merged.ambiguous_uht_annotations, []);
  return merged.symbols;
}

test('versioned symbol gold matches the native 19.1.5 capture but remains pending human review', async () => {
  const suite = parseSymbolGoldSuite(await readFile(goldPath, 'utf8'));
  const symbols = await mergedGoldSymbols();
  const report = compareSymbolGold(suite, symbols, workspace);
  assert.equal(symbols.length, 15);
  assert.equal(report.expected_symbol_count, 11);
  assert.equal(report.allowed_extra_symbol_count, 4);
  assert.equal(report.technical_pass, true);
  assert.equal(report.acceptance_pass, false);
  assert.equal(report.review_status, 'pending');
  assert.equal(report.review_valid, false);
  assert.match(report.suite_payload_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.mismatches, []);
});

test('gold approval is bound to the exact versioned expectation payload', async () => {
  const raw = JSON.parse(await readFile(goldPath, 'utf8'));
  const pending = parseSymbolGoldSuite(JSON.stringify(raw));
  raw.review = {
    status: 'approved',
    reviewer: 'Named UE Reviewer',
    approved_at: '2026-08-31T00:00:00Z',
    payload_sha256: goldSuitePayloadSha256(pending),
  };
  const suite = parseSymbolGoldSuite(JSON.stringify(raw));
  const symbols = await mergedGoldSymbols();
  assert.equal(compareSymbolGold(suite, symbols, workspace).acceptance_pass, true);
  raw.symbols[0].display_name = 'Changed after review';
  const stale = compareSymbolGold(parseSymbolGoldSuite(JSON.stringify(raw)), symbols, workspace);
  assert.equal(stale.technical_pass, false);
  assert.equal(stale.review_valid, false);
  assert.equal(stale.acceptance_pass, false);
});

test('gold comparison fails closed for missing, drifted, and non-allowlisted extra symbols without leaking identities', async () => {
  const suite = parseSymbolGoldSuite(await readFile(goldPath, 'utf8'));
  const symbols = await mergedGoldSymbols();
  const expected = symbols.find((item) => item.stable_usr === suite.symbols[0].stable_usr);
  const missing = symbols.filter((item) => item !== expected);
  const missingReport = compareSymbolGold(suite, missing, workspace);
  assert.equal(missingReport.technical_pass, false);
  assert.deepEqual(missingReport.mismatches, [{ code: 'missing-symbol', expectation_id: 'macro-uclass' }]);

  const drifted = symbols.map((item) => item === expected ? { ...item, display_name: 'drifted-private-value' } : item);
  const driftReport = compareSymbolGold(suite, drifted, workspace);
  assert.deepEqual(driftReport.mismatches, [{ code: 'field-mismatch', expectation_id: 'macro-uclass', field: 'display_name' }]);

  const extraUsr = 'private:unexpected:stable-identity';
  const unexpected = { ...symbols[0], stable_usr: extraUsr };
  const extraReport = compareSymbolGold(suite, [...symbols, unexpected], workspace);
  assert.equal(extraReport.technical_pass, false);
  assert.deepEqual(extraReport.mismatches.at(-1), { code: 'unexpected-symbol' });
  assert.equal(JSON.stringify(extraReport).includes(extraUsr), false);
});

test('gold parser rejects extensions, absolute paths, duplicate identities, and incomplete approvals', async () => {
  const raw = JSON.parse(await readFile(goldPath, 'utf8'));
  assert.throws(() => parseSymbolGoldSuite(JSON.stringify({ ...raw, extension: true })), /invalid/);
  const absolute = structuredClone(raw);
  absolute.symbols[0].locations[0].file = path.resolve('SymbolGold.h');
  assert.throws(() => parseSymbolGoldSuite(JSON.stringify(absolute)), /invalid/);
  const duplicate = structuredClone(raw);
  duplicate.symbols.push(structuredClone(duplicate.symbols[0]));
  assert.throws(() => parseSymbolGoldSuite(JSON.stringify(duplicate)), /invalid/);
  const approval = structuredClone(raw);
  approval.review = { status: 'approved', reviewer: null, approved_at: null, payload_sha256: null };
  assert.throws(() => parseSymbolGoldSuite(JSON.stringify(approval)), /invalid/);
});
