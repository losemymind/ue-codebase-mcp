[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PsqlArgument
)

$ErrorActionPreference = 'Stop'
$container = $env:UE_MCP_TEST_POSTGRES_CONTAINER
$database = $env:UE_MCP_TEST_POSTGRES_DATABASE
$databaseUser = 'ue_mcp_test'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Test-FullyQualifiedPath {
  param([string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

if ($container -cne 'ue-codebase-mcp-postgres-test' -or $database -cne 'ue_codebase_mcp_test') {
  throw 'Docker psql adapter requires the fixed managed test environment.'
}
if ($null -eq (Get-Command -Name docker -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'Docker CLI is unavailable.'
}
if ($PsqlArgument.Count -lt 4 -or $PsqlArgument.Count -gt 20) { throw 'psql argument list is invalid.' }

$forward = [System.Collections.Generic.List[string]]::new()
$hasDatabase = $false
$hasStop = $false
$inputKind = $null
$index = 0
while ($index -lt $PsqlArgument.Count) {
  $argument = $PsqlArgument[$index]
  if ($argument -in @('-X', '-A', '-t', '-q')) {
    $forward.Add($argument)
    $index += 1
    continue
  }
  if ($argument -eq "--dbname=$database") {
    if ($hasDatabase) { throw 'duplicate database argument' }
    $hasDatabase = $true
    $forward.Add($argument)
    $index += 1
    continue
  }
  if ($argument -eq '-v') {
    if ($index + 1 -ge $PsqlArgument.Count) { throw 'missing psql variable' }
    $variable = $PsqlArgument[$index + 1]
    if ($variable -ne 'ON_ERROR_STOP=1' -and $variable -notmatch '^migration_checksum=[a-f0-9]{64}$') {
      throw 'psql variable is not approved'
    }
    if ($variable -eq 'ON_ERROR_STOP=1') { $hasStop = $true }
    $forward.Add('-v')
    $forward.Add($variable)
    $index += 2
    continue
  }
  if ($argument -eq '-c') {
    if ($null -ne $inputKind -or $index + 1 -ge $PsqlArgument.Count) { throw 'psql command input is invalid' }
    $query = $PsqlArgument[$index + 1]
    if (($query.Length -lt 8) -or ($query.Length -gt 8192) -or ($query -notmatch '^SELECT\s') -or
        ($query.TrimEnd().TrimEnd(';') -match ';')) {
      throw 'only one bounded SELECT command is approved'
    }
    $inputKind = 'command'
    $forward.Add('-c')
    $forward.Add($query)
    $index += 2
    continue
  }
  if ($argument -eq '-f') {
    if ($null -ne $inputKind -or $index + 1 -ge $PsqlArgument.Count) { throw 'psql file input is invalid' }
    $file = $PsqlArgument[$index + 1]
    if (-not (Test-FullyQualifiedPath -Path $file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw 'psql file must be an existing fully qualified path'
    }
    $resolved = [System.IO.Path]::GetFullPath($file)
    $migrationRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'database\migrations')).TrimEnd('\') + '\'
    $constraintFile = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'database\tests\live-constraints.sql'))
    if ((-not $resolved.StartsWith($migrationRoot, [System.StringComparison]::OrdinalIgnoreCase)) -and
        (-not $resolved.Equals($constraintFile, [System.StringComparison]::OrdinalIgnoreCase))) {
      throw 'psql file is outside the approved migration inputs'
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -lt 1 -or $item.Length -gt 4MB) {
      throw 'psql file is unsafe'
    }
    $relative = $resolved.Substring($repositoryRoot.TrimEnd('\').Length + 1).Replace('\', '/')
    $inputKind = 'file'
    $forward.Add('-f')
    $forward.Add("/workspace/$relative")
    $index += 2
    continue
  }
  throw 'psql argument is not approved'
}

if (-not $hasDatabase -or -not $hasStop -or $null -eq $inputKind) { throw 'required psql safety arguments are missing' }
& docker exec $container psql "--username=$databaseUser" @forward
exit $LASTEXITCODE
