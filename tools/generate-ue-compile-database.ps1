[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$EngineRoot,

  [Parameter(Mandatory = $true)]
  [string]$ProjectFile,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,127}$')]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [ValidateSet('Debug', 'DebugGame', 'Development', 'Shipping', 'Test')]
  [string]$Configuration,

  [Parameter(Mandatory = $true)]
  [string]$OutputFile,

  [Parameter(Mandatory = $true)]
  [switch]$TemporarilyDisableInstalledBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-RequiredPath([string]$Value, [string]$Name) {
  if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw "$Name must be absolute" }
  try { return (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path }
  catch { throw "$Name does not exist" }
}

function Assert-Below([string]$Root, [string]$Value, [string]$Name) {
  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  $normalizedValue = [System.IO.Path]::GetFullPath($Value)
  if (-not $normalizedValue.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must remain below its configured root"
  }
}

if (-not $TemporarilyDisableInstalledBuild) { throw 'TemporarilyDisableInstalledBuild must be explicitly selected' }
$resolvedEngine = Resolve-RequiredPath $EngineRoot 'EngineRoot'
$resolvedProject = Resolve-RequiredPath $ProjectFile 'ProjectFile'
if ([System.IO.Path]::GetExtension($resolvedProject) -ne '.uproject') { throw 'ProjectFile must be a uproject' }
$projectRoot = [System.IO.Path]::GetDirectoryName($resolvedProject)

if ($OutputFile -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'OutputFile must be absolute' }
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputFile)
if ([System.IO.Path]::GetFileName($resolvedOutput) -ne 'compile_commands.json') { throw 'OutputFile name must be compile_commands.json' }
Assert-Below $projectRoot $resolvedOutput 'OutputFile'

$ubt = Resolve-RequiredPath (Join-Path $resolvedEngine 'Binaries\DotNET\UnrealBuildTool\UnrealBuildTool.exe') 'UnrealBuildTool'
$marker = Resolve-RequiredPath (Join-Path $resolvedEngine 'Build\InstalledBuild.txt') 'InstalledBuild marker'
Assert-Below $resolvedEngine $ubt 'UnrealBuildTool'
Assert-Below $resolvedEngine $marker 'InstalledBuild marker'
$backup = "$marker.ue-codebase-mcp-backup"
if (Test-Path -LiteralPath $backup) { throw 'InstalledBuild backup already exists; manual recovery is required' }

$arguments = @(
  '-Mode=GenerateClangDatabase',
  "-Project=$resolvedProject",
  $Target,
  'Win64',
  $Configuration,
  "-OutputDir=$([System.IO.Path]::GetDirectoryName($resolvedOutput))",
  '-OutputFilename=compile_commands.json',
  '-NoExecCodeGenActions',
  '-NoMutex',
  '-Unattended'
)

if (-not $PSCmdlet.ShouldProcess($resolvedOutput, 'Temporarily disable Installed Build semantics and generate the UE compile database')) { return }
New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolvedOutput)) -Force | Out-Null
$beforeHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
Move-Item -LiteralPath $marker -Destination $backup
$exitCode = -1
try {
  & $ubt $arguments
  $exitCode = $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $marker) {
    throw 'InstalledBuild marker was unexpectedly recreated; the original remains in the adjacent backup file'
  }
  Move-Item -LiteralPath $backup -Destination $marker
}

$afterHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
if ($beforeHash -ne $afterHash) { throw 'InstalledBuild marker restoration hash mismatch' }
if ($exitCode -ne 0) { throw "UnrealBuildTool failed with exit code $exitCode after marker restoration" }
Write-Output "compile database generated; InstalledBuild marker restored with SHA256 $afterHash"
