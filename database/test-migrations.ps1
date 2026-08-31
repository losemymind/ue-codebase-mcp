[CmdletBinding()]
param(
  [string]$PsqlPath = 'psql',
  [string]$DatabaseName = $env:PGDATABASE
)

$ErrorActionPreference = 'Stop'
if (-not $DatabaseName -or $DatabaseName -notmatch '(^|_)test$') {
  throw 'Refusing destructive migration verification: PGDATABASE/DatabaseName must end in "test".'
}

$runner = Join-Path $PSScriptRoot 'migrate.ps1'
$constraintTest = Join-Path $PSScriptRoot 'tests\live-constraints.sql'

function Invoke-Runner {
  param([string]$Action, [int]$TargetVersion)

  & $runner -Action $Action -TargetVersion $TargetVersion -PsqlPath $PsqlPath -DatabaseName $DatabaseName
  if ($LASTEXITCODE -ne 0) {
    throw "Migration runner failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Query {
  param([string]$Query)

  $result = & $PsqlPath -X -v ON_ERROR_STOP=1 "--dbname=$DatabaseName" -A -t -q -c $Query
  if ($LASTEXITCODE -ne 0) {
    throw "psql query failed with exit code $LASTEXITCODE"
  }
  return "$result".Trim()
}

try {
  if ((Invoke-Query "SELECT to_regnamespace('ue_mcp') IS NOT NULL;") -eq 't') {
    Invoke-Runner 'down' 0
  }

  Invoke-Runner 'up' 1
  if ((Invoke-Query 'SELECT count(*) FROM ue_mcp.schema_migrations;') -ne '1') {
    throw 'Bootstrap migration did not produce version 1.'
  }

  Invoke-Runner 'up' 3
  & $PsqlPath -X -v ON_ERROR_STOP=1 "--dbname=$DatabaseName" -f $constraintTest
  if ($LASTEXITCODE -ne 0) {
    throw "Live constraint test failed with exit code $LASTEXITCODE"
  }

  Invoke-Runner 'down' 2
  if ((Invoke-Query "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'ue_mcp' AND table_name = 'index_generations' AND column_name = 'symbols_imported_at';") -ne '0') {
    throw 'P1-09 rollback left symbol import state behind.'
  }

  Invoke-Runner 'down' 1
  if ((Invoke-Query "SELECT to_regclass('ue_mcp.users') IS NULL;") -ne 't') {
    throw 'Core rollback left business tables behind.'
  }

  Invoke-Runner 'up' 3
  if ((Invoke-Query 'SELECT max(version) FROM ue_mcp.schema_migrations;') -ne '3') {
    throw 'Upgrade after rollback did not restore version 3.'
  }
} finally {
  if ((Invoke-Query "SELECT to_regnamespace('ue_mcp') IS NOT NULL;") -eq 't') {
    Invoke-Runner 'down' 0
  }
}

Write-Output 'Empty upgrade, prior-version upgrade, constraints, rollback, and re-upgrade passed.'
