import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('source-tree compile database generator guards and restores InstalledBuild semantics', async () => {
  const source = await readFile('tools/generate-ue-compile-database.ps1', 'utf8');
  assert.match(source, /SupportsShouldProcess\s*=\s*\$true/);
  assert.match(source, /\[switch\]\$TemporarilyDisableInstalledBuild/);
  assert.match(source, /Move-Item -LiteralPath \$marker -Destination \$backup/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /Move-Item -LiteralPath \$backup -Destination \$marker/);
  assert.match(source, /Get-FileHash -LiteralPath \$marker -Algorithm SHA256/g);
  assert.match(source, /'-Mode=GenerateClangDatabase'/);
  assert.match(source, /'-NoExecCodeGenActions'/);
  assert.doesNotMatch(source, /\[string\]\$(?:Command|Arguments|Executable)\b/i);
  assert.doesNotMatch(source, /Invoke-Expression|Start-Process/);
  assert.doesNotMatch(source, /IsPathFullyQualified|GetRelativePath/);
});
