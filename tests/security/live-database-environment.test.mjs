import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [manager, installer, uninstaller, psql, readme, packageText] = await Promise.all([
  readFile('tools/live-database/manage-environment.ps1', 'utf8'),
  readFile('tools/live-database/install.ps1', 'utf8'),
  readFile('tools/live-database/uninstall.ps1', 'utf8'),
  readFile('tools/live-database/docker-psql.ps1', 'utf8'),
  readFile('tools/live-database/README.md', 'utf8'),
  readFile('package.json', 'utf8'),
]);
const packageJson = JSON.parse(packageText);

test('environment manager detects exact dependencies and requires confirmation before installation', () => {
  assert.match(manager, /ValidateSet\('Status', 'Install', 'Verify', 'Backup', 'Uninstall'\)/);
  assert.match(manager, /OpenJS\.NodeJS\.LTS/);
  assert.match(manager, /24\.18\.0/);
  assert.match(manager, /Docker\.DockerDesktop/);
  assert.match(manager, /official-download fallback available/);
  assert.match(manager, /Test-WslReady/);
  assert.match(manager, /HypervisorPresent -eq \$true/);
  assert.match(manager, /VirtualizationFirmwareEnabled/);
  assert.match(manager, /Read-Host "\$Message Type YES to continue"/);
  assert.match(manager, /--accept-source-agreements --accept-package-agreements --disable-interactivity/);
  assert.match(manager, /Get-AuthenticodeSignature -LiteralPath \$installer/);
  assert.match(manager, /nodeInstallerSha256 = '[a-f0-9]{64}'/);
  assert.match(manager, /SupportsShouldProcess/);
  assert.match(manager, /function Test-DockerEngine[\s\S]*?catch \{ return \$false \}/u);
  assert.match(manager, /function Test-DockerImage/);
  assert.doesNotMatch(manager, /Split-Path\s+-LiteralPath[^\r\n]*-Parent/);
});

test('database provisioning is fixed, loopback-only, secret-file based and digest recorded', () => {
  assert.match(manager, /containerName = 'ue-codebase-mcp-postgres-test'/);
  assert.match(manager, /volumeName = 'ue-codebase-mcp-postgres-test-data'/);
  assert.match(manager, /databaseName = 'ue_codebase_mcp_test'/);
  assert.match(manager, /PgvectorImage = 'pgvector\/pgvector:0\.8\.6-pg17'/);
  assert.doesNotMatch(manager, /:latest/);
  assert.match(manager, /--publish "127\.0\.0\.1:\$\(\$State\.host_port\):5432"/);
  assert.match(manager, /POSTGRES_PASSWORD_FILE=\/run\/secrets\/postgres_password/);
  assert.match(manager, /target=\/workspace,readonly/);
  assert.match(manager, /Pulled pgvector image has no immutable repository digest/);
  assert.match(manager, /image_digest = \$imageDigest/);
  assert.match(manager, /Fixed-name Docker resources exist without a matching state file/);
  assert.match(manager, /immutableImage = "pgvector\/pgvector@\$\(\$State\.image_digest\)"/);
  assert.doesNotMatch(manager, /password\s*=\s*\$password[\s\S]*ConvertTo-Json/u);
});

test('verification uses the managed psql boundary and both real database harnesses', () => {
  assert.match(manager, /database\\test-migrations\.ps1/);
  assert.match(manager, /database\\migrate\.ps1/);
  assert.match(manager, /npm run control-plane:db:test:live/);
  assert.match(manager, /SELECT extversion FROM pg_extension WHERE extname = 'vector'/);
  assert.match(psql, /fixed managed test environment/);
  assert.match(psql, /psql "--username=\$databaseUser" @forward/);
  assert.match(psql, /only one bounded SELECT command is approved/);
  assert.match(psql, /outside the approved migration inputs/);
  assert.match(psql, /\/workspace\/\$relative/);
  assert.doesNotMatch(psql, /PGPASSWORD|postgresql:\/\//);
});

test('uninstall backs up and validates data before removing only fixed managed resources', () => {
  assert.match(manager, /pg_dump --username=\$databaseUser --dbname=\$databaseName --format=custom/);
  assert.match(manager, /\.dump\.partial/);
  assert.match(manager, /-cne 'PGDMP'/);
  assert.match(manager, /Get-FileHash -LiteralPath \$backup -Algorithm SHA256/);
  assert.match(manager, /Move-Item -LiteralPath \$partial -Destination \$backup/);
  assert.match(manager, /BackupDirectory must be outside StateRoot/);
  assert.match(manager, /Type '\$phrase' exactly to destroy the database volume/);
  assert.match(manager, /AcceptDataLoss is required with DiscardData/);
  assert.match(manager, /docker container rm --force \$containerName/);
  assert.match(manager, /docker volume rm \$volumeName/);
  assert.match(manager, /Assert-ManagedDockerObject -Kind container/);
  assert.match(manager, /Assert-ManagedDockerObject -Kind volume/);
  assert.match(manager, /not owned by this environment; refusing to use or remove it/);
  assert.doesNotMatch(manager, /Remove-Item[^\r\n]*-Recurse/);
});

test('shared dependency removal is opt-in and blocked when Docker contains unmanaged data', () => {
  assert.match(manager, /if \(-not \$RemoveManagedDependencies\) \{ return \}/);
  assert.match(manager, /docker_installed_by_tool/);
  assert.match(manager, /node_installed_by_tool/);
  assert.match(manager, /dependency-receipt\.json/);
  assert.match(manager, /Save-DependencyReceipt/);
  assert.match(manager, /Docker Desktop contains unmanaged containers, volumes, or images/);
  assert.match(manager, /Docker must be running to prove no unmanaged Docker data exists before uninstall/);
  assert.match(readme, /WSL is shared\s+Windows infrastructure and is never automatically uninstalled/);
  assert.match(installer, /-Action Install @PSBoundParameters/);
  assert.match(uninstaller, /-Action Uninstall @PSBoundParameters/);
});

test('package scripts expose status, install, verify, backup and uninstall entrypoints', () => {
  for (const action of ['status', 'install', 'verify', 'backup', 'uninstall']) {
    assert.match(packageJson.scripts[`env:db:${action}`], /tools\/live-database\/manage-environment\.ps1/);
  }
});
