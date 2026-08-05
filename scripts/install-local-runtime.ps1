param(
  [string]$BuildManifestPath = (Join-Path $PSScriptRoot "..\dist\local-runtime\win-x64\runtime-manifest.json")
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = (Resolve-Path $BuildManifestPath).Path
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema_version -ne 1 -or $manifest.contract_version -ne 1) {
  throw "LOCAL_RUNTIME_MANIFEST_INVALID: 本地识别 runtime 清单版本不正确。"
}
if ($manifest.platform -ne "win-x64" -or $manifest.executable -ne "docxtool-recognize.exe") {
  throw "LOCAL_RUNTIME_MANIFEST_INVALID: 本地识别 runtime 清单平台或可执行文件不正确。"
}

$sourceDir = Split-Path -Parent $manifestPath
$source = Join-Path $sourceDir $manifest.executable
if (-not (Test-Path -LiteralPath $source)) {
  throw "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND: 未找到本地识别 exe，不能安装本地直连 runtime。"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
if ($hash -ne [string]$manifest.executable_sha256) {
  throw "LOCAL_RUNTIME_SHA256_MISMATCH: 构建产物校验失败。"
}

$runtimeVersion = [string]$manifest.runtime_version
if (-not $runtimeVersion) {
  throw "LOCAL_RUNTIME_MANIFEST_INVALID: runtime_version 不能为空。"
}

$targetDir = Join-Path $env:APPDATA "Docxtool\runtime\$runtimeVersion"
$target = Join-Path $targetDir $manifest.executable
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
if ($targetHash -ne $hash) {
  throw "LOCAL_RUNTIME_SHA256_MISMATCH: 安装后文件校验失败。"
}

$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $current) | Out-Null
$currentPayload = @{
  schema_version = 1
  contract_version = 1
  runtime_version = $runtimeVersion
  executable_path = $target
  executable_sha256 = $hash
  recognition_package_version = [string]$manifest.recognition_package_version
  manifest_path = $manifestPath
  diagnostic_log_path = (Join-Path $root "wps-plugin-debug.log")
  installed_at = (Get-Date).ToUniversalTime().ToString("o")
}
$currentPayload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $current -Encoding utf8NoBOM

Write-Output "LOCAL_RUNTIME_INSTALL_PASS"
Write-Output ("runtime_version: " + $runtimeVersion)
Write-Output ("executable: " + $target)
Write-Output ("sha256: " + $hash)
