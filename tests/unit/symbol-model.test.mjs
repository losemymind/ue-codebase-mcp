import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeClangDocYaml, parseClangDocYaml } from '../../workers/clang-indexer/src/symbol-model.ts';

test('clang-doc YAML preserves class, overload USRs, docs, ownership, and locations', async () => {
  const yaml = await readFile('packages/test-fixtures/cpp-symbols/UGoldActor.yaml', 'utf8');
  const symbols = normalizeClangDocYaml(yaml);
  assert.equal(symbols.length, 3);
  assert.equal(symbols[0].kind, 'class');
  assert.equal(symbols[0].qualified_name, 'Gold::UGoldActor');
  assert.equal(symbols[0].locations[0].line, 18);
  assert.deepEqual(symbols[0].member_hints, [{ name: 'Count', type: 'int', access: 'public' }]);
  assert.deepEqual(symbols.slice(1).map(({ qualified_name }) => qualified_name), ['Gold::UGoldActor::Overload', 'Gold::UGoldActor::Overload']);
  assert.notEqual(symbols[1].stable_usr, symbols[2].stable_usr);
  assert.notEqual(symbols[1].signature_hash, symbols[2].signature_hash);
  assert.equal(symbols[1].owner_usr, symbols[0].stable_usr);
  assert.equal(symbols[1].documentation, 'Returns the integer value unchanged.');
  assert.deepEqual(symbols[1].locations, [
    { kind: 'declaration', file: 'packages\\test-fixtures\\cpp-symbols\\SymbolGold.h', line: 24 },
    { kind: 'definition', file: 'packages\\test-fixtures\\cpp-symbols\\SymbolGold.cpp', line: 3 },
  ]);
});

test('clang-doc YAML parser rejects aliases, tabs, malformed IDs, and duplicate fields', () => {
  assert.throws(() => parseClangDocYaml('USR: &anchor value\n'));
  assert.throws(() => parseClangDocYaml('USR:\tvalue\n'));
  assert.throws(() => normalizeClangDocYaml("USR: 'short'\nName: 'Bad'\n"));
  assert.throws(() => parseClangDocYaml("USR: 'A'\nUSR: 'B'\n"));
});

test('clang-doc YAML preserves template parameters and documentation', async () => {
  const yaml = await readFile('packages/test-fixtures/cpp-symbols/Box.yaml', 'utf8');
  const [symbol] = normalizeClangDocYaml(yaml);
  assert.equal(symbol.qualified_name, 'Gold::Box');
  assert.deepEqual(symbol.template_parameters, ['typename T']);
  assert.equal(symbol.documentation, 'A documented template used to verify stable symbol identities.');
  assert.match(symbol.signature, /Gold::Box<typename T>/);
});
