import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { CursorIndexerError, runCursorIndexer } from '../../workers/clang-indexer/src/cursor-runner.ts';
import { buildCursorIndexerInvocation } from '../../workers/clang-indexer/src/cursor-stream.ts';

const workspace = path.resolve('packages/test-fixtures/cpp-symbols');
const invocation = buildCursorIndexerInvocation({
  executable: path.resolve('dist/native/clang-cursor-indexer.exe'),
  tool_root: path.resolve('dist/native'),
  workspace_root: workspace,
  source_file: path.join(workspace, 'SymbolGold.cpp'),
  compile_arguments: ['-x', 'c++', '-std=c++20'],
});
const manifest = JSON.stringify({ type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0 });

test('cursor runner passes only a bounded typed policy and parses successful output', async () => {
  let captured;
  const result = await runCursorIndexer(invocation, [workspace], { timeout_ms: 5_000, max_output_bytes: 4_096 }, async (received, policy) => {
    captured = { received, policy };
    return { exit_code: 0, stdout: manifest, stderr_bytes: 0 };
  });
  assert.equal(result.libclang, 'clang version 19.1.5');
  assert.equal(captured.received, invocation);
  assert.deepEqual(captured.policy, { timeout_ms: 5_000, max_output_bytes: 4_096 });
});

test('cursor runner classifies process failures without exposing stderr', async () => {
  for (const [field, code] of [['output_exceeded', 'output-limit'], ['timed_out', 'timeout'], ['aborted', 'aborted']]) {
    await assert.rejects(
      runCursorIndexer(invocation, [workspace], {}, async () => ({ exit_code: 2, stdout: '', stderr_bytes: 512, [field]: true })),
      (error) => error instanceof CursorIndexerError && error.code === code && !error.message.includes('512'),
    );
  }
  await assert.rejects(runCursorIndexer(invocation, [workspace], {}, async () => ({ exit_code: 2, stdout: '', stderr_bytes: 9 })), { code: 'nonzero-exit' });
  await assert.rejects(runCursorIndexer(invocation, [workspace], {}, async () => ({ exit_code: 0, stdout: 'not-json', stderr_bytes: 0 })), { code: 'invalid-output' });
});

test('cursor runner rejects diagnostic errors and invalid resource policy by default', async () => {
  const withError = JSON.stringify({ type: 'manifest', schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 1, error_count: 1 });
  await assert.rejects(runCursorIndexer(invocation, [workspace], {}, async () => ({ exit_code: 0, stdout: withError, stderr_bytes: 0 })), { code: 'diagnostic-errors' });
  assert.equal((await runCursorIndexer(invocation, [workspace], { max_error_diagnostics: 1 }, async () => ({ exit_code: 0, stdout: withError, stderr_bytes: 0 }))).error_count, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCursorIndexer(invocation, [workspace], { signal: controller.signal }, async () => ({ exit_code: 0, stdout: manifest, stderr_bytes: 0 })), { code: 'aborted' });
  await assert.rejects(runCursorIndexer(invocation, [workspace], { timeout_ms: 999 }, async () => ({ exit_code: 0, stdout: manifest, stderr_bytes: 0 })), TypeError);
  await assert.rejects(runCursorIndexer({ ...invocation, args: ['--source', 'bad'] }, [workspace], {}, async () => ({ exit_code: 0, stdout: manifest, stderr_bytes: 0 })), TypeError);
  await assert.rejects(runCursorIndexer({ ...invocation, args: [...invocation.args, '-fplugin=bad.dll'] }, [workspace], {}, async () => ({ exit_code: 0, stdout: manifest, stderr_bytes: 0 })), TypeError);
});
