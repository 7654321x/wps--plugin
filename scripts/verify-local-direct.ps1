param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Push-Location $root
try {
  & npm run typecheck
  if ($LASTEXITCODE) { throw "TYPESCRIPT_TYPECHECK_FAILED" }

  $scanTargets = @(
    "apps/classified-offline/main.js",
    "apps/classified-offline/js/ribbon.js",
    "apps/classified-offline/src/host-runtime.ts",
    "apps/classified-offline/src/composition-root.ts",
    "apps/classified-offline/src/health-check.ts",
    "apps/classified-offline/src/error-messages.ts",
    "apps/classified-offline/src/taskpane-workflow.ts",
    "apps/classified-offline/ui/taskpane.html",
    "apps/classified-offline/ui/local-runtime-config.js",
    "apps/classified-offline/vite.config.js",
    "packages/wps-adapter/src/local-filesystem.ts",
    "local-runtime/recognize_entry.py",
    "local-runtime/job_broker.py",
    "local-runtime/contract.py",
    "scripts/build-local-recognition-runtime.ps1",
    "scripts/install-local-runtime.ps1",
    "scripts/verify-local-recognizer-smoke.py",
    "scripts/remove-local-runtime.ps1",
    "scripts/local-direct.ps1"
  )
  $forbidden = "HttpLocalRecognitionTransport|HttpCommandServiceClient|LocalEndpointProvider|sessionToken|recognitionEndpoint|commandEndpoint|127\.0\.0\.1:9528|/v1/recognize|/v1/commands|DocxtoolHostDispatch|DocxtoolHostEnqueue|HostCommandRouter|LocalCommandBus|fetch\("
  $matches = rg -n $forbidden @scanTargets
  if ($LASTEXITCODE -eq 0) { throw "LOCAL_DIRECT_FORBIDDEN_PRODUCTION_DEPENDENCY" }
  if ($LASTEXITCODE -ne 1) { throw "LOCAL_DIRECT_SCAN_FAILED" }

  $required = @(
    "LocalProcessRecognitionTransport",
    "LocalFormatCommandGenerator",
    "DocxtoolRunLocalCommand",
    "LOCAL_RUNTIME_BUILD_PASS",
    "LOCAL_RUNTIME_INSTALL_PASS",
    "runtime-manifest.json"
  )
  foreach ($needle in $required) {
    $hit = rg -n -F $needle @scanTargets
    if ($LASTEXITCODE -ne 0) { throw ("LOCAL_DIRECT_REQUIRED_TEXT_MISSING: " + $needle) }
  }

  $distRoot = Join-Path $root "dist\local-runtime\win-x64"
  $exe = Join-Path $distRoot "docxtool-recognize.exe"
  $brokerExe = Join-Path $distRoot "docxtool-job-broker.exe"
  $manifestPath = Join-Path $distRoot "runtime-manifest.json"
  $currentPath = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
  if (-not (Test-Path -LiteralPath $exe)) { throw "LOCAL_RUNTIME_EXE_MISSING" }
  if (-not (Test-Path -LiteralPath $brokerExe)) { throw "LOCAL_JOB_BROKER_EXE_MISSING" }
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "LOCAL_RUNTIME_MANIFEST_MISSING" }
  if (-not (Test-Path -LiteralPath $currentPath)) { throw "LOCAL_RUNTIME_CURRENT_MISSING" }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $current = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
  if ($manifest.schema_version -ne 1 -or $manifest.contract_version -ne 1) { throw "LOCAL_RUNTIME_MANIFEST_INVALID" }
  if ($manifest.broker_executable -ne "docxtool-job-broker.exe" -or $manifest.broker_contract_version -ne 1 -or $manifest.queue_contract_version -ne 1 -or [string]$manifest.broker_version -ne "1.3.2") { throw "LOCAL_JOB_BROKER_MANIFEST_INVALID" }
  if ($current.schema_version -ne 1 -or $current.contract_version -ne 1) { throw "LOCAL_RUNTIME_CURRENT_INVALID" }
  if ([string]::IsNullOrWhiteSpace([string]$current.broker_version) -or [string]$current.broker_version -ne [string]$manifest.broker_version -or $current.queue_contract_version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$current.broker_executable_path_hash)) { throw "LOCAL_JOB_BROKER_CURRENT_INVALID" }
  $installedExe = [string]$current.executable_path
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "LOCAL_RUNTIME_CURRENT_PATH_MISSING" }
  if ([string]$installedExe -notmatch [regex]::Escape($env:APPDATA)) { throw "LOCAL_RUNTIME_CURRENT_PATH_MISMATCH" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
  if ($hash -ne [string]$manifest.executable_sha256 -or $hash -ne [string]$current.executable_sha256) { throw "LOCAL_RUNTIME_SHA256_MISMATCH" }
  $brokerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $brokerExe).Hash.ToLowerInvariant()
  if ($brokerHash -ne [string]$manifest.broker_sha256 -or $brokerHash -ne [string]$current.broker_sha256) { throw "LOCAL_JOB_BROKER_SHA256_MISMATCH" }
  $installedBroker = [string]$current.broker_executable_path
  if (-not (Test-Path -LiteralPath $installedBroker)) { throw "LOCAL_JOB_BROKER_CURRENT_PATH_MISSING" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $installedBroker).Hash.ToLowerInvariant() -ne $brokerHash) { throw "LOCAL_JOB_BROKER_SHA256_MISMATCH" }
  $pathHashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $pathHashInput = [System.Text.Encoding]::UTF8.GetBytes($installedBroker.ToLowerInvariant().Replace('/', '\'))
    $pathHash = ([System.BitConverter]::ToString($pathHashAlgorithm.ComputeHash($pathHashInput))).Replace('-', '').ToLowerInvariant()
  } finally {
    $pathHashAlgorithm.Dispose()
  }
  if ($pathHash -ne [string]$current.broker_executable_path_hash) { throw "LOCAL_JOB_BROKER_IDENTITY_MISMATCH" }
  if ([string]$manifest.recognition_package_version -ne [string]$current.recognition_package_version) { throw "LOCAL_RUNTIME_PACKAGE_VERSION_MISMATCH" }
  $statusPath = [string]$current.broker_status_path
  if (-not (Test-Path -LiteralPath $statusPath)) { throw "LOCAL_JOB_BROKER_STATUS_MISSING" }
  $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
  if ($status.state -notin @("READY", "RUNNING") -or [int]$status.pid -le 0 -or [string]::IsNullOrWhiteSpace([string]$status.broker_instance_id) -or [string]::IsNullOrWhiteSpace([string]$status.process_created_at)) { throw "LOCAL_JOB_BROKER_IDENTITY_MISMATCH" }
  if ([string]$status.broker_version -ne [string]$current.broker_version -or [string]$status.broker_executable_path_hash -ne [string]$current.broker_executable_path_hash -or [string]$status.broker_executable_sha256 -ne [string]$current.broker_sha256 -or $status.queue_contract_version -ne [int]$current.queue_contract_version) { throw "LOCAL_JOB_BROKER_STATUS_MISMATCH" }

  $python = Join-Path $root ".venv\Scripts\python.exe"
  & $python (Join-Path $root "scripts\verify-local-recognizer-smoke.py") (Join-Path $root "tests\fixtures\wps-e2e-baseline.docx")
  if ($LASTEXITCODE) { throw "LOCAL_RECOGNIZER_SMOKE_FAILED" }

  & npm run build:classified
  if ($LASTEXITCODE) { throw "CLASSIFIED_BUILD_FAILED" }
  & npm run verify:addin -- classified-offline
  if ($LASTEXITCODE) { throw "ADDIN_VERIFY_FAILED" }

  $port = Get-NetTCPConnection -LocalPort 9528 -State Listen -ErrorAction SilentlyContinue
  if ($port) { throw "PORT_9528_LISTENING" }
  Write-Output "VERIFY_LOCAL_DIRECT_PASS"
} finally {
  Pop-Location
}
