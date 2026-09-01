[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ComposeFile,
  [Parameter(Mandatory = $true)]
  [string]$EnvironmentFile,
  [Parameter(Mandatory = $true)]
  [string]$CertificateFile,
  [Parameter(Mandatory = $true)]
  [string]$PrivateKeyFile,
  [Parameter(Mandatory = $true)]
  [ValidateCount(1, 32)]
  [string[]]$SecretFile
)

$ErrorActionPreference = 'Stop'
$digestPattern = '^.+:[^/@]+@sha256:[a-f0-9]{64}$'

function Resolve-DeploymentInput {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [ValidateRange(1, 16777216)]
    [long]$MaximumBytes = 1048576
  )

  if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Label must be a fully qualified path."
  }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "$Label does not identify an existing file."
  }
  $item = Get-Item -LiteralPath $resolved -Force
  $current = $item
  while ($null -ne $current) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label and its existing parent path must not contain a reparse point."
    }
    $parentPath = Split-Path -LiteralPath $current.FullName -Parent
    if ([string]::IsNullOrEmpty($parentPath) -or $parentPath -eq $current.FullName) { break }
    $current = Get-Item -LiteralPath $parentPath -Force
  }
  if ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes) {
    throw "$Label has an invalid size."
  }
  return $resolved
}

function Assert-CommandSucceeded {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

if ($null -eq (Get-Command -Name docker -CommandType Application -ErrorAction SilentlyContinue)) {
  throw 'Docker CLI is unavailable.'
}
& docker --version | Out-Null
Assert-CommandSucceeded -Description 'docker --version'
& docker compose version | Out-Null
Assert-CommandSucceeded -Description 'docker compose version'

$resolvedCompose = Resolve-DeploymentInput -Path $ComposeFile -Label 'ComposeFile' -MaximumBytes 4194304
$resolvedEnvironment = Resolve-DeploymentInput -Path $EnvironmentFile -Label 'EnvironmentFile' -MaximumBytes 1048576
$resolvedCertificate = Resolve-DeploymentInput -Path $CertificateFile -Label 'CertificateFile' -MaximumBytes 1048576
$resolvedPrivateKey = Resolve-DeploymentInput -Path $PrivateKeyFile -Label 'PrivateKeyFile' -MaximumBytes 1048576
$resolvedSecrets = @($SecretFile | ForEach-Object {
  Resolve-DeploymentInput -Path $_ -Label 'SecretFile' -MaximumBytes 1048576
})
if (($resolvedSecrets | Select-Object -Unique).Count -ne $resolvedSecrets.Count) {
  throw 'SecretFile entries must be unique.'
}

$environmentValues = @{}
foreach ($line in [System.IO.File]::ReadAllLines($resolvedEnvironment)) {
  $trimmed = $line.Trim()
  if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
  if ($trimmed -notmatch '^(?<name>[A-Z][A-Z0-9_]*)=(?<value>[^\r\n]+)$') {
    throw 'EnvironmentFile must use simple NAME=value entries.'
  }
  if ($environmentValues.ContainsKey($Matches.name)) {
    throw 'EnvironmentFile contains a duplicate variable.'
  }
  $environmentValues[$Matches.name] = $Matches.value.Trim()
}
$certificateBindings = @{
  EDGE_TLS_CERTIFICATE_FILE = $resolvedCertificate
  EDGE_TLS_PRIVATE_KEY_FILE = $resolvedPrivateKey
}
foreach ($binding in $certificateBindings.GetEnumerator()) {
  if (-not $environmentValues.ContainsKey($binding.Key)) { throw 'EnvironmentFile is missing a required TLS file binding.' }
  $boundPath = Resolve-DeploymentInput -Path $environmentValues[$binding.Key] -Label $binding.Key -MaximumBytes 1048576
  if (-not $boundPath.Equals($binding.Value, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'EnvironmentFile TLS bindings must match the separately approved certificate and key inputs.'
  }
}
$secretBindingNames = @(
  'CONTROL_PLANE_DATABASE_DSN_FILE',
  'METRICS_BEARER_TOKEN_FILE',
  'POSTGRES_PASSWORD_FILE',
  'GRAFANA_ADMIN_PASSWORD_FILE'
)
$boundSecrets = @($secretBindingNames | ForEach-Object {
  if (-not $environmentValues.ContainsKey($_)) { throw 'EnvironmentFile is missing a required secret-file binding.' }
  Resolve-DeploymentInput -Path $environmentValues[$_] -Label $_ -MaximumBytes 1048576
})
$approvedSecretSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$boundSecretSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($approvedSecret in $resolvedSecrets) { [void]$approvedSecretSet.Add($approvedSecret) }
foreach ($boundSecret in $boundSecrets) { [void]$boundSecretSet.Add($boundSecret) }
$unboundApprovedSecrets = @($approvedSecretSet | Where-Object { -not $boundSecretSet.Contains($_) })
if ($approvedSecretSet.Count -ne $boundSecretSet.Count -or $unboundApprovedSecrets.Count -ne 0) {
  throw 'EnvironmentFile secret bindings must exactly match the separately approved SecretFile inputs.'
}

$certificateText = [System.IO.File]::ReadAllText($resolvedCertificate)
if ($certificateText -notmatch '-----BEGIN CERTIFICATE-----') {
  throw 'CertificateFile must contain a PEM certificate.'
}
$privateKeyText = [System.IO.File]::ReadAllText($resolvedPrivateKey)
if ($privateKeyText -notmatch '-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----') {
  throw 'PrivateKeyFile must contain a PEM private key.'
}
$certificateText = $null
$privateKeyText = $null

$composeSource = [System.IO.File]::ReadAllText($resolvedCompose)
if ($composeSource -match '(?m)^\s*build\s*:') {
  throw 'ComposeFile must consume approved images and must not contain build directives.'
}
if ($composeSource -match '(?i):latest(?:@|\s|$)') {
  throw 'ComposeFile must not reference latest tags.'
}

& docker compose --env-file $resolvedEnvironment -f $resolvedCompose config --quiet
Assert-CommandSucceeded -Description 'docker compose config'
$images = @(& docker compose --env-file $resolvedEnvironment -f $resolvedCompose config --images)
Assert-CommandSucceeded -Description 'docker compose config --images'
if ($images.Count -lt 1) {
  throw 'Rendered Compose configuration contains no images.'
}
foreach ($image in $images) {
  $reference = $image.Trim()
  if (($reference -notmatch $digestPattern) -or ($reference -match '(?i):latest@') -or
      ($reference -match '(?i)^registry\.invalid/') -or $reference.EndsWith(('0' * 64))) {
    throw 'Every image must use an approved exact version tag and non-placeholder sha256 digest.'
  }
}

[pscustomobject]@{
  Status = 'Passed'
  ComposeFile = $resolvedCompose
  ImageCount = $images.Count
  SecretFileCount = $resolvedSecrets.Count
  MutatingAction = $false
}
