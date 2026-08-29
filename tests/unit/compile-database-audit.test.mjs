import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditCompileDatabase } from '../../tools/audit-compile-database.mjs';

test('compile database audit reports unsupported drivers without weakening Clang normalization', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'ue-mcp-compile-audit-'));
  try {
    const clangSource = path.join(workspace, 'Source', 'Clang.cpp');
    const wrappedSource = path.join(workspace, 'Intermediate', 'Wrapped.cpp');
    const responsePath = path.join(workspace, 'clang.rsp');
    const databasePath = path.join(workspace, 'compile_commands.json');
    await writeFile(responsePath, `-DCLANG_ENTRY=1 "${clangSource}"`, 'utf8');
    await writeFile(databasePath, JSON.stringify([
      { directory: workspace, file: clangSource, arguments: [path.join(workspace, 'clang-cl.exe'), `@${responsePath}`] },
      { directory: workspace, file: wrappedSource, arguments: [path.join(workspace, 'cmd.exe'), '/C', 'wrapped.bat'] },
    ]), 'utf8');
    const report = await auditCompileDatabase(databasePath, [workspace]);
    assert.equal(report.raw_entries, 2);
    assert.equal(report.normalized_commands, 1);
    assert.equal(report.raw_unique_tus, 2);
    assert.equal(report.normalized_unique_tus, 1);
    assert.equal(report.normalization_coverage_percent, 50);
    assert.equal(report.meets_99_percent, false);
    assert.deepEqual(report.unsupported_driver_counts, { 'cmd.exe': 1 });
    assert.equal(report.unsupported_driver_samples[0].source, 'root-1/Intermediate/Wrapped.cpp');
    assert.deepEqual(report.compiler_drivers, ['clang-cl.exe']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
