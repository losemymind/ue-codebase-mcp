import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { selectCompileDatabaseSample, validateRuntimeManifest } from '../../tools/benchmark-clang-cursor-sample.mjs';

const engine = path.resolve('database/.test-data/benchmark-engine');
const project = path.resolve('database/.test-data/benchmark-project');

function entry(root, name, compiler = 'clang-cl.exe') {
  const file = path.join(root, 'Source', `${name}.cpp`);
  return { directory: root, file, arguments: [path.join(root, 'Toolchain', compiler), file] };
}

test('cursor benchmark selection is deterministic, root-balanced, Clang-only, and variant-deduplicated', () => {
  const database = JSON.stringify([
    entry(engine, 'A'), entry(engine, 'B'), entry(engine, 'C'), entry(engine, 'A'), entry(engine, 'Ignored', 'cl.exe'),
    entry(project, 'A'), entry(project, 'B'), entry(project, 'C'), entry(project, 'Ignored', 'cmd.exe'),
  ]);
  const first = selectCompileDatabaseSample(database, [engine, project], 2);
  const second = selectCompileDatabaseSample(database, [engine, project], 2);
  assert.deepEqual(second, first);
  assert.equal(first.length, 4);
  assert.equal(first.filter(({ file }) => file.startsWith(engine)).length, 2);
  assert.equal(first.filter(({ file }) => file.startsWith(project)).length, 2);
  assert.equal(new Set(first.map(({ file }) => file.toLowerCase())).size, 4);
  assert.ok(first.every(({ arguments: compileArguments }) => path.basename(compileArguments[0]) === 'clang-cl.exe'));
});

test('cursor benchmark selection fails closed on missing roots, malformed entries, and excessive samples', () => {
  assert.throws(() => selectCompileDatabaseSample(JSON.stringify([entry(engine, 'Only'), entry(project, 'Only')]), [engine, project], 2), /insufficient/);
  assert.throws(() => selectCompileDatabaseSample(JSON.stringify([{ directory: engine, file: 'bad.txt', arguments: ['clang-cl.exe'] }]), [engine, project], 1), /source is invalid/);
  assert.throws(() => selectCompileDatabaseSample('[]', [engine, project], 17), /selection input is invalid/);
});

test('cursor benchmark independently verifies the complete runtime artifact manifest', () => {
  const files = [
    'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt', 'clang-cursor-indexer.exe', 'libclang.dll', 'sbom.cdx.json',
  ].map((name, index) => ({ path: name, size: index + 1, sha256: createHash('sha256').update(name).digest('hex') }));
  const artifactHash = createHash('sha256').update(JSON.stringify({ schema_version: 1, files })).digest('hex');
  const manifest = { schema_version: 1, component: { name: 'libclang' }, source_date_epoch: '0', artifact_hash: artifactHash, files };
  assert.deepEqual(validateRuntimeManifest(manifest), files);
  assert.throws(() => validateRuntimeManifest({ ...manifest, artifact_hash: '0'.repeat(64) }), /artifact hash/);
  assert.throws(() => validateRuntimeManifest({ ...manifest, files: [...files].reverse() }), /manifest files/);
});
