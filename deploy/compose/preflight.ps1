[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ComposeFile,
  [Parameter(Mandatory = $true)]
  [string]$EnvironmentFile,
  [Parameter(Mandatory = $true)]
  [string]$ControlPlaneApprovalFile,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$ExpectedControlPlaneApprovalSha256,
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
    $parentPath = Split-Path -LiteralPath $current.FullName
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

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Object,
    [Parameter(Mandatory = $true)]
    [string[]]$Expected,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $actual = @($Object.PSObject.Properties.Name)
  $expectedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $actualSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($name in $Expected) { [void]$expectedSet.Add($name) }
  foreach ($name in $actual) { [void]$actualSet.Add($name) }
  $missing = @($expectedSet | Where-Object { -not $actualSet.Contains($_) })
  $unexpected = @($actualSet | Where-Object { -not $expectedSet.Contains($_) })
  if ($actual.Count -ne $Expected.Count -or $missing.Count -ne 0 -or $unexpected.Count -ne 0) {
    throw "$Label must contain exactly the approved fields."
  }
}

function Assert-ArtifactHash {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSha256,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $ExpectedSha256 -eq ('0' * 64)) {
    throw "$Label must have a non-placeholder lowercase SHA-256 value."
  }
  $actualSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if (-not $actualSha256.Equals($ExpectedSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label hash did not match the control-plane approval."
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
$resolvedControlPlaneApproval = Resolve-DeploymentInput -Path $ControlPlaneApprovalFile -Label 'ControlPlaneApprovalFile' -MaximumBytes 65536
$resolvedCertificate = Resolve-DeploymentInput -Path $CertificateFile -Label 'CertificateFile' -MaximumBytes 1048576
$resolvedPrivateKey = Resolve-DeploymentInput -Path $PrivateKeyFile -Label 'PrivateKeyFile' -MaximumBytes 1048576
$resolvedSecrets = @($SecretFile | ForEach-Object {
  Resolve-DeploymentInput -Path $_ -Label 'SecretFile' -MaximumBytes 1048576
})
if (($resolvedSecrets | Select-Object -Unique).Count -ne $resolvedSecrets.Count) {
  throw 'SecretFile entries must be unique.'
}

if ($ExpectedControlPlaneApprovalSha256 -eq ('0' * 64)) {
  throw 'ExpectedControlPlaneApprovalSha256 must not be a placeholder.'
}
$actualApprovalSha256 = (Get-FileHash -LiteralPath $resolvedControlPlaneApproval -Algorithm SHA256).Hash
if (-not $actualApprovalSha256.Equals($ExpectedControlPlaneApprovalSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'ControlPlaneApprovalFile hash did not match the independently approved value.'
}
$approvalText = [System.IO.File]::ReadAllText($resolvedControlPlaneApproval)
$approvalPropertyNames = @([regex]::Matches($approvalText, '"(?<name>[A-Za-z][A-Za-z0-9_]*)"\s*:') |
  ForEach-Object { $_.Groups['name'].Value })
if (($approvalPropertyNames | Select-Object -Unique).Count -ne $approvalPropertyNames.Count) {
  throw 'ControlPlaneApprovalFile must not contain duplicate property names.'
}
try {
  $approval = $approvalText | ConvertFrom-Json
} catch {
  throw 'ControlPlaneApprovalFile must contain valid JSON.'
}
$approvalText = $null
$approvalFields = @(
  'schema',
  'version',
  'status',
  'governance_mode',
  'assurance_level',
  'technical_owner',
  'approval_id',
  'approved_by',
  'risk_acceptance_id',
  'approved_at',
  'expires_at',
  'image_reference',
  'source_revision',
  'node_version',
  'public_listener_port',
  'operations_listener_port',
  'sbom_path',
  'sbom_sha256',
  'provenance_path',
  'provenance_sha256',
  'capabilities'
)
Assert-ExactProperties -Object $approval -Expected $approvalFields -Label 'ControlPlaneApprovalFile'
$approvalStringFields = @(
  'schema',
  'status',
  'governance_mode',
  'assurance_level',
  'technical_owner',
  'approval_id',
  'approved_by',
  'risk_acceptance_id',
  'approved_at',
  'expires_at',
  'image_reference',
  'source_revision',
  'node_version',
  'sbom_path',
  'sbom_sha256',
  'provenance_path',
  'provenance_sha256'
)
foreach ($field in $approvalStringFields) {
  if ($approval.PSObject.Properties[$field].Value -isnot [string]) {
    throw 'ControlPlaneApprovalFile fields have invalid types.'
  }
}
if (($approval.version -isnot [long]) -or ($approval.public_listener_port -isnot [long]) -or
    ($approval.operations_listener_port -isnot [long]) -or
    ($approval.capabilities -isnot [System.Management.Automation.PSCustomObject])) {
  throw 'ControlPlaneApprovalFile fields have invalid types.'
}
if (($approval.schema -ne 'ue-codebase-mcp/control-plane-image-approval') -or
    ($approval.version -ne 1) -or ($approval.status -ne 'approved')) {
  throw 'ControlPlaneApprovalFile is not an approved version-1 control-plane record.'
}
$principalPattern = '^[a-z][a-z0-9_-]{1,31}:[^\s\x00-\x1f\x7f]{1,224}$'
if (($approval.approval_id -notmatch '^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$') -or
    ($approval.approval_id -match '(?i)pending|placeholder') -or
    ($approval.technical_owner -notmatch $principalPattern) -or
    ($approval.technical_owner -match '(?i)unconfigured|pending|placeholder') -or
    ($approval.approved_by -notmatch $principalPattern) -or
    ($approval.approved_by -match '(?i)unconfigured|pending|placeholder') -or
    ($approval.risk_acceptance_id -notmatch '^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$')) {
  throw 'Control-plane approval identity fields are missing or placeholders.'
}
if ($approval.governance_mode -eq 'solo') {
  if (($approval.assurance_level -ne 'self_attested') -or
      ($approval.risk_acceptance_id -eq 'NOT_APPLICABLE')) {
    throw 'Solo governance must remain self-attested with an explicit risk acceptance.'
  }
} elseif ($approval.governance_mode -eq 'team') {
  if (($approval.assurance_level -ne 'independently_approved') -or
      ($approval.risk_acceptance_id -ne 'NOT_APPLICABLE') -or
      ($approval.technical_owner -ceq $approval.approved_by)) {
    throw 'Team governance must use a distinct independent approver.'
  }
} else {
  throw 'Control-plane approval governance mode is invalid.'
}
$datePattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
if ($approval.approved_at -notmatch $datePattern -or $approval.expires_at -notmatch $datePattern) {
  throw 'Control-plane approval timestamps must be explicit UTC date-times.'
}
try {
  $approvedAt = [DateTimeOffset]::Parse($approval.approved_at, [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
  $expiresAt = [DateTimeOffset]::Parse($approval.expires_at, [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
} catch {
  throw 'Control-plane approval timestamps are invalid.'
}
$now = [DateTimeOffset]::UtcNow
if ($approvedAt -gt $now.AddMinutes(5) -or $expiresAt -le $now -or $expiresAt -le $approvedAt) {
  throw 'Control-plane approval is not currently valid.'
}
if (($approval.image_reference -notmatch $digestPattern) -or
    ($approval.image_reference -match '(?i):latest@|^registry\.invalid/') -or
    $approval.image_reference.EndsWith(('0' * 64))) {
  throw 'Control-plane approval must bind a non-placeholder exact-version image digest.'
}
if (($approval.source_revision -notmatch '^[a-f0-9]{40}$') -or
    ($approval.source_revision -eq ('0' * 40)) -or ($approval.node_version -ne '24.18.0') -or
    ($approval.public_listener_port -ne 8080) -or ($approval.operations_listener_port -ne 8081)) {
  throw 'Control-plane approval does not match the Phase 1 runtime contract.'
}
$capabilityFields = @(
  'database_pool',
  'database_migrations',
  'fresh_acl_scope',
  'retrieval_backend',
  'generation_store',
  'audit_sink',
  'object_store',
  'authenticated_mcp_listener',
  'protected_operations_listener',
  'approved_observability_exporter'
)
Assert-ExactProperties -Object $approval.capabilities -Expected $capabilityFields -Label 'Control-plane capabilities'
foreach ($capability in $capabilityFields) {
  $value = $approval.capabilities.PSObject.Properties[$capability].Value
  if ($value -isnot [bool] -or -not $value) {
    throw 'Every required control-plane capability must be explicitly approved.'
  }
}
$resolvedSbom = Resolve-DeploymentInput -Path $approval.sbom_path -Label 'Control-plane SBOM' -MaximumBytes 16777216
$resolvedProvenance = Resolve-DeploymentInput -Path $approval.provenance_path -Label 'Control-plane provenance' -MaximumBytes 16777216
Assert-ArtifactHash -Path $resolvedSbom -ExpectedSha256 $approval.sbom_sha256 -Label 'Control-plane SBOM'
Assert-ArtifactHash -Path $resolvedProvenance -ExpectedSha256 $approval.provenance_sha256 -Label 'Control-plane provenance'

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
if ((-not $environmentValues.ContainsKey('CONTROL_PLANE_IMAGE')) -or
    ($environmentValues['CONTROL_PLANE_IMAGE'] -cne $approval.image_reference)) {
  throw 'CONTROL_PLANE_IMAGE must exactly match the independently approved image reference.'
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
if ($images -cnotcontains $approval.image_reference) {
  throw 'Rendered Compose configuration does not contain the approved control-plane image.'
}

[pscustomobject]@{
  Status = 'Passed'
  ComposeFile = $resolvedCompose
  ImageCount = $images.Count
  SecretFileCount = $resolvedSecrets.Count
  ControlPlaneApprovalId = $approval.approval_id
  ControlPlaneSourceRevision = $approval.source_revision
  GovernanceMode = $approval.governance_mode
  AssuranceLevel = $approval.assurance_level
  MutatingAction = $false
}
