import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile('deploy/windows-service/manage-agent-service.ps1', 'utf8');

test('Windows service management is fixed-name, hash-bound and path-confined', () => {
  assert.match(script, /ValidateSet\('Plan', 'Install', 'Update', 'Uninstall'\)/);
  assert.match(script, /\$expectedServiceName = 'UECodebaseMcpAgent'/);
  assert.match(script, /ExecutablePath and ConfigPath must remain below InstallRoot/);
  assert.match(script, /ExpectedExecutableSha256/);
  assert.match(script, /ExpectedConfigSha256/);
  assert.match(script, /Get-FileHash -LiteralPath \$resolvedExecutable -Algorithm SHA256/);
  assert.match(script, /Get-FileHash -LiteralPath \$resolvedConfig -Algorithm SHA256/);
  assert.match(script, /FileAttributes\]::ReparsePoint/);
});

test('Windows service identity and recovery policy expose no password or arbitrary service target', () => {
  assert.match(script, /NT SERVICE\\UECodebaseMcpAgent/);
  assert.match(script, /\[A-Za-z0-9_.-\]\{1,63\}\\\$/);
  assert.doesNotMatch(script, /\$(?:Credential|Password)\b|password=|binPath=.*\$args/u);
  assert.match(script, /actions= restart\/60000\/restart\/60000\/none\/0/);
  assert.match(script, /failureflag \$expectedServiceName 1/);
  assert.match(script, /sc\.exe create \$expectedServiceName/);
  assert.match(script, /sc\.exe config \$expectedServiceName/);
  assert.match(script, /sc\.exe delete \$expectedServiceName/);
});
