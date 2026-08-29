import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const buildScript = await readFile(new URL('../../tools/build-clang-cursor-indexer.ps1', import.meta.url), 'utf8');
const nativeSource = await readFile(new URL('../../workers/clang-indexer/native/cursor-indexer.cpp', import.meta.url), 'utf8');

test('native cursor build is fixed, warning-clean, and repository-confined', () => {
  assert.match(buildScript, /Assert-Below \$repositoryRoot \$resolvedOutput/);
  assert.match(buildScript, /workers\\clang-indexer\\native\\cursor-indexer\.cpp/);
  assert.match(buildScript, /'\/W4' '\/WX'/);
  assert.match(buildScript, /SupportsShouldProcess/);
  assert.doesNotMatch(buildScript, /Invoke-Expression|Start-Process|cmd(?:\.exe)?\s+\/c/i);
});

test('native cursor boundary rejects executable clang extensions and write-producing options', () => {
  for (const token of ['-fplugin=', '-fpass-plugin=', '-fmodules-cache-path', '-fmodule-output', '/sourcedependencies', '/ifcoutput']) {
    assert.ok(nativeSource.toLowerCase().includes(token), `missing native rejection for ${token}`);
  }
  assert.match(nativeSource, /IsBelow\(options\.workspace_root, options\.source\)/);
  assert.match(nativeSource, /context\.overflow/);
  assert.doesNotMatch(nativeSource, /system\s*\(|CreateProcess|ShellExecute|WinExec/);
});
