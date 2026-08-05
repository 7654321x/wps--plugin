param(
  [Parameter(Position = 0)]
  [ValidateSet("prepare", "status", "stop", "reset")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"

function Test-PortClosed([int]$Port) {
  return $null -eq (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-ProcessMissing([string]$Name) {
  return $null -eq (Get-Process -Name $Name -ErrorAction SilentlyContinue)
}

function Read-CurrentRuntime {
  if (-not (Test-Path -LiteralPath $current)) {
    return $null
  }
  return Get-Content -LiteralPath $current -Raw | ConvertFrom-Json
}

if ($Action -eq "prepare") {
  Push-Location $root
  try {
    & npm run build:local-runtime
    if ($LASTEXITCODE) { throw "LOCAL_RUNTIME_BUILD_FAILED" }
    & npm run install:local-runtime
    if ($LASTEXITCODE) { throw "LOCAL_RUNTIME_INSTALL_FAILED" }
    & npm run build:classified
    if ($LASTEXITCODE) { throw "CLASSIFIED_BUILD_FAILED" }
    & npm run verify:addin -- classified-offline
    if ($LASTEXITCODE) { throw "ADDIN_VERIFY_FAILED" }
    & npm run verify:local-direct
    if ($LASTEXITCODE) { throw "VERIFY_LOCAL_DIRECT_FAILED" }
  } finally {
    Pop-Location
  }
}

if ($Action -eq "stop") {
  Write-Output "plugin_asset_host: DEVELOPMENT_ONLY"
  Write-Output "business_local_server: NOT_USED"
  exit 0
}

if ($Action -eq "reset") {
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot "remove-local-runtime.ps1") -Current
  if ($LASTEXITCODE) { throw "LOCAL_RUNTIME_RESET_FAILED" }
  Write-Output "LOCAL_RUNTIME_RESET_PASS"
  exit 0
}

$runtime = Read-CurrentRuntime
Write-Output ("repository_head: " + (& git -C $root rev-parse --short HEAD))
Write-Output ("plugin_build: " + ($(if (Test-Path -LiteralPath (Join-Path $root "apps\classified-offline\dist")) { "READY" } else { "MISSING" })))
Write-Output ("plugin_registration: " + "WPSJS_DEBUG")
Write-Output ("local_runtime: " + ($(if ($runtime) { "READY" } else { "MISSING" })))
Write-Output ("local_runtime_version: " + ($(if ($runtime) { [string]$runtime.runtime_version } else { "" })))
Write-Output ("runtime_hash: " + ($(if ($runtime) { [string]$runtime.executable_sha256 } else { "" })))
Write-Output ("runtime_executable_exists: " + ($(if ($runtime -and (Test-Path -LiteralPath ([string]$runtime.executable_path))) { "YES" } else { "NO" })))
Write-Output ("local_agent: " + ($(if (Test-ProcessMissing "docxtool-local-agent") { "NOT_USED" } else { "UNEXPECTED_RUNNING" })))
Write-Output ("command_service: " + ($(if (Test-ProcessMissing "docxtool-command-service") { "NOT_USED" } else { "UNEXPECTED_RUNNING" })))
Write-Output ("port_9528: " + ($(if (Test-PortClosed 9528) { "CLOSED" } else { "LISTENING" })))
Write-Output "taskpane_mode: OPTIONAL"
Write-Output "production_recognition_transport: LOCAL_PROCESS"
Write-Output "production_command_generator: LOCAL_TYPESCRIPT"
