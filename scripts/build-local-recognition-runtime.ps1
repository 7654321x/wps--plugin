param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root "dist\local-runtime\win-x64\docxtool-recognize.exe"

if (Test-Path -LiteralPath $runtime) {
  Write-Output "LOCAL_RUNTIME_READY $runtime"
  exit 0
}

throw "LOCAL_RECOGNITION_RUNTIME_BUILD_NOT_CONFIGURED: 未找到 dist\local-runtime\win-x64\docxtool-recognize.exe。本地直连禁止回退到 9528，请先提供或构建 docxtool-recognize.exe。"
