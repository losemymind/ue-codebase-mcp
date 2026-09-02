[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('Status', 'Install', 'Verify', 'Backup', 'Uninstall')]
  [string]$Action = 'Status',
  [string]$StateRoot,
  [string]$BackupDirectory,
  [ValidateRange(1024, 65535)]
  [int]$HostPort = 55432,
  [ValidatePattern('^pgvector/pgvector:[0-9]+\.[0-9]+\.[0-9]+-pg17(?:-(?:bookworm|trixie))?$')]
  [string]$PgvectorImage = 'pgvector/pgvector:0.8.6-pg17',
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$ExpectedImageDigest,
  [switch]$AcceptInstall,
  [switch]$SkipVerification,
  [switch]$DiscardData,
  [switch]$AcceptDataLoss,
  [switch]$RemoveManagedDependencies,
  [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$containerName = 'ue-codebase-mcp-postgres-test'
$volumeName = 'ue-codebase-mcp-postgres-test-data'
$databaseName = 'ue_codebase_mcp_test'
$databaseUser = 'ue_mcp_test'
$nodeVersion = '24.18.0'
$npmVersion = '11.16.0'
$nodePackageId = 'OpenJS.NodeJS.LTS'
$nodeProductCode = '{6178C0C7-8EA8-458F-8060-E49E500A666F}'
$dockerPackageId = 'Docker.DockerDesktop'
$dockerInstallerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
$nodeInstallerUrl = 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-x64.msi'
$nodeInstallerSha256 = 'e30cd4ca15529583afe0efc978f1ae3ab3a93c2400c222d0752d17900552ebb3'
$stateFileName = 'state.json'
$dependencyReceiptFileName = 'dependency-receipt.json'
$passwordFileName = 'postgres-password'
$dsnFileName = 'control-plane-database-dsn'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Test-WindowsPlatform {
  return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Test-FullyQualifiedPath {
  param([string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

function Resolve-SafeRoot {
  param([string]$Requested)

  $candidate = if ([string]::IsNullOrWhiteSpace($Requested)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable.' }
    Join-Path $env:LOCALAPPDATA 'UECodebaseMcp\live-database'
  } else { $Requested }
  if (-not (Test-FullyQualifiedPath -Path $candidate)) { throw 'StateRoot must be fully qualified.' }
  $resolved = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'StateRoot must not be a drive root.'
  }
  return $resolved
}

function Assert-NoReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $currentPath = $Path
  while (-not (Test-Path -LiteralPath $currentPath)) {
    $parent = Split-Path -LiteralPath $currentPath -Parent
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $currentPath) { break }
    $currentPath = $parent
  }
  $current = Get-Item -LiteralPath $currentPath -Force
  while ($null -ne $current) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label and its existing parent path must not contain a reparse point."
    }
    $parentPath = Split-Path -LiteralPath $current.FullName -Parent
    if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $current.FullName) { break }
    $current = Get-Item -LiteralPath $parentPath -Force
  }
}

function Protect-Path {
  param([Parameter(Mandatory = $true)][string]$Path)

  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $item = Get-Item -LiteralPath $Path -Force
  $rule = if ($item.PSIsContainer) { "*${sid}:(OI)(CI)(F)" } else { "*${sid}:(F)" }
  & icacls.exe $Path /inheritance:r /grant:r $rule '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Managed path ACL protection failed.' }
}

function Initialize-StateRoot {
  param([Parameter(Mandatory = $true)][string]$Root)

  Assert-NoReparsePoint -Path $Root -Label 'StateRoot'
  if (-not (Test-Path -LiteralPath $Root)) {
    New-Item -ItemType Directory -Path $Root | Out-Null
  }
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'StateRoot must be a directory.' }
  Assert-NoReparsePoint -Path $Root -Label 'StateRoot'
  Protect-Path -Path $Root
}

function Confirm-Operation {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [switch]$Accepted
  )

  if ($Accepted) { return }
  if ($NonInteractive) { throw 'Interactive confirmation is unavailable; pass the explicit acceptance switch.' }
  $answer = Read-Host "$Message Type YES to continue"
  if ($answer -cne 'YES') { throw 'Operation cancelled by user.' }
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-Application {
  param([Parameter(Mandatory = $true)][string]$Name)
  return Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][scriptblock]$Operation
  )

  & $Operation
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Get-ToolVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Operation
  )

  if ($null -eq (Get-Application -Name $Name)) { return $null }
  try { return "$(& $Operation)".Trim() } catch { return $null }
}

function Test-WslReady {
  if ($null -eq (Get-Application -Name 'wsl')) { return $false }
  & wsl.exe --version 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Get-VirtualizationStatus {
  try {
    $systems = @(Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop)
    if ($systems.Count -eq 1 -and $systems[0].HypervisorPresent -eq $true) { return $true }
    $processors = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
    if ($processors.Count -eq 0) { return $null }
    return -not ($processors | Where-Object { -not $_.VirtualizationFirmwareEnabled })
  } catch { return $null }
}

function Install-WslIfMissing {
  if (Test-WslReady) { return }
  Confirm-Operation -Message 'WSL 2 is missing or outdated. Install/update this shared Windows component? It will not be removed by this tool.' -Accepted:$AcceptInstall
  if (-not $PSCmdlet.ShouldProcess('Windows Subsystem for Linux', 'Install or update shared prerequisite')) { return }
  $wsl = Get-Application -Name 'wsl'
  if ($null -eq $wsl) { throw 'wsl.exe is unavailable. Install the Microsoft WSL package, then rerun this tool.' }
  $process = Start-Process -FilePath $wsl.Source -ArgumentList '--install', '--no-distribution' -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "WSL installation failed with exit code $($process.ExitCode)." }
  & wsl.exe --update | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WSL update failed.' }
  if (-not (Test-WslReady)) { throw 'WSL installation requires a Windows restart. Restart, then rerun Install.' }
}

function New-TemporaryDirectory {
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ("ue-mcp-environment-{0}" -f [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $path | Out-Null
  return $path
}

function Remove-TemporaryDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not $Path.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Temporary directory escaped the system temporary root.'
  }
  if (Test-Path -LiteralPath $Path) {
    foreach ($file in @(Get-ChildItem -LiteralPath $Path -Force -File)) { Remove-Item -LiteralPath $file.FullName -Force }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) { Remove-Item -LiteralPath $Path -Force }
  }
}

function Install-NodeIfMissing {
  param([string]$Root, [bool]$DockerInstalledByTool)

  $currentNode = Get-ToolVersion -Name 'node' -Operation { node --version }
  $currentNpm = Get-ToolVersion -Name 'npm' -Operation { npm --version }
  if ($currentNode -eq "v$nodeVersion" -and $currentNpm -eq $npmVersion) { return $false }
  if ($null -ne $currentNode -or $null -ne $currentNpm) {
    throw "Node.js/npm are present but do not match required versions $nodeVersion/$npmVersion. The tool will not replace an existing runtime."
  }
  Confirm-Operation -Message "Node.js $nodeVersion and npm $npmVersion are missing. Install the exact signed Node.js package?" -Accepted:$AcceptInstall
  if (-not $PSCmdlet.ShouldProcess("Node.js $nodeVersion", 'Install dependency')) { return $false }

  $winget = Get-Application -Name 'winget'
  if ($null -ne $winget) {
    Invoke-External -Description 'Node.js installation' -Operation {
      & $winget.Source install --id $nodePackageId --version $nodeVersion --exact --source winget `
        --accept-source-agreements --accept-package-agreements --disable-interactivity
    }
  } else {
    $temporary = New-TemporaryDirectory
    try {
      $installer = Join-Path $temporary 'node.msi'
      Invoke-WebRequest -Uri $nodeInstallerUrl -OutFile $installer -UseBasicParsing
      $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -cne $nodeInstallerSha256) { throw 'Downloaded Node.js installer SHA-256 did not match.' }
      $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$installer`"", '/qn', '/norestart' -Verb RunAs -Wait -PassThru
      if ($process.ExitCode -notin @(0, 3010)) { throw "Node.js installer failed with exit code $($process.ExitCode)." }
    } finally { Remove-TemporaryDirectory -Path $temporary }
  }
  Save-DependencyReceipt -Root $Root -NodeInstalledByTool $true -DockerInstalledByTool $DockerInstalledByTool
  Refresh-ProcessPath
  if (((Get-ToolVersion -Name 'node' -Operation { node --version }) -ne "v$nodeVersion") -or
      ((Get-ToolVersion -Name 'npm' -Operation { npm --version }) -ne $npmVersion)) {
    throw 'Node.js installation completed but the required runtime is not available in PATH.'
  }
  return $true
}

function Find-DockerDesktopExecutable {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Find-DockerInstaller {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop Installer.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop Installer.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Test-DockerEngine {
  if ($null -eq (Get-Application -Name 'docker')) { return $false }
  & docker info --format '{{.OSType}}' 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Wait-DockerEngine {
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  do {
    Refresh-ProcessPath
    if (Test-DockerEngine) { return }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Docker Desktop was installed or started but the Linux container engine did not become ready. A reboot or first-run confirmation may be required; rerun Install afterward.'
}

function Install-DockerIfMissing {
  param([string]$Root, [bool]$NodeInstalledByTool)

  Refresh-ProcessPath
  if (Test-DockerEngine) { return $false }
  $virtualization = Get-VirtualizationStatus
  if ($virtualization -eq $false) { throw 'Firmware virtualization is disabled. Enable virtualization in firmware before installing Docker Desktop.' }
  Install-WslIfMissing
  $dockerInstalled = $null -ne (Find-DockerDesktopExecutable)
  if (-not $dockerInstalled) {
    Confirm-Operation -Message 'Docker Desktop is missing. Install it for the current user and accept the Docker Desktop license?' -Accepted:$AcceptInstall
    if ($PSCmdlet.ShouldProcess('Docker Desktop', 'Download and install dependency')) {
      $winget = Get-Application -Name 'winget'
      if ($null -ne $winget) {
        Invoke-External -Description 'Docker Desktop installation' -Operation {
          & $winget.Source install --id $dockerPackageId --exact --source winget `
            --accept-source-agreements --accept-package-agreements --disable-interactivity
        }
      } else {
        $temporary = New-TemporaryDirectory
        try {
          $installer = Join-Path $temporary 'Docker Desktop Installer.exe'
          Invoke-WebRequest -Uri $dockerInstallerUrl -OutFile $installer -UseBasicParsing
          $item = Get-Item -LiteralPath $installer
          if ($item.Length -lt 100MB -or $item.Length -gt 2GB) { throw 'Downloaded Docker Desktop installer has an invalid size.' }
          $signature = Get-AuthenticodeSignature -LiteralPath $installer
          if (($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) -or
              ($null -eq $signature.SignerCertificate) -or
              ($signature.SignerCertificate.Subject -notmatch '(?i)Docker')) {
            throw 'Downloaded Docker Desktop installer signature is invalid.'
          }
          $process = Start-Process -FilePath $installer -ArgumentList 'install', '--user', '--accept-license' -Wait -PassThru
          if ($process.ExitCode -ne 0) { throw "Docker Desktop installer failed with exit code $($process.ExitCode)." }
        } finally { Remove-TemporaryDirectory -Path $temporary }
      }
    }
    Save-DependencyReceipt -Root $Root -NodeInstalledByTool $NodeInstalledByTool -DockerInstalledByTool $true
  }
  Refresh-ProcessPath
  if (-not (Test-DockerEngine)) {
    $desktop = Find-DockerDesktopExecutable
    if ($null -eq $desktop) { throw 'Docker Desktop executable is unavailable after installation.' }
    if ($PSCmdlet.ShouldProcess($desktop, 'Start Docker Desktop')) { Start-Process -FilePath $desktop | Out-Null }
  }
  Wait-DockerEngine
  $osType = "$(docker info --format '{{.OSType}}')".Trim()
  if ($osType -cne 'linux') { throw 'Docker must use the Linux container engine.' }
  return (-not $dockerInstalled)
}

function New-Password {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Write-ProtectedText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )

  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
  Protect-Path -Path $Path
}

function Get-StatePath { param([string]$Root) return Join-Path $Root $stateFileName }

function Get-DependencyReceiptPath { param([string]$Root) return Join-Path $Root $dependencyReceiptFileName }

function Save-DependencyReceipt {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][bool]$NodeInstalledByTool,
    [Parameter(Mandatory = $true)][bool]$DockerInstalledByTool
  )

  if (-not $NodeInstalledByTool -and -not $DockerInstalledByTool) { return }
  Initialize-StateRoot -Root $Root
  $path = Get-DependencyReceiptPath -Root $Root
  $temporary = "$path.tmp"
  $receipt = [ordered]@{
    schema = 'ue-codebase-mcp/live-database-dependencies'
    version = 1
    node_installed_by_tool = $NodeInstalledByTool
    docker_installed_by_tool = $DockerInstalledByTool
    created_at = [DateTimeOffset]::UtcNow.ToString('o')
  }
  [System.IO.File]::WriteAllText($temporary, (($receipt | ConvertTo-Json -Depth 2) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Protect-Path -Path $temporary
  Move-Item -LiteralPath $temporary -Destination $path -Force
  Protect-Path -Path $path
}

function Read-DependencyReceipt {
  param([Parameter(Mandatory = $true)][string]$Root)

  $path = Get-DependencyReceiptPath -Root $Root
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  Assert-NoReparsePoint -Path $path -Label 'Dependency receipt'
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Length -lt 2 -or $item.Length -gt 8192) { throw 'Dependency receipt has an invalid size.' }
  try { $receipt = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { throw 'Dependency receipt is invalid.' }
  $expected = @('schema', 'version', 'node_installed_by_tool', 'docker_installed_by_tool', 'created_at')
  $actual = @($receipt.PSObject.Properties.Name)
  if ($actual.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $actual }).Count -ne 0 -or
      ($receipt.schema -cne 'ue-codebase-mcp/live-database-dependencies') -or ($receipt.version -ne 1) -or
      ($receipt.node_installed_by_tool -isnot [bool]) -or ($receipt.docker_installed_by_tool -isnot [bool])) {
    throw 'Dependency receipt fields are invalid.'
  }
  return $receipt
}

function Save-State {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][psobject]$State
  )

  Initialize-StateRoot -Root $Root
  $path = Get-StatePath -Root $Root
  $temporary = "$path.tmp"
  [System.IO.File]::WriteAllText($temporary, (($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Protect-Path -Path $temporary
  Move-Item -LiteralPath $temporary -Destination $path -Force
  Protect-Path -Path $path
}

function Read-State {
  param([Parameter(Mandatory = $true)][string]$Root)

  $path = Get-StatePath -Root $Root
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  Assert-NoReparsePoint -Path $path -Label 'State file'
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Length -lt 2 -or $item.Length -gt 65536) { throw 'State file has an invalid size.' }
  try { $state = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { throw 'State file is invalid.' }
  $expected = @('schema', 'version', 'status', 'repository_root', 'state_root', 'container_name', 'volume_name',
    'database_name', 'database_user', 'host_port', 'image_requested', 'image_digest', 'docker_installed_by_tool',
    'node_installed_by_tool', 'created_at', 'last_verified_at')
  $actual = @($state.PSObject.Properties.Name)
  if ($actual.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $actual }).Count -ne 0) {
    throw 'State file fields are invalid.'
  }
  if (($state.schema -cne 'ue-codebase-mcp/live-database-environment') -or ($state.version -ne 1) -or
      ($state.status -notin @('provisioning', 'ready', 'verified')) -or
      ($state.state_root -cne $Root) -or ($state.repository_root -cne $repositoryRoot) -or
      ($state.container_name -cne $containerName) -or ($state.volume_name -cne $volumeName) -or
      ($state.database_name -cne $databaseName) -or ($state.database_user -cne $databaseUser) -or
      ($state.host_port -lt 1024) -or ($state.host_port -gt 65535) -or
      ($state.image_requested -notmatch '^pgvector/pgvector:[0-9]+\.[0-9]+\.[0-9]+-pg17(?:-(?:bookworm|trixie))?$') -or
      ($state.image_digest -notmatch '^sha256:[a-f0-9]{64}$') -or
      ($state.docker_installed_by_tool -isnot [bool]) -or ($state.node_installed_by_tool -isnot [bool])) {
    throw 'State file values are invalid.'
  }
  return $state
}

function Test-DockerObject {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('container', 'volume')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Name
  )
  & docker $Kind inspect $Name 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Assert-ManagedDockerObject {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('container', 'volume')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Name
  )

  try { $objects = @((& docker $Kind inspect $Name 2>$null) | ConvertFrom-Json) } catch {
    throw "Managed Docker $Kind metadata is invalid."
  }
  if ($LASTEXITCODE -ne 0 -or $objects.Count -ne 1) { throw "Managed Docker $Kind cannot be inspected." }
  $labels = if ($Kind -ceq 'container') { $objects[0].Config.Labels } else { $objects[0].Labels }
  $managed = if ($null -eq $labels) { $null } else { $labels.PSObject.Properties['com.ue-codebase-mcp.managed'] }
  $purpose = if ($null -eq $labels) { $null } else { $labels.PSObject.Properties['com.ue-codebase-mcp.purpose'] }
  if ($null -eq $managed -or $managed.Value -cne 'true' -or
      $null -eq $purpose -or $purpose.Value -cne 'p1-live-test') {
    throw "Fixed-name Docker $Kind is not owned by this environment; refusing to use or remove it."
  }
}

function Assert-PortAvailable {
  param([int]$Port)
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($null -ne $listener) { throw "Host port $Port is already in use." }
}

function Wait-ContainerHealthy {
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    $status = "$(docker inspect --format '{{.State.Health.Status}}' $containerName 2>$null)".Trim()
    if ($status -ceq 'healthy') { return }
    if ($status -ceq 'unhealthy') { throw 'PostgreSQL container reported unhealthy.' }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'PostgreSQL container did not become healthy before the deadline.'
}

function New-ManagedContainer {
  param([string]$Root, [psobject]$State)

  $passwordPath = Join-Path $Root $passwordFileName
  if (-not (Test-Path -LiteralPath $passwordPath -PathType Leaf)) { throw 'Managed PostgreSQL password file is missing.' }
  Assert-NoReparsePoint -Path $passwordPath -Label 'Managed PostgreSQL password file'
  Assert-PortAvailable -Port $State.host_port
  $secretMount = "type=bind,source=$passwordPath,target=/run/secrets/postgres_password,readonly"
  $sourceMount = "type=bind,source=$repositoryRoot,target=/workspace,readonly"
  $dataMount = "type=volume,source=$volumeName,target=/var/lib/postgresql/data"
  $immutableImage = "pgvector/pgvector@$($State.image_digest)"
  & docker image inspect $immutableImage 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Invoke-External -Description 'immutable pgvector image pull' -Operation { docker pull $immutableImage | Out-Null }
  }
  Invoke-External -Description 'PostgreSQL container creation' -Operation {
    docker run --detach --name $containerName --label 'com.ue-codebase-mcp.managed=true' `
      --label 'com.ue-codebase-mcp.purpose=p1-live-test' --restart no --shm-size 256m `
      --publish "127.0.0.1:$($State.host_port):5432" --mount $dataMount --mount $secretMount --mount $sourceMount `
      --env "POSTGRES_DB=$databaseName" --env "POSTGRES_USER=$databaseUser" `
      --env 'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password' `
      --health-cmd "pg_isready -U $databaseUser -d $databaseName" --health-interval 2s --health-timeout 3s `
      --health-retries 30 --health-start-period 10s $immutableImage | Out-Null
  }
}

function Ensure-ManagedContainerRunning {
  param([string]$Root, [psobject]$State, [switch]$AllowRecreate)

  if (-not (Test-DockerObject -Kind container -Name $containerName)) {
    if (-not $AllowRecreate -or -not (Test-DockerObject -Kind volume -Name $volumeName)) {
      throw 'Managed PostgreSQL container is missing.'
    }
    Assert-ManagedDockerObject -Kind volume -Name $volumeName
    New-ManagedContainer -Root $Root -State $State
  }
  Assert-ManagedDockerObject -Kind container -Name $containerName
  $running = "$(docker inspect --format '{{.State.Running}}' $containerName 2>$null)".Trim()
  if ($running -cne 'true') {
    Invoke-External -Description 'Managed PostgreSQL container start' -Operation { docker container start $containerName | Out-Null }
  }
  Wait-ContainerHealthy
}

function Install-DatabaseEnvironment {
  param(
    [string]$Root,
    [bool]$DockerInstalledByTool,
    [bool]$NodeInstalledByTool
  )

  $existing = Read-State -Root $Root
  if ($null -ne $existing) {
    if (Test-DockerObject -Kind volume -Name $volumeName) {
      Assert-ManagedDockerObject -Kind volume -Name $volumeName
    }
    Ensure-ManagedContainerRunning -Root $Root -State $existing -AllowRecreate
    return $existing
  }
  if ((Test-DockerObject -Kind container -Name $containerName) -or (Test-DockerObject -Kind volume -Name $volumeName)) {
    throw 'Fixed-name Docker resources exist without a matching state file; refusing to adopt or overwrite them.'
  }
  Confirm-Operation -Message "Create a loopback-only PostgreSQL 17 + pgvector test environment on port $HostPort?" -Accepted:$AcceptInstall
  if (-not $PSCmdlet.ShouldProcess($containerName, 'Pull image and create managed database environment')) { return $null }
  Assert-PortAvailable -Port $HostPort
  Initialize-StateRoot -Root $Root
  Invoke-External -Description 'pgvector image pull' -Operation { docker pull $PgvectorImage | Out-Null }
  $digestLine = @(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' $PgvectorImage |
    Where-Object { $_ -match '@sha256:[a-f0-9]{64}$' } | Select-Object -First 1)
  if ($digestLine.Count -ne 1) { throw 'Pulled pgvector image has no immutable repository digest.' }
  $imageDigest = (($digestLine[0].Trim()) -split '@', 2)[1]
  if (-not [string]::IsNullOrWhiteSpace($ExpectedImageDigest) -and $imageDigest -cne "sha256:$ExpectedImageDigest") {
    throw 'Pulled pgvector image digest did not match ExpectedImageDigest.'
  }
  $password = New-Password
  $passwordPath = Join-Path $Root $passwordFileName
  $dsnPath = Join-Path $Root $dsnFileName
  Write-ProtectedText -Path $passwordPath -Value $password
  $encodedPassword = [uri]::EscapeDataString($password)
  Write-ProtectedText -Path $dsnPath -Value "postgresql://${databaseUser}:${encodedPassword}@127.0.0.1:${HostPort}/${databaseName}?sslmode=disable"
  $password = $null
  $encodedPassword = $null

  $state = [pscustomobject][ordered]@{
    schema = 'ue-codebase-mcp/live-database-environment'
    version = 1
    status = 'provisioning'
    repository_root = $repositoryRoot
    state_root = $Root
    container_name = $containerName
    volume_name = $volumeName
    database_name = $databaseName
    database_user = $databaseUser
    host_port = $HostPort
    image_requested = $PgvectorImage
    image_digest = $imageDigest
    docker_installed_by_tool = $DockerInstalledByTool
    node_installed_by_tool = $NodeInstalledByTool
    created_at = [DateTimeOffset]::UtcNow.ToString('o')
    last_verified_at = $null
  }
  Save-State -Root $Root -State $state
  Invoke-External -Description 'Docker volume creation' -Operation {
    docker volume create --label 'com.ue-codebase-mcp.managed=true' --label 'com.ue-codebase-mcp.purpose=p1-live-test' $volumeName | Out-Null
  }
  New-ManagedContainer -Root $Root -State $state
  Ensure-ManagedContainerRunning -Root $Root -State $state
  $state.status = 'ready'
  Save-State -Root $Root -State $state
  return $state
}

function Invoke-EnvironmentVerification {
  param([string]$Root, [psobject]$State)

  if ($null -eq $State) { throw 'Managed environment is not installed.' }
  if (-not (Test-DockerEngine)) {
    throw 'Managed Docker environment is unavailable.'
  }
  Ensure-ManagedContainerRunning -Root $Root -State $State -AllowRecreate
  if (((Get-ToolVersion -Name 'node' -Operation { node --version }) -ne "v$nodeVersion") -or
      ((Get-ToolVersion -Name 'npm' -Operation { npm --version }) -ne $npmVersion)) {
    throw 'Verification requires the repository-pinned Node.js and npm versions.'
  }
  $wrapper = Join-Path $PSScriptRoot 'docker-psql.ps1'
  $env:UE_MCP_TEST_POSTGRES_CONTAINER = $containerName
  $env:UE_MCP_TEST_POSTGRES_DATABASE = $databaseName
  try {
    & (Join-Path $repositoryRoot 'database\test-migrations.ps1') -PsqlPath $wrapper -DatabaseName $databaseName
    if ($LASTEXITCODE -ne 0) { throw 'Destructive migration verification failed.' }
    & (Join-Path $repositoryRoot 'database\migrate.ps1') -Action up -TargetVersion 9 -PsqlPath $wrapper -DatabaseName $databaseName
    if ($LASTEXITCODE -ne 0) { throw 'Final migration application failed.' }
    $env:UE_MCP_DATABASE_DSN_FILE = Join-Path $Root $dsnFileName
    Push-Location $repositoryRoot
    try {
      & npm run control-plane:db:test:live
      if ($LASTEXITCODE -ne 0) { throw 'Control-plane PostgreSQL runtime verification failed.' }
    } finally { Pop-Location }
  } finally {
    Remove-Item Env:UE_MCP_TEST_POSTGRES_CONTAINER -ErrorAction SilentlyContinue
    Remove-Item Env:UE_MCP_TEST_POSTGRES_DATABASE -ErrorAction SilentlyContinue
    Remove-Item Env:UE_MCP_DATABASE_DSN_FILE -ErrorAction SilentlyContinue
  }
  $extensionVersion = "$(docker exec $containerName psql --username=$databaseUser --dbname=$databaseName --no-psqlrc --tuples-only --no-align --command "SELECT extversion FROM pg_extension WHERE extname = 'vector';")".Trim()
  if ($LASTEXITCODE -ne 0 -or $extensionVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw 'pgvector extension version verification failed.'
  }
  $State.last_verified_at = [DateTimeOffset]::UtcNow.ToString('o')
  $State.status = 'verified'
  Save-State -Root $Root -State $State
  [pscustomobject]@{
    Status = 'Verified'
    Container = $containerName
    Database = $databaseName
    HostPort = $State.host_port
    ImageDigest = $State.image_digest
    PgvectorVersion = $extensionVersion
    VerifiedAt = $State.last_verified_at
  }
}

function Resolve-BackupDirectory {
  param([string]$Requested, [string]$Root)

  $candidate = $Requested
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    if ($NonInteractive) { throw 'BackupDirectory is required in non-interactive mode.' }
    $candidate = Read-Host 'Enter a fully qualified backup directory, or type CANCEL'
    if ($candidate -ceq 'CANCEL') { throw 'Operation cancelled by user.' }
  }
  if (-not (Test-FullyQualifiedPath -Path $candidate)) { throw 'BackupDirectory must be fully qualified.' }
  $resolved = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
  if ($resolved.StartsWith(($Root.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) -or
      $resolved.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'BackupDirectory must be outside StateRoot.'
  }
  Assert-NoReparsePoint -Path $resolved -Label 'BackupDirectory'
  if (-not (Test-Path -LiteralPath $resolved)) { New-Item -ItemType Directory -Path $resolved | Out-Null }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw 'BackupDirectory must be a directory.' }
  Assert-NoReparsePoint -Path $resolved -Label 'BackupDirectory'
  return $resolved
}

function Invoke-PgDump {
  param(
    [Parameter(Mandatory = $true)][string]$DockerPath,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $DockerPath
  $start.Arguments = "exec $containerName pg_dump --username=$databaseUser --dbname=$databaseName --format=custom --no-owner --no-privileges"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  $stream = $null
  try {
    if (-not $process.Start()) { throw 'Database backup process did not start.' }
    $errorRead = $process.StandardError.ReadToEndAsync()
    $stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $process.StandardOutput.BaseStream.CopyTo($stream)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    $process.WaitForExit()
    [void]$errorRead.Result
    if ($process.ExitCode -ne 0) { throw 'Database backup failed.' }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $process.Dispose()
  }
}

function Backup-Database {
  param([string]$Root, [psobject]$State, [string]$RequestedDirectory)

  if (($null -eq $State) -or (-not (Test-DockerEngine))) {
    throw 'A running managed database is required for backup.'
  }
  Ensure-ManagedContainerRunning -Root $Root -State $State -AllowRecreate
  $directory = Resolve-BackupDirectory -Requested $RequestedDirectory -Root $Root
  $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $base = "ue-codebase-mcp-postgres-$timestamp"
  $partial = Join-Path $directory "$base.dump.partial"
  $backup = Join-Path $directory "$base.dump"
  $manifest = Join-Path $directory "$base.json"
  if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $manifest)) {
    throw 'Backup destination already exists.'
  }
  $docker = Get-Application -Name 'docker'
  try {
    Invoke-PgDump -DockerPath $docker.Source -Destination $partial
    $item = Get-Item -LiteralPath $partial -Force
    if ($item.Length -lt 5) { throw 'Database backup is empty.' }
    $header = New-Object byte[] 5
    $stream = [System.IO.File]::OpenRead($partial)
    try { [void]$stream.Read($header, 0, 5) } finally { $stream.Dispose() }
    if ([System.Text.Encoding]::ASCII.GetString($header) -cne 'PGDMP') { throw 'Database backup format validation failed.' }
    Move-Item -LiteralPath $partial -Destination $backup
    $sha256 = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant()
    $record = [ordered]@{
      schema = 'ue-codebase-mcp/postgres-backup'
      version = 1
      created_at = [DateTimeOffset]::UtcNow.ToString('o')
      database_name = $databaseName
      source_image_digest = $State.image_digest
      backup_file = [System.IO.Path]::GetFileName($backup)
      backup_bytes = (Get-Item -LiteralPath $backup).Length
      backup_sha256 = $sha256
    }
    [System.IO.File]::WriteAllText($manifest, (($record | ConvertTo-Json -Depth 3) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
    Protect-Path -Path $backup
    Protect-Path -Path $manifest
    return [pscustomobject]@{ BackupFile = $backup; ManifestFile = $manifest; Sha256 = $sha256 }
  } catch {
    if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
    throw
  }
}

function Assert-ExplicitDataLoss {
  if (-not $DiscardData) { return }
  if ($AcceptDataLoss) { return }
  if ($NonInteractive) { throw 'AcceptDataLoss is required with DiscardData in non-interactive mode.' }
  $phrase = "DELETE $volumeName"
  $answer = Read-Host "Backup is being skipped. Type '$phrase' exactly to destroy the database volume"
  if ($answer -cne $phrase) { throw 'Operation cancelled by user.' }
}

function Remove-ManagedFiles {
  param([string]$Root)
  foreach ($name in @($stateFileName, $passwordFileName, $dsnFileName)) {
    $path = Join-Path $Root $name
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
  }
  if ((Test-Path -LiteralPath $Root -PathType Container) -and @(Get-ChildItem -LiteralPath $Root -Force).Count -eq 0) {
    Remove-Item -LiteralPath $Root -Force
  }
}

function Remove-DependencyReceipt {
  param([string]$Root)
  $path = Get-DependencyReceiptPath -Root $Root
  if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
  if ((Test-Path -LiteralPath $Root -PathType Container) -and @(Get-ChildItem -LiteralPath $Root -Force).Count -eq 0) {
    Remove-Item -LiteralPath $Root -Force
  }
}

function Remove-ToolInstalledDependencies {
  param([psobject]$DependencyRecord, [string]$ImageRequested)

  if (-not $RemoveManagedDependencies) { return }
  if ($DependencyRecord.docker_installed_by_tool) {
    if (-not (Test-DockerEngine)) { throw 'Docker must be running to prove no unmanaged Docker data exists before uninstall.' }
    $otherContainers = @(docker container ls --all --format '{{.Names}}' | Where-Object { $_ -and $_ -cne $containerName })
    $otherVolumes = @(docker volume ls --format '{{.Name}}' | Where-Object { $_ -and $_ -cne $volumeName })
    $managedImageIds = if ([string]::IsNullOrWhiteSpace($ImageRequested)) { @() } else {
      @(docker image inspect --format '{{.Id}}' $ImageRequested 2>$null | Select-Object -Unique)
    }
    $otherImages = @(docker image ls --all --quiet | Select-Object -Unique | Where-Object { $_ -and $_ -notin $managedImageIds })
    if ($otherContainers.Count -ne 0 -or $otherVolumes.Count -ne 0 -or $otherImages.Count -ne 0) {
      throw 'Docker Desktop contains unmanaged containers, volumes, or images and will not be uninstalled.'
    }
    Confirm-Operation -Message 'Docker Desktop was installed by this tool. Uninstalling it removes Docker application data. Continue?' -Accepted:$AcceptInstall
    $installer = Find-DockerInstaller
    if ($null -eq $installer) { throw 'Docker Desktop uninstaller is unavailable.' }
    if ($PSCmdlet.ShouldProcess('Docker Desktop', 'Uninstall tool-installed dependency')) {
      $process = Start-Process -FilePath $installer -ArgumentList 'uninstall' -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "Docker Desktop uninstaller failed with exit code $($process.ExitCode)." }
    }
  }
  if ($DependencyRecord.node_installed_by_tool) {
    Confirm-Operation -Message "Node.js $nodeVersion was installed by this tool. Remove it?" -Accepted:$AcceptInstall
    if ($PSCmdlet.ShouldProcess("Node.js $nodeVersion", 'Uninstall tool-installed dependency')) {
      $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/x', $nodeProductCode, '/qn', '/norestart' -Verb RunAs -Wait -PassThru
      if ($process.ExitCode -notin @(0, 1605, 3010)) { throw "Node.js uninstaller failed with exit code $($process.ExitCode)." }
    }
  }
}

function Uninstall-Environment {
  param([string]$Root, [psobject]$State, [psobject]$Receipt)

  if ($null -eq $State -and $null -eq $Receipt) { throw 'No managed environment or tool-installed dependency receipt exists.' }
  $dependencyRecord = [pscustomobject]@{
    docker_installed_by_tool = [bool](($null -ne $State -and $State.docker_installed_by_tool) -or
      ($null -ne $Receipt -and $Receipt.docker_installed_by_tool))
    node_installed_by_tool = [bool](($null -ne $State -and $State.node_installed_by_tool) -or
      ($null -ne $Receipt -and $Receipt.node_installed_by_tool))
  }
  if ($null -eq $State) {
    Remove-ToolInstalledDependencies -DependencyRecord $dependencyRecord -ImageRequested $null
    if ($RemoveManagedDependencies) { Remove-DependencyReceipt -Root $Root }
    return [pscustomobject]@{ Status = 'NoDatabaseEnvironment'; BackupRequired = $false; DependenciesRemoved = [bool]$RemoveManagedDependencies }
  }
  if (-not (Test-DockerEngine)) { throw 'Docker must be running before managed resources can be backed up or removed.' }
  $hasContainer = Test-DockerObject -Kind container -Name $containerName
  $hasVolume = Test-DockerObject -Kind volume -Name $volumeName
  if ($hasContainer) { Assert-ManagedDockerObject -Kind container -Name $containerName }
  if ($hasVolume) { Assert-ManagedDockerObject -Kind volume -Name $volumeName }
  if ($hasVolume) {
    if ($DiscardData) { Assert-ExplicitDataLoss }
    else {
      if (-not $hasContainer) {
        Ensure-ManagedContainerRunning -Root $Root -State $State -AllowRecreate
        $hasContainer = $true
      }
      $backup = Backup-Database -Root $Root -State $State -RequestedDirectory $BackupDirectory
      Write-Output "Backup completed: $($backup.BackupFile)"
      Write-Output "Backup manifest: $($backup.ManifestFile)"
    }
  }
  if ($hasContainer -and $PSCmdlet.ShouldProcess($containerName, 'Remove managed PostgreSQL container')) {
    Invoke-External -Description 'Managed container removal' -Operation { docker container rm --force $containerName | Out-Null }
  }
  if ($hasVolume -and $PSCmdlet.ShouldProcess($volumeName, 'Remove managed PostgreSQL data volume')) {
    Invoke-External -Description 'Managed volume removal' -Operation { docker volume rm $volumeName | Out-Null }
  }
  if (Test-DockerEngine) {
    & docker image rm $State.image_requested 2>$null | Out-Null
  }
  Remove-ToolInstalledDependencies -DependencyRecord $dependencyRecord -ImageRequested $State.image_requested
  Remove-ManagedFiles -Root $Root
  if ($RemoveManagedDependencies) { Remove-DependencyReceipt -Root $Root }
  else { Save-DependencyReceipt -Root $Root -NodeInstalledByTool $dependencyRecord.node_installed_by_tool -DockerInstalledByTool $dependencyRecord.docker_installed_by_tool }
  [pscustomobject]@{ Status = 'Uninstalled'; BackupRequired = $hasVolume; DependenciesRemoved = [bool]$RemoveManagedDependencies }
}

function Get-EnvironmentStatus {
  param([string]$Root)

  $node = Get-ToolVersion -Name 'node' -Operation { node --version }
  $npm = Get-ToolVersion -Name 'npm' -Operation { npm --version }
  $winget = Get-ToolVersion -Name 'winget' -Operation { winget --version }
  $dockerCli = Get-ToolVersion -Name 'docker' -Operation { docker --version }
  $dockerReady = Test-DockerEngine
  $wslReady = Test-WslReady
  $virtualization = Get-VirtualizationStatus
  $state = Read-State -Root $Root
  $container = $false
  $volume = $false
  $health = 'unavailable'
  if ($dockerReady) {
    $container = Test-DockerObject -Kind container -Name $containerName
    $volume = Test-DockerObject -Kind volume -Name $volumeName
    if ($container) { $health = "$(docker inspect --format '{{.State.Health.Status}}' $containerName 2>$null)".Trim() }
  }
  [pscustomobject]@{
    Status = if ($null -eq $state) { 'NotInstalled' } else { $state.status }
    StateRoot = $Root
    Node = if ($null -eq $node) { 'missing' } else { $node }
    Npm = if ($null -eq $npm) { 'missing' } else { $npm }
    WinGet = if ($null -eq $winget) { 'missing (official-download fallback available)' } else { $winget }
    DockerCli = if ($null -eq $dockerCli) { 'missing' } else { $dockerCli }
    DockerEngineReady = $dockerReady
    Wsl2Ready = $wslReady
    FirmwareVirtualization = if ($null -eq $virtualization) { 'unknown' } else { $virtualization }
    ManagedContainer = $container
    ManagedVolume = $volume
    ContainerHealth = $health
    RequiredNode = "v$nodeVersion"
    RequiredNpm = $npmVersion
    RequiredImage = $PgvectorImage
  }
}

if (-not (Test-WindowsPlatform)) { throw 'The automated environment manager supports Windows only.' }
if ($env:PROCESSOR_ARCHITECTURE -cne 'AMD64') { throw 'The automated environment manager currently supports Windows x64 only.' }
if ($BackupDirectory -and $DiscardData) { throw 'BackupDirectory and DiscardData cannot be used together.' }
$resolvedStateRoot = Resolve-SafeRoot -Requested $StateRoot

switch ($Action) {
  'Status' { Get-EnvironmentStatus -Root $resolvedStateRoot }
  'Install' {
    if ($WhatIfPreference) {
      Write-Output 'WhatIf: would detect/install dependencies, create the fixed loopback database, and run verification.'
      break
    }
    $receipt = Read-DependencyReceipt -Root $resolvedStateRoot
    $nodeManaged = [bool]($null -ne $receipt -and $receipt.node_installed_by_tool)
    $dockerManaged = [bool]($null -ne $receipt -and $receipt.docker_installed_by_tool)
    if (Install-NodeIfMissing -Root $resolvedStateRoot -DockerInstalledByTool $dockerManaged) {
      $nodeManaged = $true
    }
    if (Install-DockerIfMissing -Root $resolvedStateRoot -NodeInstalledByTool $nodeManaged) {
      $dockerManaged = $true
    }
    $state = Install-DatabaseEnvironment -Root $resolvedStateRoot -DockerInstalledByTool $dockerManaged -NodeInstalledByTool $nodeManaged
    if ($null -ne $state -and -not $SkipVerification) { Invoke-EnvironmentVerification -Root $resolvedStateRoot -State $state }
    elseif ($null -ne $state) { Get-EnvironmentStatus -Root $resolvedStateRoot }
  }
  'Verify' {
    if ($WhatIfPreference) { Write-Output 'WhatIf: would run destructive test-database migration verification and the non-mutating runtime harness.'; break }
    Invoke-EnvironmentVerification -Root $resolvedStateRoot -State (Read-State -Root $resolvedStateRoot)
  }
  'Backup' {
    if ($WhatIfPreference) { Write-Output 'WhatIf: would create and validate a pg_dump backup.'; break }
    Backup-Database -Root $resolvedStateRoot -State (Read-State -Root $resolvedStateRoot) -RequestedDirectory $BackupDirectory
  }
  'Uninstall' {
    if ($WhatIfPreference) { Write-Output 'WhatIf: would require backup or explicit data loss, then remove only managed resources.'; break }
    Uninstall-Environment -Root $resolvedStateRoot -State (Read-State -Root $resolvedStateRoot) -Receipt (Read-DependencyReceipt -Root $resolvedStateRoot)
  }
}
