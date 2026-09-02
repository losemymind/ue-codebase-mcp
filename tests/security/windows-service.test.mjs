import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile('deploy/windows-service/manage-agent-service.ps1', 'utf8');
assert.doesNotMatch(script, /Split-Path\s+-LiteralPath[^\r\n]*-Parent/);

test('Windows service management is fixed-name, hash-bound and path-confined', () => {
  assert.match(script, /ValidateSet\('Plan', 'Install', 'Update', 'Rollback', 'Uninstall'\)/);
  assert.match(script, /\$expectedServiceName = 'UECodebaseMcpAgent'/);
  assert.match(script, /\$Label must remain below InstallRoot/);
  assert.match(script, /ExpectedExecutableSha256/);
  assert.match(script, /ExpectedConfigSha256/);
  assert.match(script, /Get-FileHash -LiteralPath \$Executable -Algorithm SHA256/);
  assert.match(script, /Get-FileHash -LiteralPath \$Config -Algorithm SHA256/);
  assert.match(script, /FileAttributes\]::ReparsePoint/);
  assert.match(script, /Assert-PathHasNoReparsePoint/);
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

test('Windows service releases are signature-bound and readiness-verified', () => {
  assert.match(script, /ExpectedSignerThumbprint/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$Executable/);
  assert.match(script, /SignatureStatus\]::Valid/);
  assert.match(script, /ReadinessUri\.Scheme -ne 'https'/);
  assert.match(script, /AbsolutePath -ne '\/health\/ready'/);
  assert.match(script, /Invoke-WebRequest -Uri \$ReadinessUri -Method Get/);
  assert.match(script, /StatusCode -eq 200 -and \$response\.Content\.Trim\(\) -eq 'ready'/);
  assert.match(script, /WaitForStatus\(\[System\.ServiceProcess\.ServiceControllerStatus\]::Running/);
});

test('Windows service update and rollback require an approved previous release and protected evidence', () => {
  assert.match(script, /Update and Rollback require the complete approved previous-release path, hashes, and signer thumbprint/);
  assert.match(script, /Assert-ApprovedRelease -Executable \$resolvedPreviousExecutable/);
  assert.match(script, /Set-AgentServiceConfiguration -BinaryPath \$previousBinaryPath/);
  assert.match(script, /update_failed_rollback_ready/);
  assert.match(script, /update_failed_rollback_failed/);
  assert.match(script, /EvidenceDirectory must remain below InstallRoot/);
  assert.match(script, /EvidenceDirectory must not be a reparse point/);
  assert.match(script, /icacls\.exe \$resolvedEvidenceDirectory \/inheritance:r \/grant:r/);
  assert.match(script, /target_executable_sha256/);
  assert.doesNotMatch(script, /error_message|exception_message|config_content|token_value/);
});
