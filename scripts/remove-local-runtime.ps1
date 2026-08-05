param(
  [switch]$Current,
  [switch]$All,
  [string]$Version
)

$ErrorActionPreference = "Stop"
$runtimeRoot = Join-Path $env:APPDATA "Docxtool\runtime"
$currentPath = Join-Path $runtimeRoot "current.json"

function Remove-VersionDirectory([string]$runtimeVersion) {
  if (-not $runtimeVersion) { return }
  $targetDir = Join-Path $runtimeRoot $runtimeVersion
  if (Test-Path -LiteralPath $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
  }
}

if ($All) {
  if (Test-Path -LiteralPath $runtimeRoot) {
    Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -ne "logs") {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
      }
    }
  }
  if (Test-Path -LiteralPath $currentPath) {
    Remove-Item -LiteralPath $currentPath -Force
  }
  Write-Output "LOCAL_RUNTIME_ALL_REMOVED"
  exit 0
}

if ($Version) {
  Remove-VersionDirectory $Version
  Write-Output "LOCAL_RUNTIME_VERSION_REMOVED $Version"
  exit 0
}

if (Test-Path -LiteralPath $currentPath) {
  $current = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
  if ($current.runtime_version) {
    Remove-VersionDirectory ([string]$current.runtime_version)
  }
  Remove-Item -LiteralPath $currentPath -Force
}
Write-Output "LOCAL_RUNTIME_CURRENT_REMOVED"
