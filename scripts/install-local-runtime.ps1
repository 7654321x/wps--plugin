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
      $processes = @(Get-CimInstance Win32_Process -Filter "Name='docxtool-job-broker.exe'")
      $trustedPids = [System.Collections.Generic.HashSet[int]]::new()
      $status = $null
      $statusPath = [string]$previous.broker_status_path
      if ($statusPath -and (Test-Path -LiteralPath $statusPath)) {
        try { $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch { $status = $null }
      }
      $statusCreatedAt = $null
      if ($status -and $status.process_created_at) {
        try {
          if ($status.process_created_at -is [DateTime]) {
            # ConvertFrom-Json in PowerShell 7 materializes a trailing-Z
            # timestamp as an unspecified DateTime; Broker timestamps are UTC.
            $statusCreatedAt = [DateTime]::SpecifyKind([DateTime]$status.process_created_at, [DateTimeKind]::Utc)
          } else {
            $statusCreatedAt = [DateTime]::Parse([string]$status.process_created_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
          }
        } catch { $statusCreatedAt = $null }
      }
      $pathHashMatches = $status -and [string]$status.broker_executable_path_hash -eq [string]$previous.broker_executable_path_hash
      foreach ($item in $processes) {
        $exactPath = [string]$item.ExecutablePath -eq $previousBroker
        $trustedStatusPid = $false
        if ($status -and [int]$item.ProcessId -eq [int]$status.pid -and $pathHashMatches -and $statusCreatedAt) {
          try { $trustedStatusPid = [math]::Abs(($item.CreationDate.ToUniversalTime() - $statusCreatedAt).TotalSeconds) -le 5 } catch { $trustedStatusPid = $false }
        }
        if ($exactPath -or $trustedStatusPid) { [void]$trustedPids.Add([int]$item.ProcessId) }
      }
      # PyInstaller one-file may expose a blank WMI ExecutablePath. Once the
      # status PID is trusted by path hash and creation time, include only its
      # same-name parent/children from the same launch tree.
      $changed = $true
      while ($changed) {
        $changed = $false
        foreach ($item in $processes) {
          if ([string]$item.Name -ne "docxtool-job-broker.exe") { continue }
          $parentId = [int]$item.ParentProcessId
          if ($trustedPids.Contains($parentId) -and -not $trustedPids.Contains([int]$item.ProcessId)) {
            [void]$trustedPids.Add([int]$item.ProcessId)
            $changed = $true
          }
        }
      }
      if ($status -and [int]$status.pid -gt 0) {
        $statusProcess = $processes | Where-Object { [int]$_.ProcessId -eq [int]$status.pid } | Select-Object -First 1
        if ($statusProcess) {
          $parent = $processes | Where-Object { [int]$_.ProcessId -eq [int]$statusProcess.ParentProcessId -and [string]$_.Name -eq "docxtool-job-broker.exe" } | Select-Object -First 1
          if ($parent -and $statusCreatedAt) {
            try {
              if ([math]::Abs(($parent.CreationDate.ToUniversalTime() - $statusCreatedAt).TotalSeconds) -le 5) { [void]$trustedPids.Add([int]$parent.ProcessId) }
            } catch { }
          }
        }
      }
      foreach ($processId in @($trustedPids)) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
      for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $locked = @($trustedPids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if (-not $locked) { break }
        Start-Sleep -Milliseconds 100
      }
      if (@($trustedPids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) {
        throw "LOCAL_JOB_BROKER_INSTALL_LOCKED: 受信任的旧 Broker 仍锁定安装文件。"
      }
    }
  } catch {
    if ($_.Exception.Message -like "LOCAL_JOB_BROKER_INSTALL_LOCKED*") { throw }
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
$pathHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
  $pathHashInput = [System.Text.Encoding]::UTF8.GetBytes($brokerTarget.ToLowerInvariant().Replace('/', '\'))
  $brokerPathHash = ([System.BitConverter]::ToString($pathHashAlgorithm.ComputeHash($pathHashInput))).Replace('-', '').ToLowerInvariant()
} finally {
  $pathHashAlgorithm.Dispose()
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
  queue_contract_version = [int]$manifest.queue_contract_version
  broker_version = [string]$manifest.broker_version
  broker_executable_path_hash = $brokerPathHash
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
