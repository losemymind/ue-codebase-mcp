[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$LlvmRoot,

  [Parameter(Mandatory = $true)]
  [string]$ClangCIncludeRoot,

  [Parameter(Mandatory = $true)]
  [string]$VcToolsRoot,

  [Parameter(Mandatory = $true)]
  [string]$WindowsSdkRoot,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^10\.[0-9]+\.[0-9]+\.[0-9]+$')]
  [string]$WindowsSdkVersion,

  [string]$OutputFile = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Resolve-RequiredPath([string]$Value, [string]$Name) {
  if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw "$Name must be absolute" }
  try { return (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path }
  catch { throw "$Name does not exist" }
}

function Assert-Below([string]$Root, [string]$Value, [string]$Name) {
  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  $normalizedValue = [System.IO.Path]::GetFullPath($Value)
  if (-not $normalizedValue.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Name escapes the repository" }
}

$resolvedLlvm = Resolve-RequiredPath $LlvmRoot 'LlvmRoot'
$resolvedInclude = Resolve-RequiredPath $ClangCIncludeRoot 'ClangCIncludeRoot'
$resolvedVcTools = Resolve-RequiredPath $VcToolsRoot 'VcToolsRoot'
$resolvedWindowsSdk = Resolve-RequiredPath $WindowsSdkRoot 'WindowsSdkRoot'
$compiler = Resolve-RequiredPath (Join-Path $resolvedLlvm 'bin\clang-cl.exe') 'clang-cl'
$library = Resolve-RequiredPath (Join-Path $resolvedLlvm 'lib\libclang.lib') 'libclang import library'
$header = Resolve-RequiredPath (Join-Path $resolvedInclude 'clang-c\Index.h') 'clang-c Index header'
$source = Resolve-RequiredPath (Join-Path $repositoryRoot 'workers\clang-indexer\native\cursor-indexer.cpp') 'cursor indexer source'
[void](Resolve-RequiredPath (Join-Path $resolvedVcTools 'include\yvals_core.h') 'MSVC standard library')
[void](Resolve-RequiredPath (Join-Path $resolvedWindowsSdk "Include\$WindowsSdkVersion\ucrt\corecrt.h") 'Windows SDK')

if (-not $OutputFile) { $OutputFile = Join-Path $repositoryRoot 'dist\native\clang-cursor-indexer.exe' }
if ($OutputFile -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'OutputFile must be absolute' }
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputFile)
Assert-Below $repositoryRoot $resolvedOutput 'OutputFile'
if ([System.IO.Path]::GetExtension($resolvedOutput) -ne '.exe') { throw 'OutputFile must be an exe' }

if (-not $PSCmdlet.ShouldProcess($resolvedOutput, 'Build the fixed clang cursor indexer')) { return }
New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolvedOutput)) -Force | Out-Null
& $compiler '/nologo' '/std:c++20' '/EHsc' '/W4' '/WX' '/Brepro' '/vctoolsdir' $resolvedVcTools '/winsdkdir' $resolvedWindowsSdk '/winsdkversion' $WindowsSdkVersion "/I$resolvedInclude" $source "/Fe:$resolvedOutput" '/link' '/Brepro' "/LIBPATH:$([System.IO.Path]::GetDirectoryName($library))" 'libclang.lib'
if ($LASTEXITCODE -ne 0) { throw "clang cursor indexer build failed with exit code $LASTEXITCODE" }
Write-Output "built $resolvedOutput using $header"
