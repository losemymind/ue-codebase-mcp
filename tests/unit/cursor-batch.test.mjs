import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { normalizeCompileDatabase } from '../../workers/clang-indexer/src/compile-database.ts';
import { createCursorCompileArguments, CursorBatchError, mergeCursorIndexResults, runCursorBatch } from '../../workers/clang-indexer/src/cursor-batch.ts';
import { CursorIndexerError } from '../../workers/clang-indexer/src/cursor-runner.ts';

const workspace = path.resolve('database/.test-data/cursor-batch-workspace');
const stateRoot = path.resolve('database/.test-data/cursor-batch-state');
const checkpointDirectory = path.join(stateRoot, 'job-1');
const toolRoot = path.join(workspace, 'tools');
const executable = path.join(toolRoot, 'clang-cursor-indexer.exe');
const sourceA = path.join(workspace, 'A.cpp');
const sourceB = path.join(workspace, 'B.cpp');
const sourceC = path.join(workspace, 'C.cpp');

function commands() {
  return normalizeCompileDatabase(JSON.stringify([sourceA, sourceB, sourceC].map((file) => ({
    directory: workspace,
    file,
    arguments: [path.join(workspace, 'clang-cl.exe'), '-std=c++20', file],
  }))), [workspace]);
}

function symbol(file, extra = {}) {
  return {
    stable_usr: 'c:@F@Shared#', qualified_name: 'Shared', name: 'Shared', display_name: 'Shared()', kind: 'function',
    type_spelling: 'void ()', result_type: 'void', signature_hash: 'a'.repeat(64),
    locations: [{ kind: file === sourceA ? 'declaration' : 'definition', file, start_line: 1, start_column: 1, end_line: 1, end_column: 12 }],
    ...extra,
  };
}

function result(file) {
  return { schema_version: 1, libclang: 'clang version 19.1.5', diagnostic_count: 0, error_count: 0, unidentified_count: 0, symbols: [symbol(file)] };
}

function relationResult(file, confidence = 1) {
  return {
    ...result(file),
    relation_shard: {
      schema_version: 1,
      symbol_edges: [{
        edge_type: 'calls', src_usr: 'c:@F@Shared#', dst_usr: 'c:@F@Target#',
        file: sourceA, line: 3, column: 5, confidence,
      }],
      file_edges: [{ edge_type: 'include', src_file: sourceA, dst_file: sourceB, line: 1, column: 1 }],
    },
  };
}

function request(overrides = {}) {
  return {
    batch_id: 'gold-batch', revision_set_hash: '1'.repeat(64), tool_artifact_hash: '2'.repeat(64),
    state_root: stateRoot, checkpoint_directory: checkpointDirectory, executable, tool_root: toolRoot,
    workspace_roots: [workspace], commands: commands(), batch_size: 2, concurrency: 2, max_attempts: 2,
    execution_policy: { timeout_ms: 5_000, max_output_bytes: 4_096 }, ...overrides,
  };
}

async function resetFixture() {
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true });
}

test('cursor batch checkpoints bounded work and resumes without repeating successful actions', async () => {
  await resetFixture();
  const calls = [];
  const first = await runCursorBatch(request(), async (invocation) => {
    calls.push(invocation.args[1]);
    return result(invocation.args[1]);
  });
  assert.equal(first.completed_actions, 3);
  assert.equal(first.checkpoint_count, 2);
  assert.equal(first.symbols.length, 1);
  assert.equal(first.symbols[0].locations.length, 3);
  assert.equal(first.deduplicated_symbol_records, 2);
  assert.equal(calls.length, 3);
  const argumentFiles = await readdir(path.join(stateRoot, 'arguments'));
  assert.equal(argumentFiles.length, 1);
  assert.equal((await readFile(path.join(stateRoot, 'arguments', argumentFiles[0]), 'utf8')).includes('-std=c++20'), true);
  const resumed = await runCursorBatch(request(), async () => { throw new Error('completed action was repeated'); });
  assert.deepEqual(resumed, first);
  assert.equal(JSON.parse(await readFile(path.join(checkpointDirectory, 'checkpoint-000000.json'), 'utf8')).schema_version, 1);
});

test('UE MSVC cursor argument profile retains preprocessing under a fixed reviewed language baseline', () => {
  const command = {
    ...commands()[0],
    arguments: ['--target=x86_64-pc-windows-msvc', '-Z7', '-fms-compatibility-version=19.38', '-msse4.2', '-mno-constructor-aliases', sourceA],
    include_paths: [path.join(workspace, 'include')],
    forced_includes: [path.join(workspace, 'SharedPCH.h')],
    definitions: ['UE_BUILD=1'],
  };
  assert.deepEqual(createCursorCompileArguments(command, 'ue-msvc-cxx20'), [
    '-x', 'c++', '-std=c++20', '-fms-extensions', '-fms-compatibility',
    '-I', path.join(workspace, 'include'), '-include', path.join(workspace, 'SharedPCH.h'), '-D', 'UE_BUILD=1',
  ]);
});

test('cursor batch retries only classified transient failures and checkpoints only complete batches', async () => {
  await resetFixture();
  const attempts = new Map();
  const report = await runCursorBatch(request({ batch_size: 1, concurrency: 1 }), async (invocation) => {
    const count = (attempts.get(invocation.args[1]) ?? 0) + 1;
    attempts.set(invocation.args[1], count);
    if (invocation.args[1] === sourceB && count === 1) throw new CursorIndexerError('timeout');
    return result(invocation.args[1]);
  });
  assert.equal(report.attempt_count, 4);
  assert.equal(attempts.get(sourceB), 2);

  await resetFixture();
  await assert.rejects(runCursorBatch(request(), async (invocation) => {
    if (invocation.args[1] === sourceB) throw new CursorIndexerError('invalid-output');
    return result(invocation.args[1]);
  }), { code: 'action-failed', cause_code: 'invalid-output' });
  assert.deepEqual(await readFile(path.join(checkpointDirectory, 'checkpoint-000000.json'), 'utf8').catch(() => undefined), undefined);
});

test('cursor batch fails closed on plan drift and checkpoint tampering, and drops ambiguous cross-TU USRs', async () => {
  await resetFixture();
  await runCursorBatch(request(), async (invocation) => result(invocation.args[1]));
  await assert.rejects(runCursorBatch(request({ revision_set_hash: '3'.repeat(64) }), async () => result(sourceA)), { code: 'plan-mismatch' });
  await assert.rejects(runCursorBatch(request({ execution_policy: { timeout_ms: 5_000, max_output_bytes: 4_096, max_error_diagnostics: 1 } }), async () => result(sourceA)), { code: 'plan-mismatch' });

  const checkpoint = path.join(checkpointDirectory, 'checkpoint-000000.json');
  const tampered = JSON.parse(await readFile(checkpoint, 'utf8'));
  tampered.payload.attempt_count += 1;
  await writeFile(checkpoint, `${JSON.stringify(tampered)}\n`, 'utf8');
  await assert.rejects(runCursorBatch(request(), async () => result(sourceA)), { code: 'invalid-checkpoint' });

  const ambiguous = mergeCursorIndexResults([
    result(sourceA),
    { ...result(sourceB), symbols: [symbol(sourceB, { qualified_name: 'Conflicting' })] },
  ]);
  assert.equal(ambiguous.symbols.length, 0);
  assert.equal(ambiguous.unidentified_count, 2);
});

test('cursor batch checkpoints relation shards, deduplicates across TUs, and rejects mixed or partial relation state', async () => {
  await resetFixture();
  const confidenceBySource = new Map([[sourceA, 0.4], [sourceB, 1], [sourceC, 0.8]]);
  const report = await runCursorBatch(request(), async (invocation) => relationResult(
    invocation.args[1], confidenceBySource.get(invocation.args[1]),
  ));
  assert.equal(report.source_symbol_edge_records, 3);
  assert.equal(report.source_file_edge_records, 3);
  assert.equal(report.deduplicated_symbol_edges, 2);
  assert.equal(report.deduplicated_file_edges, 2);
  assert.equal(report.relation_shard.symbol_edges.length, 1);
  assert.equal(report.relation_shard.symbol_edges[0].confidence, 1);
  assert.equal(report.relation_shard.file_edges.length, 1);

  const resumed = await runCursorBatch(request(), async () => { throw new Error('completed relation action was repeated'); });
  assert.deepEqual(resumed, report);
  assert.throws(() => mergeCursorIndexResults([result(sourceA), relationResult(sourceB)], [workspace]), { code: 'symbol-conflict' });

  const checkpointPath = path.join(checkpointDirectory, 'checkpoint-000000.json');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  delete checkpoint.payload.source_file_edge_records;
  checkpoint.payload_sha256 = createHash('sha256').update(JSON.stringify(checkpoint.payload)).digest('hex');
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`, 'utf8');
  await assert.rejects(runCursorBatch(request(), async () => relationResult(sourceA)), { code: 'invalid-checkpoint' });
});

test('cursor batch never executes the compile database compiler and rejects forged normalized actions', async () => {
  await resetFixture();
  const observed = [];
  await runCursorBatch(request(), async (invocation) => {
    observed.push(invocation);
    return result(invocation.args[1]);
  });
  assert.ok(observed.every((invocation) => invocation.executable === executable && !invocation.args.includes(path.join(workspace, 'clang-cl.exe'))));
  const forged = [...commands()];
  forged[0] = { ...forged[0], arguments: [...forged[0].arguments, '-fplugin=malicious.dll'] };
  await assert.rejects(runCursorBatch(request({ commands: forged }), async () => result(sourceA)), { code: 'invalid-plan' });
  await assert.rejects(runCursorBatch(request({ checkpoint_directory: path.resolve('database/.test-data/escape') }), async () => result(sourceA)), { code: 'invalid-plan' });
});
