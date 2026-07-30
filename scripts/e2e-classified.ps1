param([ValidateSet("prepare", "status", "stop", "report")][string]$Action = "status")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime\e2e"
$python = Join-Path $root "..\.venv\Scripts\python.exe"
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$staticPort = 3890; $agentPort = 9528; $commandPort = 9529

function Test-Health([int]$Port) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/v1/health").StatusCode -eq 200 } catch { return $false }
}
function Test-Static {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$staticPort/index.html").StatusCode -eq 200 } catch { return $false }
}
function Get-Session {
  $path = Join-Path $runtime "current.json"
  if (Test-Path -LiteralPath $path) { return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
  return $null
}
function Show-Status {
  $session = Get-Session
  $registered = $false
  $publish = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
  if (Test-Path -LiteralPath $publish) { $registered = (Get-Content -Raw -LiteralPath $publish) -match 'name="docxtool-classified-offline"' }
  [pscustomobject]@{
    static_resources = if (Test-Static) { "PASS" } else { "FAIL" }
    local_agent = if (Test-Health $agentPort) { "PASS" } else { "FAIL" }
    command_service = if (Test-Health $commandPort) { "PASS" } else { "FAIL" }
    debug_registration = if ($registered) { "PASS" } else { "FAIL" }
    session_id = if ($session) { $session.session_id } else { "" }
    host_reported = if ($session -and $session.test_results.PSObject.Properties.Count -gt 0) { "YES" } else { "NO" }
    overall_status = if ($session) { $session.overall_status } else { "REAL_WPS_E2E_NOT_RUN" }
  } | Format-List
}
function Start-Managed([string]$Name, [string]$FilePath, [string[]]$Arguments) {
  $logs = Join-Path $runtime "logs"; New-Item -ItemType Directory -Force -Path $logs | Out-Null
  Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "$Name.out.log") -RedirectStandardError (Join-Path $logs "$Name.err.log") -PassThru
}

if ($Action -eq "prepare") {
  if (-not (Test-Path -LiteralPath $python)) { throw "E2E_PYTHON_NOT_FOUND" }
  & $python --version | Out-Null; & node --version | Out-Null; & $npm exec -- wpsjs --version | Out-Null
  & $npm run build | Out-Null; & $npm run build:classified | Out-Null; & $npm run verify:addin -- classified-offline | Out-Null
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  & $python (Join-Path $root "scripts\generate-e2e-fixture.py")
  $sessionId = [Guid]::NewGuid().ToString("N")
  $sessionDirectory = Join-Path $runtime $sessionId; New-Item -ItemType Directory -Force -Path $sessionDirectory | Out-Null
  $fixture = Join-Path $root "tests\fixtures\wps-e2e-baseline.docx"; $workDirectory = Join-Path $root "tests\e2e-work"; New-Item -ItemType Directory -Force -Path $workDirectory | Out-Null; $working = Join-Path $workDirectory ("test-working-copy-" + $sessionId + ".docx")
  Copy-Item -LiteralPath $fixture -Destination $working -Force
  $metadata = [ordered]@{ session_id=$sessionId; working_file=""; working_project_relative=("tests/e2e-work/" + [IO.Path]::GetFileName($working)); working_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $working).Hash.ToLower(); fixture_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash.ToLower(); is_fixture_baseline=$false }
  $metadata | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $sessionDirectory "test-document.json")
  $session = [ordered]@{ session_id=$sessionId; edition="classified-offline"; plugin_version="0.1.0"; wps_version=""; started_at=(Get-Date).ToUniversalTime().ToString("o"); completed_at=""; current_stage="bootstrap_started"; test_results=[ordered]@{}; stable_errors=@(); overall_status="REAL_WPS_E2E_NOT_RUN" }
  $session | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $runtime "current.json")
  $env:PYTHONPATH = "$root\local-agent\src;$root\command-service\src;$root\..\src"
  $token = [Guid]::NewGuid().ToString("N")
  $processes = @()
  if (-not (Test-Static)) { $processes += [pscustomobject]@{ name="static"; pid=(Start-Managed "static" $npm @("--prefix", "apps/classified-offline", "run", "dev")).Id } }
  if (-not (Test-Health $agentPort)) { $processes += [pscustomobject]@{ name="local-agent"; pid=(Start-Managed "local-agent" $python @("-m", "docxtool_local_agent", "--port", "$agentPort", "--session-token", $token, "--e2e-runtime", $runtime, "--command-endpoint", "http://127.0.0.1:$commandPort")).Id } }
  if (-not (Test-Health $commandPort)) { $processes += [pscustomobject]@{ name="command-service"; pid=(Start-Managed "command-service" $python @("-m", "docxtool_command_service", "--mode", "local", "--port", "$commandPort", "--session-token", $token)).Id } }
  $processes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runtime "processes.json")
  for ($i = 0; $i -lt 15 -and (-not ((Test-Static) -and (Test-Health $agentPort) -and (Test-Health $commandPort))); $i++) { Start-Sleep -Milliseconds 500 }
  Show-Status
  Write-Output "E2E_SESSION_READY $sessionId"
  Write-Output "NEXT: close all WPS windows, reopen WPS Writer, open the generated working copy from this session folder, then use Docxtool 涉密离线版 > 打开任务窗格 > 开发验证。"
  exit
}
if ($Action -eq "stop") {
  $path = Join-Path $runtime "processes.json"
  if (Test-Path -LiteralPath $path) {
    $items = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    foreach ($item in @($items)) { $process = Get-Process -Id $item.pid -ErrorAction SilentlyContinue; if ($process) { Stop-Process -Id $item.pid -ErrorAction Stop } }
    Remove-Item -LiteralPath $path -Force
  }
  Write-Output "E2E_STOPPED"
  exit
}
if ($Action -eq "report") {
  $session = Get-Session
  if (-not $session) { Write-Output "REAL_WPS_E2E_NOT_RUN"; exit }
  [pscustomobject]@{ wps_version=$session.wps_version; plugin_version=$session.plugin_version; ribbon=$session.test_results.ribbon.status; taskpane=$session.test_results.taskpane.status; runtime_probe=$session.test_results.runtime_probe.status; active_document=$session.test_results.active_document.status; local_agent=$session.test_results.local_agent.status; command_service=$session.test_results.command_service.status; target_locator=$session.test_results.target_locator.status; revision=$session.test_results.revision.status; rollback=$session.test_results.rollback.status; overall_status=$session.overall_status } | Format-List
  if ($session.diagnostics) {
    $first = @($session.diagnostics | Where-Object { $_.status -eq "FAIL" } | Select-Object -First 1)
    if ($first.Count) { Write-Output ("FIRST_ROOT_CAUSE: " + $first[0].check_id + " / " + $first[0].error_code) }
    $session.diagnostics | Group-Object group | ForEach-Object { Write-Output ("DIAGNOSTIC_GROUP: " + $_.Name + " " + $_.Count) }
  }
  exit
}
Show-Status
