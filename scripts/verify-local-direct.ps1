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
    "local-runtime/contract.py",
    "scripts/build-local-recognition-runtime.ps1",
    "scripts/install-local-runtime.ps1",
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
  $manifestPath = Join-Path $distRoot "runtime-manifest.json"
  $currentPath = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
  if (-not (Test-Path -LiteralPath $exe)) { throw "LOCAL_RUNTIME_EXE_MISSING" }
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw "LOCAL_RUNTIME_MANIFEST_MISSING" }
  if (-not (Test-Path -LiteralPath $currentPath)) { throw "LOCAL_RUNTIME_CURRENT_MISSING" }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $current = Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json
  if ($manifest.schema_version -ne 1 -or $manifest.contract_version -ne 1) { throw "LOCAL_RUNTIME_MANIFEST_INVALID" }
  if ($current.schema_version -ne 1 -or $current.contract_version -ne 1) { throw "LOCAL_RUNTIME_CURRENT_INVALID" }
  $installedExe = [string]$current.executable_path
  if (-not (Test-Path -LiteralPath $installedExe)) { throw "LOCAL_RUNTIME_CURRENT_PATH_MISSING" }
  if ([string]$installedExe -notmatch [regex]::Escape($env:APPDATA)) { throw "LOCAL_RUNTIME_CURRENT_PATH_MISMATCH" }
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
  if ($hash -ne [string]$manifest.executable_sha256 -or $hash -ne [string]$current.executable_sha256) { throw "LOCAL_RUNTIME_SHA256_MISMATCH" }
  if ([string]$manifest.recognition_package_version -ne [string]$current.recognition_package_version) { throw "LOCAL_RUNTIME_PACKAGE_VERSION_MISMATCH" }

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
