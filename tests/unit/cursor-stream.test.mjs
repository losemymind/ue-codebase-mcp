import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildCursorIndexerInvocation, parseCursorIndexerJsonLines } from '../../workers/clang-indexer/src/cursor-stream.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-symbols');
const source = path.join(workspace, 'SymbolGold.cpp');
const header = path.join(workspace, 'SymbolGold.h');

function symbol(overrides) {
  return {
    type: 'symbol', kind: 'method', usr: 'c:@N@Gold@S@UGoldActor@F@Overload#I#1', name: 'Overload',
    display_name: 'Overload(int)', qualified_name: 'Gold::UGoldActor::Overload', owner_usr: 'c:@N@Gold@S@UGoldActor',
    is_definition: false, file: header, start_line: 24, start_column: 3, end_line: 24, end_column: 32,
    type_spelling: 'int (int) const', result_type: 'int', documentation: '/// Returns the integer value unchanged.',
    ...overrides,
  };
}

test('cursor JSONL merges raw-USR declarations and definitions with exact ranges', () => {
  const lines = [
    { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 },
    symbol({}),
    symbol({ is_definition: true, file: source, start_line: 3, start_column: 1, end_line: 5, end_column: 2 }),
    symbol({ kind: 'field', usr: 'c:@N@Gold@S@UGoldActor@FI@Count', name: 'Count', display_name: 'Count', qualified_name: 'Gold::UGoldActor::Count', is_definition: true, file: header, start_line: 31, start_column: 3, end_line: 31, end_column: 16, type_spelling: 'int', result_type: '', documentation: null }),
  ];
  const result = parseCursorIndexerJsonLines(lines.map((value) => JSON.stringify(value)).join('\n'), [workspace]);
  assert.equal(result.error_count, 0);
  assert.equal(result.symbols.length, 2);
  const method = result.symbols.find(({ kind }) => kind === 'method');
  assert.equal(method.stable_usr, 'c:@N@Gold@S@UGoldActor@F@Overload#I#1');
  assert.equal(method.documentation, 'Returns the integer value unchanged.');
  assert.deepEqual(method.locations.map(({ kind, start_line, start_column, end_line, end_column }) => ({ kind, start_line, start_column, end_line, end_column })), [
    { kind: 'declaration', start_line: 24, start_column: 3, end_line: 24, end_column: 32 },
    { kind: 'definition', start_line: 3, start_column: 1, end_line: 5, end_column: 2 },
  ]);
  assert.match(result.symbols.find(({ kind }) => kind === 'field').stable_usr, /@FI@Count$/);
});

test('cursor JSONL rejects workspace escapes, unknown fields, and conflicting USR data', () => {
  const manifest = { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 };
  assert.throws(() => parseCursorIndexerJsonLines(`${JSON.stringify(manifest)}\n${JSON.stringify(symbol({ file: path.resolve('outside.cpp') }))}`, [workspace]));
  assert.throws(() => parseCursorIndexerJsonLines(`${JSON.stringify(manifest)}\n${JSON.stringify({ ...symbol({}), extra: true })}`, [workspace]));
  assert.throws(() => parseCursorIndexerJsonLines([manifest, symbol({}), symbol({ display_name: 'Conflicting()' })].map((value) => JSON.stringify(value)).join('\n'), [workspace]));
});

test('cursor JSONL validates but counts cursors that lack a usable identity', () => {
  const manifest = { type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 };
  const records = [
    manifest,
    symbol({ usr: null, name: '', display_name: '', qualified_name: '' }),
    symbol({ usr: 'c:anonymous', name: '', display_name: '', qualified_name: '' }),
  ];
  const result = parseCursorIndexerJsonLines(records.map((value) => JSON.stringify(value)).join('\n'), [workspace]);
  assert.equal(result.unidentified_count, 2);
  assert.equal(result.symbols.length, 0);
  assert.throws(() => parseCursorIndexerJsonLines([manifest, symbol({ usr: null, file: path.resolve('outside.cpp') })].map((value) => JSON.stringify(value)).join('\n'), [workspace]));
});

test('cursor invocation is typed, confined, and rejects plugin/output arguments', () => {
  const toolRoot = path.resolve('dist/native');
  const executable = path.join(toolRoot, 'clang-cursor-indexer.exe');
  const invocation = buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['-x', 'c++', '-std=c++20', '/FI', header] });
  assert.deepEqual(invocation.args.slice(0, 5), ['--source', source, '--workspace-root', workspace, '--']);
  assert.throws(() => buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['-fplugin=malicious.dll'] }));
  assert.throws(() => buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['-Xclang', '-load'] }));
  assert.throws(() => buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['-o', 'written.obj'] }));
  assert.throws(() => buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['/Fo', 'written.obj'] }));
  assert.throws(() => buildCursorIndexerInvocation({ executable, tool_root: toolRoot, workspace_root: workspace, source_file: source, compile_arguments: ['-fmodules-cache-path', 'cache'] }));
});
