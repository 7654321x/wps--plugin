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
if ($manifest.broker_executable -ne "docxtool-job-broker.exe" -or $manifest.broker_contract_version -ne 1) {
  throw "LOCAL_RUNTIME_MANIFEST_INVALID: Broker 清单字段不完整。"
}

$sourceDir = Split-Path -Parent $manifestPath
$source = Join-Path $sourceDir $manifest.executable
$brokerSource = Join-Path $sourceDir $manifest.broker_executable
if (-not (Test-Path -LiteralPath $source)) {
  throw "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND: 未找到本地识别 exe，不能安装本地直连 runtime。"
}
if (-not (Test-Path -LiteralPath $brokerSource)) {
  throw "LOCAL_JOB_BROKER_NOT_FOUND: 未找到本地任务 Broker。"
}

# A running PyInstaller one-file Broker keeps its installed image locked.
# Stop only the exact path recorded by the previous trusted current.json;
# unknown processes are never touched.
$previousCurrent = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
if (Test-Path -LiteralPath $previousCurrent) {
  try {
    $previous = Get-Content -LiteralPath $previousCurrent -Raw | ConvertFrom-Json
    $previousBroker = [string]$previous.broker_executable_path
    if ($previousBroker) {
      Get-CimInstance Win32_Process -Filter "Name='docxtool-job-broker.exe'" | Where-Object { [string]$_.ExecutablePath -eq $previousBroker } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $locked = Get-CimInstance Win32_Process -Filter "Name='docxtool-job-broker.exe'" | Where-Object { [string]$_.ExecutablePath -eq $previousBroker }
        if (-not $locked) { break }
        Start-Sleep -Milliseconds 100
      }
    }
  } catch {
    # A stale or unreadable status file must not broaden the process stop scope.
  }
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
$brokerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $brokerSource).Hash.ToLowerInvariant()
if ($hash -ne [string]$manifest.executable_sha256) {
  throw "LOCAL_RUNTIME_SHA256_MISMATCH: 构建产物校验失败。"
}
if ($brokerHash -ne [string]$manifest.broker_sha256) {
  throw "LOCAL_JOB_BROKER_SHA256_MISMATCH: Broker 构建产物校验失败。"
}

$runtimeVersion = [string]$manifest.runtime_version
if (-not $runtimeVersion) {
  throw "LOCAL_RUNTIME_MANIFEST_INVALID: runtime_version 不能为空。"
}

$targetDir = Join-Path $env:APPDATA "Docxtool\runtime\$runtimeVersion"
$target = Join-Path $targetDir $manifest.executable
$brokerTarget = Join-Path $targetDir $manifest.broker_executable
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Copy-Item -LiteralPath $brokerSource -Destination $brokerTarget -Force
$targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
if ($targetHash -ne $hash) {
  throw "LOCAL_RUNTIME_SHA256_MISMATCH: 安装后文件校验失败。"
}
$brokerTargetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $brokerTarget).Hash.ToLowerInvariant()
if ($brokerTargetHash -ne $brokerHash) {
  throw "LOCAL_JOB_BROKER_SHA256_MISMATCH: Broker 安装后文件校验失败。"
}

$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $current) | Out-Null
$currentPayload = @{
  schema_version = 1
  contract_version = 1
  runtime_version = $runtimeVersion
  executable_path = $target
  executable_sha256 = $hash
  broker_executable_path = $brokerTarget
  broker_sha256 = $brokerHash
  broker_contract_version = [int]$manifest.broker_contract_version
  broker_version = [string]$manifest.broker_version
  jobs_path = (Join-Path $env:APPDATA "Docxtool\jobs")
  broker_status_path = (Join-Path $env:APPDATA "Docxtool\broker\status.json")
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
