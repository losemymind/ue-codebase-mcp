import assert from 'node:assert/strict';
import test from 'node:test';
import { createAstAwareCodeChunks, estimateCodeTokens } from '../../workers/clang-indexer/src/code-chunking.ts';

const header = 'C:\\workspace\\Source\\Example.h';
const source = 'C:\\workspace\\Source\\Example.cpp';
const headerText = 'class Example {\npublic:\n  void Run();\n};\n';
const sourceText = 'void Example::Run() {\n  Work();\n}\n';

function symbol(overrides = {}) {
  return {
    stable_usr: 'c:@S@Example@F@Run#',
    qualified_name: 'Example::Run',
    name: 'Run',
    display_name: 'Run()',
    kind: 'method',
    owner_usr: 'c:@S@Example',
    type_spelling: 'void ()',
    result_type: 'void',
    documentation: 'Runs the example work.',
    signature_hash: 'a'.repeat(64),
    locations: [
      { kind: 'declaration', file: header, start_line: 3, start_column: 3, end_line: 3, end_column: 14 },
      { kind: 'definition', file: source, start_line: 1, start_column: 1, end_line: 3, end_column: 2 },
    ],
    template_parameters: [],
    uht_specifiers: [],
    uht_metadata: {},
    blueprint_exposure: 'none',
    ...overrides,
  };
}

test('AST-aware chunks associate declaration, definition, and documentation through one stable USR', () => {
  const report = createAstAwareCodeChunks(
    [symbol()],
    [{ absolute_path: source, text: sourceText }, { absolute_path: header, text: headerText }],
  );
  assert.equal(report.source_location_count, 2);
  assert.equal(report.missing_source_location_count, 0);
  assert.equal(report.empty_location_count, 0);
  assert.deepEqual(report.chunks.map(({ chunk_kind }) => chunk_kind).sort(), ['declaration', 'definition', 'documentation']);
  assert.ok(report.chunks.every(({ symbol_usr }) => symbol_usr === 'c:@S@Example@F@Run#'));
  assert.equal(report.chunks.find(({ chunk_kind }) => chunk_kind === 'declaration').text, 'void Run();');
  assert.equal(report.chunks.find(({ chunk_kind }) => chunk_kind === 'definition').text, sourceText.trim());
  assert.equal(report.chunks.find(({ chunk_kind }) => chunk_kind === 'documentation').text, 'Example::Run\nRuns the example work.');
  assert.ok(report.chunks.every(({ stable_key, content_hash, token_count }) => /^[a-f0-9]{64}$/.test(stable_key) && /^[a-f0-9]{64}$/.test(content_hash) && token_count > 0));
});

test('chunk identity and order are deterministic across source and symbol ordering', () => {
  const another = symbol({
    stable_usr: 'c:@S@Example',
    qualified_name: 'Example',
    name: 'Example',
    display_name: 'Example',
    kind: 'class',
    documentation: undefined,
    locations: [{ kind: 'declaration', file: header, start_line: 1, start_column: 1, end_line: 4, end_column: 3 }],
  });
  const left = createAstAwareCodeChunks([symbol(), another], [{ absolute_path: header, text: headerText }, { absolute_path: source, text: sourceText }]);
  const right = createAstAwareCodeChunks([another, symbol()], [{ absolute_path: source, text: sourceText }, { absolute_path: header, text: headerText }]);
  assert.deepEqual(left, right);
});

test('oversized source ranges split deterministically within byte and estimated-token budgets', () => {
  const longText = `${Array.from({ length: 600 }, (_, index) => `value_${index}`).join(' ')}\n`;
  const longFile = 'C:\\workspace\\Source\\Long.cpp';
  const report = createAstAwareCodeChunks([
    symbol({
      documentation: undefined,
      locations: [{ kind: 'definition', file: longFile, start_line: 1, start_column: 1, end_line: 1, end_column: longText.length }],
    }),
  ], [{ absolute_path: longFile, text: longText }], { max_chunk_utf8_bytes: 1024, max_estimated_tokens: 128 });
  assert.ok(report.chunks.length > 1);
  assert.equal(report.split_chunk_count, report.chunks.length);
  assert.ok(report.chunks.every((chunk) => Buffer.byteLength(chunk.text, 'utf8') <= 1024 && chunk.token_count <= 128));
  assert.deepEqual(report.chunks.map(({ part_index }) => part_index).sort((a, b) => a - b), Array.from({ length: report.chunks.length }, (_, index) => index));
});

test('missing and invalid source locations are reported without inventing chunks', () => {
  const report = createAstAwareCodeChunks([
    symbol({ locations: [
      { kind: 'declaration', file: 'C:\\workspace\\Source\\Missing.h', start_line: 1, start_column: 1, end_line: 1, end_column: 2 },
      { kind: 'definition', file: source, start_line: 99, start_column: 1, end_line: 99, end_column: 2 },
    ] }),
  ], [{ absolute_path: source, text: sourceText }]);
  assert.equal(report.missing_source_location_count, 1);
  assert.equal(report.empty_location_count, 1);
  assert.equal(report.chunks.length, 1);
  assert.equal(report.chunks[0].chunk_kind, 'documentation');
});

test('provider-neutral token estimation is deterministic for code and Unicode', () => {
  assert.equal(estimateCodeTokens(''), 0);
  assert.equal(estimateCodeTokens('void Run();'), 5);
  assert.equal(estimateCodeTokens('中文注释'), 4);
});
