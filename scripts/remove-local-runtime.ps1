param()

$ErrorActionPreference = "Stop"
$current = Join-Path $env:APPDATA "Docxtool\runtime\current.json"
if (Test-Path -LiteralPath $current) {
  Remove-Item -LiteralPath $current -Force
}
Write-Output "LOCAL_RUNTIME_CURRENT_REMOVED"
