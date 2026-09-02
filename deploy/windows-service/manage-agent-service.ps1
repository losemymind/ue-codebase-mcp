[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('Plan', 'Install', 'Update', 'Rollback', 'Uninstall')]
  [string]$Action = 'Plan',
  [string]$ServiceName = 'UECodebaseMcpAgent',
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$ExpectedExecutableSha256,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$ExpectedConfigSha256,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$')]
  [string]$ExpectedSignerThumbprint,
  [string]$PreviousReleaseExecutablePath,
  [string]$PreviousReleaseConfigPath,
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$PreviousReleaseExecutableSha256,
  [ValidatePattern('^[A-Fa-f0-9]{64}$')]
  [string]$PreviousReleaseConfigSha256,
  [ValidatePattern('^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$')]
  [string]$PreviousReleaseSignerThumbprint,
  [uri]$ReadinessUri = 'https://127.0.0.1:7443/health/ready',
  [ValidateRange(5, 300)]
  [int]$ReadinessTimeoutSeconds = 60,
  [string]$EvidenceDirectory,
  [string]$ServiceAccount = 'NT SERVICE\UECodebaseMcpAgent',
  [ValidateSet('Automatic', 'Manual')]
  [string]$StartupType = 'Automatic'
)

$ErrorActionPreference = 'Stop'
$expectedServiceName = 'UECodebaseMcpAgent'
if ($ServiceName -ne $expectedServiceName) {
  throw "ServiceName must be exactly '$expectedServiceName'."
}
if (($ReadinessUri.Scheme -ne 'https') -or
    ($ReadinessUri.AbsolutePath -ne '/health/ready') -or
    (-not [string]::IsNullOrEmpty($ReadinessUri.Query)) -or
    (-not [string]::IsNullOrEmpty($ReadinessUri.Fragment)) -or
    (-not [string]::IsNullOrEmpty($ReadinessUri.UserInfo))) {
  throw 'ReadinessUri must be an HTTPS /health/ready endpoint without user information, query, or fragment.'
}
if ($ServiceAccount -notmatch '^(NT SERVICE\\UECodebaseMcpAgent|[A-Za-z0-9.-]{1,63}\\[A-Za-z0-9_.-]{1,63}\$$)') {
  throw 'ServiceAccount must be the service virtual account or a gMSA ending in $. Password-bearing accounts are not accepted.'
}

$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if (-not [System.IO.Path]::IsPathFullyQualified($InstallRoot)) {
  throw 'InstallRoot must be a fully qualified path.'
}
$rootPrefix = $resolvedRoot.TrimEnd('\') + '\'

function Resolve-ReleasePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [ValidateSet('Executable', 'Config')]
    [string]$Kind
  )

  if (-not [System.IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Label must be a fully qualified path."
  }
  $resolved = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolved.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must remain below InstallRoot."
  }
  if ($Kind -eq 'Executable' -and [System.IO.Path]::GetFileName($resolved) -ne 'ue-codebase-mcp-agent.exe') {
    throw "$Label must name the packaged ue-codebase-mcp-agent.exe binary."
  }
  if ($Kind -eq 'Config' -and [System.IO.Path]::GetExtension($resolved) -notin @('.json', '.yaml', '.yml')) {
    throw "$Label must use a supported configuration extension."
  }
  return $resolved
}

function Assert-PathHasNoReparsePoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $current = Get-Item -LiteralPath $Path -Force
  while ($null -ne $current) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label and its existing parent path must not contain a reparse point."
    }
    $parentPath = Split-Path -LiteralPath $current.FullName
    if ([string]::IsNullOrEmpty($parentPath) -or $parentPath -eq $current.FullName) { break }
    $current = Get-Item -LiteralPath $parentPath -Force
  }
}

function Assert-ApprovedRelease {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string]$Config,
    [Parameter(Mandatory = $true)]
    [string]$ExecutableSha256,
    [Parameter(Mandatory = $true)]
    [string]$ConfigSha256,
    [Parameter(Mandatory = $true)]
    [string]$SignerThumbprint
  )

  if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath $Config -PathType Leaf)) {
    throw 'Approved release executable and configuration must exist.'
  }
  $executableItem = Get-Item -LiteralPath $Executable -Force
  $configItem = Get-Item -LiteralPath $Config -Force
  if ((($executableItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) -or
      (($configItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'Approved release executable and configuration must not be reparse points.'
  }
  Assert-PathHasNoReparsePoint -Path $Executable -Label 'Approved release executable'
  Assert-PathHasNoReparsePoint -Path $Config -Label 'Approved release configuration'
  $actualExecutableHash = (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash
  $actualConfigHash = (Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash
  if ((-not $actualExecutableHash.Equals($ExecutableSha256, [System.StringComparison]::OrdinalIgnoreCase)) -or
      (-not $actualConfigHash.Equals($ConfigSha256, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw 'Approved release executable or configuration hash did not match.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Executable
  $actualThumbprint = if ($null -eq $signature.SignerCertificate) { '' } else { $signature.SignerCertificate.Thumbprint }
  if (($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) -or
      (-not $actualThumbprint.Equals($SignerThumbprint, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw 'Executable Authenticode signature or signer thumbprint did not match the approved release.'
  }
}

function Get-ServiceBinaryPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string]$Config
  )

  return '"{0}" --config "{1}"' -f $Executable, $Config
}

function Set-AgentServiceConfiguration {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath
  )

  & sc.exe config $expectedServiceName "binPath= $BinaryPath" "obj= $ServiceAccount" "start= $scStart" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe update failed with exit code $LASTEXITCODE" }
  & sc.exe failure $expectedServiceName 'reset= 86400' 'actions= restart/60000/restart/60000/none/0' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery configuration failed with exit code $LASTEXITCODE" }
  & sc.exe failureflag $expectedServiceName 1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery flag configuration failed with exit code $LASTEXITCODE" }
}

function Stop-AgentService {
  $service = Get-Service -Name $expectedServiceName
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    Stop-Service -Name $expectedServiceName
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
  }
}

function Start-AndVerifyAgentService {
  Start-Service -Name $expectedServiceName
  $service = Get-Service -Name $expectedServiceName
  $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadinessTimeoutSeconds)
  do {
    try {
      $remaining = [Math]::Max(1, [Math]::Min(5, [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)))
      $response = Invoke-WebRequest -Uri $ReadinessUri -Method Get -UseBasicParsing -MaximumRedirection 0 -TimeoutSec $remaining -Headers @{ 'Cache-Control' = 'no-store' }
      if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ready') {
        return
      }
    } catch {
      # Readiness failures stay content-safe and are retried only within the fixed deadline.
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Service did not reach the approved readiness endpoint before the deadline.'
}

function Write-DeploymentEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Outcome,
    [Parameter(Mandatory = $true)]
    [string]$TargetExecutableHash,
    [string]$RollbackExecutableHash = ''
  )

  if (-not (Test-Path -LiteralPath $resolvedEvidenceDirectory)) {
    $existingEvidenceParent = Split-Path -LiteralPath $resolvedEvidenceDirectory
    Assert-PathHasNoReparsePoint -Path $existingEvidenceParent -Label 'EvidenceDirectory parent'
    New-Item -ItemType Directory -Path $resolvedEvidenceDirectory | Out-Null
  }
  $evidenceItem = Get-Item -LiteralPath $resolvedEvidenceDirectory -Force
  if (($evidenceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'EvidenceDirectory must not be a reparse point.'
  }
  Assert-PathHasNoReparsePoint -Path $resolvedEvidenceDirectory -Label 'EvidenceDirectory'
  & icacls.exe $resolvedEvidenceDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "EvidenceDirectory ACL protection failed with exit code $LASTEXITCODE" }
  $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffffffZ')
  $record = [ordered]@{
    schema = 'ue-codebase-mcp/windows-service-deployment-evidence'
    version = 1
    recorded_at = [DateTime]::UtcNow.ToString('o')
    action = $Action
    outcome = $Outcome
    service_name = $expectedServiceName
    service_account = $ServiceAccount
    readiness_origin = $ReadinessUri.GetLeftPart([System.UriPartial]::Authority)
    target_executable_sha256 = $TargetExecutableHash.ToLowerInvariant()
    rollback_executable_sha256 = $RollbackExecutableHash.ToLowerInvariant()
  }
  $finalPath = Join-Path $resolvedEvidenceDirectory "$timestamp-$([guid]::NewGuid().ToString('N')).json"
  $temporaryPath = "$finalPath.tmp"
  [System.IO.File]::WriteAllText($temporaryPath, (($record | ConvertTo-Json -Depth 3) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $finalPath
}

$resolvedExecutable = Resolve-ReleasePath -Path $ExecutablePath -Label 'ExecutablePath' -Kind Executable
$resolvedConfig = Resolve-ReleasePath -Path $ConfigPath -Label 'ConfigPath' -Kind Config
$resolvedEvidenceDirectory = if ([string]::IsNullOrWhiteSpace($EvidenceDirectory)) {
  Join-Path $resolvedRoot '.deployment-evidence'
} else {
  if (-not [System.IO.Path]::IsPathFullyQualified($EvidenceDirectory)) { throw 'EvidenceDirectory must be a fully qualified path.' }
  [System.IO.Path]::GetFullPath($EvidenceDirectory)
}
if (-not $resolvedEvidenceDirectory.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'EvidenceDirectory must remain below InstallRoot.'
}

$previousInputs = @(
  $PreviousReleaseExecutablePath,
  $PreviousReleaseConfigPath,
  $PreviousReleaseExecutableSha256,
  $PreviousReleaseConfigSha256,
  $PreviousReleaseSignerThumbprint
)
$requiresPreviousRelease = $Action -in @('Update', 'Rollback')
if ($requiresPreviousRelease -and ($previousInputs | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) {
  throw 'Update and Rollback require the complete approved previous-release path, hashes, and signer thumbprint.'
}
$resolvedPreviousExecutable = $null
$resolvedPreviousConfig = $null
if ($requiresPreviousRelease) {
  $resolvedPreviousExecutable = Resolve-ReleasePath -Path $PreviousReleaseExecutablePath -Label 'PreviousReleaseExecutablePath' -Kind Executable
  $resolvedPreviousConfig = Resolve-ReleasePath -Path $PreviousReleaseConfigPath -Label 'PreviousReleaseConfigPath' -Kind Config
  if ($resolvedPreviousExecutable.Equals($resolvedExecutable, [System.StringComparison]::OrdinalIgnoreCase) -or
      $resolvedPreviousConfig.Equals($resolvedConfig, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The approved previous release must use distinct executable and configuration paths.'
  }
}

$binaryPath = Get-ServiceBinaryPath -Executable $resolvedExecutable -Config $resolvedConfig
$scStart = if ($StartupType -eq 'Automatic') { 'auto' } else { 'demand' }
$existing = Get-CimInstance -ClassName Win32_Service -Filter "Name='$expectedServiceName'" -ErrorAction SilentlyContinue

if ($Action -eq 'Plan') {
  [pscustomobject]@{
    Action = if ($null -eq $existing) { 'Install' } else { 'Update' }
    ServiceName = $expectedServiceName
    BinaryPath = $binaryPath
    ServiceAccount = $ServiceAccount
    StartupType = $StartupType
    ExecutableSha256 = $ExpectedExecutableSha256.ToLowerInvariant()
    ConfigSha256 = $ExpectedConfigSha256.ToLowerInvariant()
    SignerThumbprint = $ExpectedSignerThumbprint.ToUpperInvariant()
    ReadinessUri = $ReadinessUri.AbsoluteUri
    ApprovedPreviousReleaseSupplied = -not [string]::IsNullOrWhiteSpace($PreviousReleaseExecutablePath)
    MutatingAction = $false
  }
  exit 0
}

if ($Action -eq 'Uninstall') {
  if ($null -eq $existing) { throw 'Service does not exist.' }
  if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Uninstall Windows service')) {
    Stop-AgentService
    & sc.exe delete $expectedServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed with exit code $LASTEXITCODE" }
    Write-DeploymentEvidence -Outcome 'uninstalled' -TargetExecutableHash $ExpectedExecutableSha256
  }
  exit 0
}

if ($Action -eq 'Install' -and $null -ne $existing) { throw 'Service already exists; use Update.' }
if ($Action -in @('Update', 'Rollback') -and $null -eq $existing) { throw 'Service does not exist; use Install.' }
if ($Action -in @('Install', 'Update')) {
  Assert-ApprovedRelease -Executable $resolvedExecutable -Config $resolvedConfig `
    -ExecutableSha256 $ExpectedExecutableSha256 -ConfigSha256 $ExpectedConfigSha256 `
    -SignerThumbprint $ExpectedSignerThumbprint
}
if ($requiresPreviousRelease) {
  Assert-ApprovedRelease -Executable $resolvedPreviousExecutable -Config $resolvedPreviousConfig `
    -ExecutableSha256 $PreviousReleaseExecutableSha256 -ConfigSha256 $PreviousReleaseConfigSha256 `
    -SignerThumbprint $PreviousReleaseSignerThumbprint
}

if ($Action -eq 'Install') {
  if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Install, start, and verify Windows service')) {
    try {
      & sc.exe create $expectedServiceName "binPath= $binaryPath" "obj= $ServiceAccount" "start= $scStart" 'DisplayName= UE Codebase MCP Windows Agent' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "sc.exe service creation failed with exit code $LASTEXITCODE" }
      & sc.exe description $expectedServiceName 'Typed SVN/UE indexing agent; no general command interface.' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "sc.exe description configuration failed with exit code $LASTEXITCODE" }
      Set-AgentServiceConfiguration -BinaryPath $binaryPath
      Start-AndVerifyAgentService
      Write-DeploymentEvidence -Outcome 'installed_ready' -TargetExecutableHash $ExpectedExecutableSha256
    } catch {
      Write-DeploymentEvidence -Outcome 'install_failed' -TargetExecutableHash $ExpectedExecutableSha256
      throw
    }
  }
  exit 0
}

$previousBinaryPath = Get-ServiceBinaryPath -Executable $resolvedPreviousExecutable -Config $resolvedPreviousConfig
if ($Action -eq 'Rollback') {
  if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Roll back to approved previous release and verify readiness')) {
    try {
      Stop-AgentService
      Set-AgentServiceConfiguration -BinaryPath $previousBinaryPath
      Start-AndVerifyAgentService
      Write-DeploymentEvidence -Outcome 'rollback_ready' -TargetExecutableHash $PreviousReleaseExecutableSha256
    } catch {
      Write-DeploymentEvidence -Outcome 'rollback_failed' -TargetExecutableHash $PreviousReleaseExecutableSha256
      throw
    }
  }
  exit 0
}

if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Update, start, and verify Windows service with protected rollback')) {
  try {
    Stop-AgentService
    Set-AgentServiceConfiguration -BinaryPath $binaryPath
    Start-AndVerifyAgentService
    Write-DeploymentEvidence -Outcome 'updated_ready' -TargetExecutableHash $ExpectedExecutableSha256 `
      -RollbackExecutableHash $PreviousReleaseExecutableSha256
  } catch {
    $rollbackSucceeded = $false
    try {
      Stop-AgentService
      Set-AgentServiceConfiguration -BinaryPath $previousBinaryPath
      Start-AndVerifyAgentService
      $rollbackSucceeded = $true
    } catch {
      $rollbackSucceeded = $false
    }
    if ($rollbackSucceeded) {
      Write-DeploymentEvidence -Outcome 'update_failed_rollback_ready' -TargetExecutableHash $ExpectedExecutableSha256 `
        -RollbackExecutableHash $PreviousReleaseExecutableSha256
      throw 'Update verification failed; the approved previous release was restored and reached readiness.'
    }
    Write-DeploymentEvidence -Outcome 'update_failed_rollback_failed' -TargetExecutableHash $ExpectedExecutableSha256 `
      -RollbackExecutableHash $PreviousReleaseExecutableSha256
    throw 'Update verification and the approved rollback both failed; manual recovery is required.'
  }
}
