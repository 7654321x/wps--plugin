param(
  [Parameter(Position = 0)]
  [ValidateSet("prepare", "status", "stop")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Test-PortClosed([int]$Port) {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -eq $connection
}

function Test-ProcessMissing([string]$Name) {
  return $null -eq (Get-Process -Name $Name -ErrorAction SilentlyContinue)
}

if ($Action -eq "prepare") {
  Push-Location $root
  try {
    & npm run build:classified
    if ($LASTEXITCODE) { throw "CLASSIFIED_BUILD_FAILED" }
    & npm run verify:addin -- classified-offline
    if ($LASTEXITCODE) { throw "ADDIN_VERIFY_FAILED" }
  } finally {
    Pop-Location
  }
}

if ($Action -eq "stop") {
  Write-Output "local_agent: NOT_USED"
  Write-Output "command_service: NOT_USED"
}

$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
Write-Output ("local_runtime: " + ($(if (Test-Path -LiteralPath $current) { "READY" } else { "MISSING" })))
Write-Output ("local_agent: " + ($(if (Test-ProcessMissing "docxtool-local-agent") { "NOT_USED" } else { "RUNNING" })))
Write-Output ("command_service: " + ($(if (Test-ProcessMissing "docxtool-command-service") { "NOT_USED" } else { "RUNNING" })))
Write-Output ("port_9528: " + ($(if (Test-PortClosed 9528) { "CLOSED" } else { "LISTENING" })))
