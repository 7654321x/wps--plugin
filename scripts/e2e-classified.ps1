param([ValidateSet("prepare", "status", "stop", "report", "auto")][string]$Action = "status")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime\e2e"
$python = Join-Path $root "..\.venv\Scripts\python.exe"
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$staticPort = 3891; $agentPort = 9528; $commandPort = 9529

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
  if (Test-Path -LiteralPath $publish) { $registered = (Get-Content -Raw -LiteralPath $publish) -match 'name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:3891/' }
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
function Find-WpsWriter {
  # WPS forwards document-open requests to the active installation.  Picking
  # an obsolete, side-by-side office6 executable starts only its background
  # host and the generated fixture never reaches the registered add-in.
  $roots = @(
    (Join-Path ${env:ProgramFiles(x86)} "WPS Office"),
    (Join-Path $env:ProgramFiles "WPS Office"),
    "D:\Program Files (x86)\WPS Office",
    "D:\Program Files\WPS Office"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  $candidates = foreach ($rootPath in $roots) {
    Get-ChildItem -LiteralPath $rootPath -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "office6\wps.exe" } |
      Where-Object { Test-Path -LiteralPath $_ }
  }
  if ($candidates) {
    return $candidates |
      Sort-Object -Descending @{ Expression = { try { [version]((Get-Item -LiteralPath $_).VersionInfo.ProductVersion -replace '[^0-9.]', '') } catch { [version]'0.0' } } }, @{ Expression = { $_ } } |
      Select-Object -First 1
  }
  $command = Get-Command wps.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "WPS_WRITER_NOT_FOUND"
}
function Stop-ManagedPort([int]$Port) {
  Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }
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
  if (-not (Test-Health $agentPort)) { $processes += [pscustomobject]@{ name="local-agent"; pid=(Start-Managed "local-agent" $python @("-m", "docxtool_local_agent", "--port", "$agentPort", "--session-token", $token, "--e2e-runtime", $runtime, "--command-endpoint", "http://127.0.0.1:$commandPort")).Id } }
  if (-not (Test-Health $commandPort)) { $processes += [pscustomobject]@{ name="command-service"; pid=(Start-Managed "command-service" $python @("-m", "docxtool_command_service", "--mode", "local", "--port", "$commandPort", "--session-token", $token)).Id } }
  $runtimeScript = Join-Path $root "apps\classified-offline\ui\e2e-session.js"
  ('window.DocxtoolRuntimeConfig=' + (@{ recognitionEndpoint="http://127.0.0.1:$agentPort"; commandEndpoint="http://127.0.0.1:$commandPort"; sessionToken=$token } | ConvertTo-Json -Compress) + ';') | Set-Content -Encoding utf8 $runtimeScript
  $publish = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
  $registeredAtFixedPort = (Test-Path -LiteralPath $publish) -and ((Get-Content -Raw -LiteralPath $publish) -match 'name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:3891/')
  if (-not ((Test-Static) -and $registeredAtFixedPort)) {
    Stop-ManagedPort $staticPort
    $logs = Join-Path $runtime "logs"; New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $debug = Start-Process -FilePath "npx.cmd" -ArgumentList @("--no-install", "wpsjs", "debug", "-p", "$staticPort", "-s") -WorkingDirectory (Join-Path $root "apps\classified-offline") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "wpsjs.out.log") -RedirectStandardError (Join-Path $logs "wpsjs.err.log") -PassThru
    $processes += [pscustomobject]@{ name="wpsjs"; pid=$debug.Id }
  }
  $processes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runtime "processes.json")
  for ($i = 0; $i -lt 30 -and (-not ((Test-Static) -and (Test-Health $agentPort) -and (Test-Health $commandPort))); $i++) { Start-Sleep -Milliseconds 500 }
  Show-Status
  Write-Output "E2E_SESSION_READY $sessionId"
  exit
}
if ($Action -eq "auto") {
  # The E2E owns only these fixed loopback development ports. Restarting them
  # prevents a registered add-in from attaching to stale source or CORS rules.
  foreach ($port in @($staticPort, $agentPort, $commandPort)) { Stop-ManagedPort $port }
  & pwsh -NoProfile -File $PSCommandPath prepare
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  $session = Get-Session
  if (-not $session) { throw "E2E_SESSION_NOT_FOUND" }
  $metadata = Get-Content -Raw -LiteralPath (Join-Path (Join-Path $runtime $session.session_id) "test-document.json") | ConvertFrom-Json
  $working = Join-Path $root $metadata.working_project_relative
  $wps = Find-WpsWriter
  Start-Process -FilePath $wps -ArgumentList @($working) -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    $session = Get-Session
    if ($session.test_results.one_click_format) { break }
  }
  $reportDirectory = Join-Path $root ".runtime\reports"; New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
  $result = if ($session.test_results.one_click_format) { $session.test_results.one_click_format } else { @{ status="FAIL"; error_code="WPS_HOST_CALLBACK_TIMEOUT" } }
  $rollback = if ($session.test_results.rollback) { $session.test_results.rollback } else { @{ status="FAIL"; error_code="ROLLBACK_NOT_REPORTED" } }
  $before = Join-Path $root "tests\fixtures\wps-e2e-baseline.docx"
  if ($result.status -eq "PASS") {
    & $python (Join-Path $root "scripts\inspect-one-click-ooxml.py") $before --out (Join-Path $reportDirectory "one-click-before-ooxml.json")
    & $python (Join-Path $root "scripts\inspect-one-click-ooxml.py") $working --out (Join-Path $reportDirectory "one-click-ooxml.json")
    & $python (Join-Path $root "scripts\verify-one-click-format.py") $working --profile (Join-Path $root "command-service\src\docxtool_command_service\profiles\docxtool-default.json") --expectations (Join-Path $root "tests\fixtures\one-click-format-expectations.json") --out (Join-Path $reportDirectory "one-click-format-values.json")
    $formatValues = Get-Content -Raw (Join-Path $reportDirectory "one-click-format-values.json") | ConvertFrom-Json
    $beforeInfo = Get-Content -Raw (Join-Path $reportDirectory "one-click-before-ooxml.json") | ConvertFrom-Json
    $afterInfo = Get-Content -Raw (Join-Path $reportDirectory "one-click-ooxml.json") | ConvertFrom-Json
    $contentIntegrity = [ordered]@{ body_sha256_matches=($beforeInfo.body_sha256 -eq $afterInfo.body_sha256); paragraph_count_matches=($beforeInfo.paragraph_count -eq $afterInfo.paragraph_count); paragraph_order_matches=(($beforeInfo.paragraphs.text_sha256 -join ',') -eq ($afterInfo.paragraphs.text_sha256 -join ',')) }
    Copy-Item -LiteralPath $before -Destination (Join-Path $reportDirectory "01-before-format.docx") -Force
    Copy-Item -LiteralPath $before -Destination (Join-Path $reportDirectory "02-rollback-test.docx") -Force
    Copy-Item -LiteralPath $working -Destination (Join-Path $reportDirectory "03-after-one-click-format.docx") -Force
  } else { $contentIntegrity = [ordered]@{ body_sha256_matches=$false; paragraph_count_matches=$false; paragraph_order_matches=$false }; $formatValues = [ordered]@{ status="FAIL"; failures=@(@{ property="format_validation_not_run" }) } }
  $passed = $result.status -eq "PASS" -and $rollback.status -eq "PASS" -and $contentIntegrity.body_sha256_matches -and $contentIntegrity.paragraph_count_matches -and $contentIntegrity.paragraph_order_matches -and $formatValues.status -eq "PASS"
  $safe = [ordered]@{ overall_status=if ($passed) { "ONE_CLICK_FORMATTING_PASS" } else { "ONE_CLICK_FORMATTING_FAIL" }; wps_version=$session.wps_version; plugin_version=$session.plugin_version; one_click=$result; rollback=$rollback; content_integrity=$contentIntegrity; saved_format_validation=$formatValues; fixture_before=(Join-Path $runtime ($session.session_id + "\test-document.json")); after_document=(Join-Path $reportDirectory "03-after-one-click-format.docx") }
  $safe | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $reportDirectory "one-click-e2e.json")
  ("# WPS 一键排版自动验收`n`n状态：" + $safe.overall_status + "`n`n写入：" + $result.status + "`n`n回滚：" + $rollback.status + "`n`n保存后格式：" + $formatValues.status + "`n`n正文哈希：" + $contentIntegrity.body_sha256_matches + "`n`n段落顺序：" + $contentIntegrity.paragraph_order_matches + "`n`n错误码：" + $result.error_code) | Set-Content -Encoding utf8 (Join-Path $reportDirectory "one-click-e2e.md")
  if (-not $passed) { throw $(if ($result.status -ne "PASS") { $result.error_code } elseif ($rollback.status -ne "PASS") { $rollback.error_code } elseif ($formatValues.status -ne "PASS") { "SAVED_DOCX_FORMAT_MISMATCH" } else { "SAVED_DOCX_CONTENT_MISMATCH" }) }
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
