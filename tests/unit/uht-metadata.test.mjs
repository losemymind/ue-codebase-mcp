import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeClangDocYaml } from '../../workers/clang-indexer/src/symbol-model.ts';
import { attachUhtAnnotations, extractUhtAnnotations } from '../../workers/clang-indexer/src/uht-metadata.ts';

test('UHT annotations preserve specifiers, metadata, Blueprint exposure, names, and lines', async () => {
  const source = await readFile('packages/test-fixtures/cpp-symbols/SymbolGold.h', 'utf8');
  const annotations = extractUhtAnnotations(source);
  assert.equal(annotations.length, 4);
  assert.deepEqual(annotations.map(({ macro, symbol_name, blueprint_exposure }) => ({ macro, symbol_name, blueprint_exposure })), [
    { macro: 'UCLASS', symbol_name: 'UGoldActor', blueprint_exposure: 'type' },
    { macro: 'UFUNCTION', symbol_name: 'Overload', blueprint_exposure: 'callable' },
    { macro: 'UFUNCTION', symbol_name: 'Overload', blueprint_exposure: 'pure' },
    { macro: 'UPROPERTY', symbol_name: 'Count', blueprint_exposure: 'property' },
  ]);
  assert.deepEqual(annotations[0].specifiers, ['BlueprintType', 'DisplayName']);
  assert.deepEqual(annotations[0].metadata, { DisplayName: 'Gold Actor' });
  assert.deepEqual(annotations[1].metadata, { Category: 'Gold' });
  assert.deepEqual(annotations.map(({ declaration_line }) => declaration_line), [18, 24, 28, 31]);
});

test('UHT metadata attaches overloads by Clang declaration line and reports unresolved fields', async () => {
  const source = await readFile('packages/test-fixtures/cpp-symbols/SymbolGold.h', 'utf8');
  const yaml = await readFile('packages/test-fixtures/cpp-symbols/UGoldActor.yaml', 'utf8');
  const report = attachUhtAnnotations(normalizeClangDocYaml(yaml), extractUhtAnnotations(source));
  assert.equal(report.metadata.length, 3);
  assert.equal(report.ambiguous.length, 0);
  assert.deepEqual(report.metadata.map(({ blueprint_exposure }) => blueprint_exposure), ['type', 'callable', 'pure']);
  assert.equal(report.metadata[1].uht_metadata.Category, 'Gold');
  assert.equal(report.metadata[1].stable_usr, normalizeClangDocYaml(yaml)[1].stable_usr);
  assert.deepEqual(report.unmatched.map(({ symbol_name }) => symbol_name), ['Count']);
});

test('UHT scanner ignores comments and string literals and rejects malformed annotations', () => {
  assert.deepEqual(extractUhtAnnotations('// UFUNCTION(BlueprintCallable)\nconst char* Value = "UPROPERTY()";'), []);
  assert.throws(() => extractUhtAnnotations('UFUNCTION(BlueprintCallable\nint Broken();'));
  assert.throws(() => extractUhtAnnotations('UPROPERTY(meta=(Key="unterminated))\nint Value;'));
});
