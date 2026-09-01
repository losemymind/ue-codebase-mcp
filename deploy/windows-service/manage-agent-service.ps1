[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('Plan', 'Install', 'Update', 'Uninstall')]
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
  [string]$ServiceAccount = 'NT SERVICE\UECodebaseMcpAgent',
  [ValidateSet('Automatic', 'Manual')]
  [string]$StartupType = 'Automatic'
)

$ErrorActionPreference = 'Stop'
$expectedServiceName = 'UECodebaseMcpAgent'
if ($ServiceName -ne $expectedServiceName) {
  throw "ServiceName must be exactly '$expectedServiceName'."
}

$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedExecutable = [System.IO.Path]::GetFullPath($ExecutablePath)
$resolvedConfig = [System.IO.Path]::GetFullPath($ConfigPath)
if (-not [System.IO.Path]::IsPathFullyQualified($resolvedRoot) -or
    -not [System.IO.Path]::IsPathFullyQualified($resolvedExecutable) -or
    -not [System.IO.Path]::IsPathFullyQualified($resolvedConfig)) {
  throw 'InstallRoot, ExecutablePath, and ConfigPath must be fully qualified paths.'
}

$rootPrefix = $resolvedRoot.TrimEnd('\') + '\'
if (-not $resolvedExecutable.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $resolvedConfig.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'ExecutablePath and ConfigPath must remain below InstallRoot.'
}
if ([System.IO.Path]::GetFileName($resolvedExecutable) -ne 'ue-codebase-mcp-agent.exe') {
  throw 'ExecutablePath must name the packaged ue-codebase-mcp-agent.exe binary.'
}
if ([System.IO.Path]::GetExtension($resolvedConfig) -notin @('.json', '.yaml', '.yml')) {
  throw 'ConfigPath must use a supported configuration extension.'
}
if ($ServiceAccount -notmatch '^(NT SERVICE\UECodebaseMcpAgent|[A-Za-z0-9.-]{1,63}\[A-Za-z0-9_.-]{1,63}\$$)') {
  throw 'ServiceAccount must be the service virtual account or a gMSA ending in $. Password-bearing accounts are not accepted.'
}

$binaryPath = '"{0}" --config "{1}"' -f $resolvedExecutable, $resolvedConfig
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
  }
  exit 0
}

if ($Action -eq 'Install') {
  if ($null -ne $existing) { throw 'Service already exists; use Update.' }
  if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $resolvedConfig -PathType Leaf)) {
    throw 'Packaged executable and configuration must exist before installation.'
  }
  if (((Get-Item -LiteralPath $resolvedExecutable).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ((Get-Item -LiteralPath $resolvedConfig).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Packaged executable and configuration must not be reparse points.'
  }
  if ((Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256).Hash -ne $ExpectedExecutableSha256 -or
      (Get-FileHash -LiteralPath $resolvedConfig -Algorithm SHA256).Hash -ne $ExpectedConfigSha256) {
    throw 'Packaged executable or configuration hash did not match the approved release input.'
  }
  if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Install Windows service')) {
    & sc.exe create $expectedServiceName "binPath= $binaryPath" "obj= $ServiceAccount" "start= $scStart" 'DisplayName= UE Codebase MCP Windows Agent' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe service creation failed with exit code $LASTEXITCODE" }
    & sc.exe description $expectedServiceName 'Typed SVN/UE indexing agent; no general command interface.' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe description configuration failed with exit code $LASTEXITCODE" }
    & sc.exe failure $expectedServiceName 'reset= 86400' 'actions= restart/60000/restart/60000/none/0' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery configuration failed with exit code $LASTEXITCODE" }
    & sc.exe failureflag $expectedServiceName 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery flag configuration failed with exit code $LASTEXITCODE" }
  }
  exit 0
}

if ($Action -eq 'Update') {
  if ($null -eq $existing) { throw 'Service does not exist; use Install.' }
  if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $resolvedConfig -PathType Leaf)) {
    throw 'Packaged executable and configuration must exist before update.'
  }
  if (((Get-Item -LiteralPath $resolvedExecutable).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      ((Get-Item -LiteralPath $resolvedConfig).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Packaged executable and configuration must not be reparse points.'
  }
  if ((Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256).Hash -ne $ExpectedExecutableSha256 -or
      (Get-FileHash -LiteralPath $resolvedConfig -Algorithm SHA256).Hash -ne $ExpectedConfigSha256) {
    throw 'Packaged executable or configuration hash did not match the approved release input.'
  }
  if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Update Windows service configuration')) {
    & sc.exe config $expectedServiceName "binPath= $binaryPath" "obj= $ServiceAccount" "start= $scStart" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe update failed with exit code $LASTEXITCODE" }
    & sc.exe failure $expectedServiceName 'reset= 86400' 'actions= restart/60000/restart/60000/none/0' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery configuration failed with exit code $LASTEXITCODE" }
    & sc.exe failureflag $expectedServiceName 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe recovery flag configuration failed with exit code $LASTEXITCODE" }
  }
  exit 0
}

if ($null -eq $existing) { throw 'Service does not exist.' }
if ($PSCmdlet.ShouldProcess($expectedServiceName, 'Uninstall Windows service')) {
  if ($existing.State -ne 'Stopped') { Stop-Service -Name $expectedServiceName -Force }
  & sc.exe delete $expectedServiceName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe delete failed with exit code $LASTEXITCODE" }
}
