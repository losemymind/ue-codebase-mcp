[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$StateRoot,
  [string]$BackupDirectory,
  [switch]$DiscardData,
  [switch]$AcceptDataLoss,
  [switch]$RemoveManagedDependencies,
  [switch]$AcceptInstall,
  [switch]$NonInteractive
)

$manager = Join-Path $PSScriptRoot 'manage-environment.ps1'
& $manager -Action Uninstall @PSBoundParameters
