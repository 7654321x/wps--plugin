param(
  [string]$RuntimeVersion = "local-direct"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $root "dist\local-runtime\win-x64\docxtool-recognize.exe"
if (-not (Test-Path -LiteralPath $source)) {
  throw "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND: 未找到本地识别 exe，不能安装本地直连 runtime。"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
$targetDir = Join-Path $env:APPDATA "Docxtool\runtime\$RuntimeVersion"
$target = Join-Path $targetDir "docxtool-recognize.exe"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
if ($targetHash -ne $hash) { throw "LOCAL_RUNTIME_SHA256_MISMATCH" }

$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $current) | Out-Null
@{
  schema_version = 1
  runtime_version = $RuntimeVersion
  executable_path = $target
  sha256 = $hash
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $current -Encoding UTF8

Write-Output "LOCAL_RUNTIME_INSTALLED $target"
