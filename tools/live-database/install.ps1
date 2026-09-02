[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$StateRoot,
  [ValidateRange(1024, 65535)][int]$HostPort = 55432,
  [ValidatePattern('^pgvector/pgvector:[0-9]+\.[0-9]+\.[0-9]+-pg17(?:-(?:bookworm|trixie))?$')]
  [string]$PgvectorImage = 'pgvector/pgvector:0.8.6-pg17',
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedImageDigest,
  [switch]$AcceptInstall,
  [switch]$SkipVerification,
  [switch]$NonInteractive
)

$manager = Join-Path $PSScriptRoot 'manage-environment.ps1'
& $manager -Action Install @PSBoundParameters
