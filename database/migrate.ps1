[CmdletBinding()]
param(
  [ValidateSet('up', 'down', 'status')]
  [string]$Action = 'up',
  [ValidateRange(0, 2147483647)]
  [int]$TargetVersion = 2147483647,
  [string]$PsqlPath = 'psql',
  [string]$DatabaseName = ''
)

$ErrorActionPreference = 'Stop'
$migrationRoot = Join-Path $PSScriptRoot 'migrations'
$manifestPath = Join-Path $migrationRoot 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$migrations = @($manifest.migrations | Sort-Object -Property version)

if ($DatabaseName -match '://') {
  throw 'DatabaseName must be a database name, not a connection URI. Use libpq PG* environment variables so credentials are not exposed in process arguments.'
}

$connectionArgs = @('-X', '-v', 'ON_ERROR_STOP=1')
if ($DatabaseName) {
  $connectionArgs += "--dbname=$DatabaseName"
}

function Invoke-Psql {
  param([string[]]$Arguments)

  & $PsqlPath @connectionArgs @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed with exit code $LASTEXITCODE"
  }
}

function Invoke-PsqlQuery {
  param([string]$Query)

  $lines = @(& $PsqlPath @connectionArgs '-A' '-t' '-q' '-c' $Query)
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed with exit code $LASTEXITCODE"
  }
  return @($lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-AppliedMigrations {
  $exists = Invoke-PsqlQuery "SELECT to_regclass('ue_mcp.schema_migrations') IS NOT NULL;"
  if ($exists.Count -eq 0 -or $exists[0] -ne 't') {
    return @()
  }

  return @(Invoke-PsqlQuery 'SELECT version::text || ''|'' || name || ''|'' || encode(checksum, ''hex'') FROM ue_mcp.schema_migrations ORDER BY version;')
}

function Assert-MigrationHistory {
  param([string[]]$Applied)

  for ($index = 0; $index -lt $Applied.Count; $index += 1) {
    if ($index -ge $migrations.Count) {
      throw "Database contains an unknown migration: $($Applied[$index])"
    }
    $parts = @($Applied[$index] -split '\|', 3)
    $expected = "$($migrations[$index].version)|$($migrations[$index].name)"
    if ($parts.Count -ne 3 -or "$($parts[0])|$($parts[1])" -ne $expected) {
      throw "Migration history is not a known contiguous prefix: expected '$expected', found '$($Applied[$index])'"
    }
    $upPath = Join-Path $migrationRoot $migrations[$index].up
    $expectedChecksum = (Get-FileHash -LiteralPath $upPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($parts[2] -ne $expectedChecksum) {
      throw "Applied migration $expected has checksum $($parts[2]), but the local file has $expectedChecksum"
    }
  }
}

$applied = @(Get-AppliedMigrations)
Assert-MigrationHistory $applied

if ($Action -eq 'status') {
  if ($applied.Count -eq 0) {
    Write-Output 'No ue_mcp migrations are applied.'
  } else {
    $applied | ForEach-Object { Write-Output "Applied $_" }
  }
  exit 0
}

$currentVersion = if ($applied.Count -eq 0) { 0 } else { [int](($applied[-1] -split '\|', 2)[0]) }

if ($Action -eq 'up') {
  if ($TargetVersion -lt $currentVersion) {
    throw "Up target $TargetVersion is older than current version $currentVersion; use -Action down"
  }
  $pending = @($migrations | Where-Object { $_.version -le $TargetVersion } | Select-Object -Skip $applied.Count)
  foreach ($migration in $pending) {
    $path = Join-Path $migrationRoot $migration.up
    $checksum = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Output "Applying $($migration.version)|$($migration.name)"
    Invoke-Psql @('-v', "migration_checksum=$checksum", '-f', $path)
  }
  if ($pending.Count -eq 0) {
    Write-Output 'Database is already at the requested version.'
  }
  exit 0
}

if ($TargetVersion -eq 2147483647) {
  $TargetVersion = [Math]::Max(0, $currentVersion - 1)
}
if ($TargetVersion -gt $currentVersion) {
  throw "Down target $TargetVersion is newer than current version $currentVersion"
}

$rollback = @($migrations | Where-Object { $_.version -gt $TargetVersion -and $_.version -le $currentVersion } | Sort-Object -Property version -Descending)
foreach ($migration in $rollback) {
  $path = Join-Path $migrationRoot $migration.down
  Write-Output "Rolling back $($migration.version)|$($migration.name)"
  Invoke-Psql @('-f', $path)
}
if ($rollback.Count -eq 0) {
  Write-Output 'Database is already at the requested version.'
}
