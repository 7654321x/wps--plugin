param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$app = Join-Path $root "apps\classified-offline"
$dist = Join-Path $app "dist"
$target = Join-Path $root ".runtime\wps-debug-package"
$buildInfoPath = Join-Path $dist "ui\build-info.js"

if (-not (Test-Path -LiteralPath $dist) -or -not (Test-Path -LiteralPath $buildInfoPath)) {
  throw "WPS_DEBUG_PACKAGE_DIST_MISSING"
}

$buildInfoText = Get-Content -LiteralPath $buildInfoPath -Raw
$match = [regex]::Match($buildInfoText, '"build_id":"([^"]+)".*"asset_hash":"([a-f0-9]{64})"')
if (-not $match.Success) { throw "WPS_DEBUG_PACKAGE_BUILD_INFO_INVALID" }
$buildId = $match.Groups[1].Value
$assetHash = $match.Groups[2].Value

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $dist "*") -Destination $target -Recurse -Force

$sourcePackage = Get-Content -LiteralPath (Join-Path $app "package.json") -Raw | ConvertFrom-Json
$debugPackage = [ordered]@{
  name = [string]$sourcePackage.name
  version = [string]$sourcePackage.version
  private = $true
  addonType = "wps"
}
$debugPackage | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target "package.json") -Encoding utf8NoBOM

$critical = [ordered]@{}
foreach ($relative in @("main.js", "js/ribbon.js", "js/bootstrap-probe.js", "host-runtime.js")) {
  $file = Join-Path $target $relative
  if (-not (Test-Path -LiteralPath $file)) { throw ("WPS_DEBUG_PACKAGE_ASSET_MISSING: " + $relative) }
  $critical[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
}
$head = (& git -C $root rev-parse HEAD).Trim()
$manifest = [ordered]@{
  schema_version = 1
  source_head = $head
  build_id = $buildId
  asset_hash = $assetHash
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  source_dist = "apps/classified-offline/dist"
  critical_assets = $critical
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $target "debug-package.json") -Encoding utf8NoBOM
Write-Output "WPS_DEBUG_PACKAGE_PASS"
Write-Output ("served_root: " + $target)
Write-Output ("build_id: " + $buildId)
