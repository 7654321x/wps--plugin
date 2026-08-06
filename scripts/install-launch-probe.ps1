param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\dist\local-runtime\win-x64\docxtool-launch-probe.exe")
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path $SourcePath).Path
$targetDir = Join-Path $env:APPDATA "Docxtool\launch-probe"
$target = Join-Path $targetDir "docxtool-launch-probe.exe"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
Write-Output "LAUNCH_PROBE_INSTALL_PASS"
Write-Output ("executable: " + $target)
Write-Output ("sha256: " + $hash)
