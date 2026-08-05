param([ValidateSet("prepare", "status", "stop", "report", "auto")][string]$Action = "status")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime\e2e"
$diagnosticLog = Join-Path $root "wps-plugin-debug.log"
$python = Join-Path $root ".venv\Scripts\python.exe"
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$staticPort = 3889; $agentPort = 9528; $remoteDebugPort = 9222
$script:DiagnosticToken = ""
$script:PendingDiagnosticEvents = @()

function Flush-DiagnosticEvents {
  if ([string]::IsNullOrWhiteSpace($script:DiagnosticToken) -or $script:PendingDiagnosticEvents.Count -eq 0) { return }
  while ($script:PendingDiagnosticEvents.Count -gt 0) {
    $batch = @($script:PendingDiagnosticEvents | Select-Object -First 100)
    $payload = @{ schema_version=1; source="host"; events=$batch } | ConvertTo-Json -Compress -Depth 12
    try {
      $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Method Post -ContentType "application/json" -Headers @{ "X-Docxtool-Session"=$script:DiagnosticToken } -Body $payload "http://127.0.0.1:$agentPort/v1/diagnostics/logs"
      $script:PendingDiagnosticEvents = @($script:PendingDiagnosticEvents | Select-Object -Skip $batch.Count)
    } catch { return }
  }
}
function Write-DiagnosticEvent {
  param([string]$Level, [string]$Event, [string]$Message, [hashtable]$Data = @{})
  $script:PendingDiagnosticEvents += [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    level = $Level
    component = "launcher"
    event = $Event
    message = $Message
    data = $Data
  }
  if ($script:PendingDiagnosticEvents.Count -gt 500) { $script:PendingDiagnosticEvents = @($script:PendingDiagnosticEvents | Select-Object -Last 500) }
  Flush-DiagnosticEvents
}

function Test-Health([int]$Port) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/v1/health").StatusCode -eq 200 } catch { return $false }
}
function Test-Static {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$staticPort/index.html").StatusCode -eq 200 } catch { return $false }
}
function Test-DiagnosticStatus {
  try {
    $value = Invoke-RestMethod -TimeoutSec 2 "http://127.0.0.1:$agentPort/v1/diagnostics/status"
    return $value.ok -eq $true -and $value.file_name -eq "wps-plugin-debug.log"
  } catch { return $false }
}
function Test-SessionToken([int]$Port, [string]$Path, [string]$Token) {
  if ([string]::IsNullOrWhiteSpace($Token)) { return $false }
  try {
    $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Method Post -ContentType "application/json" -Headers @{ "X-Docxtool-Session"=$Token } -Body "{}" "http://127.0.0.1:$Port$Path"
    return $true
  } catch {
    try { return ([int]$_.Exception.Response.StatusCode) -ne 401 } catch { return $false }
  }
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
  if (Test-Path -LiteralPath $publish) { $registered = (Get-Content -Raw -LiteralPath $publish) -match ('name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:' + $staticPort + '/') }
  [pscustomobject]@{
    static_resources = if (Test-Static) { "PASS" } else { "FAIL" }
    local_agent = if (Test-Health $agentPort) { "PASS" } else { "FAIL" }
    command_service = if (Test-Health $agentPort) { "PASS（统一入口）" } else { "FAIL" }
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
  Write-DiagnosticEvent "INFO" "launcher.prepare.start" "开始准备 WPS 本地验收环境"
  if (-not (Test-Path -LiteralPath $python)) { throw "E2E_PYTHON_NOT_FOUND" }
  & $python --version | Out-Null; & node --version | Out-Null; & $npm exec -- wpsjs --version | Out-Null
  Write-DiagnosticEvent "INFO" "launcher.build.start" "开始构建并校验涉密版加载项"
  & $npm run build | Out-Null; & $npm run build:classified | Out-Null; & $npm run verify:addin -- classified-offline | Out-Null
  Write-DiagnosticEvent "INFO" "launcher.build.success" "涉密版加载项构建与静态校验通过"
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
  $env:PYTHONPATH = "$root\local-agent\src;$root\command-service\src"
  $tokenFile = Join-Path $runtime "session-token.txt"
  $token = if (Test-Path -LiteralPath $tokenFile) { (Get-Content -Raw -LiteralPath $tokenFile).Trim() } else { "" }
  if ($token -notmatch '^[a-f0-9]{32}$') { $token = [Guid]::NewGuid().ToString("N") }
  $script:DiagnosticToken = $token
  $servicesUseToken = (Test-Health $agentPort) -and (Test-SessionToken $agentPort "/v1/recognize" $token) -and (Test-SessionToken $agentPort "/v1/commands" $token) -and (Test-DiagnosticStatus)
  if (-not $servicesUseToken) {
    Stop-ManagedPort $agentPort
    $null = Start-Managed "local-agent" $python @("-m", "docxtool_local_agent", "--port", "$agentPort", "--session-token", $token, "--e2e-runtime", $runtime, "--diagnostic-log-file", $diagnosticLog)
  }
  Write-DiagnosticEvent "INFO" "launcher.local_agent.start" "本地统一服务已启动或复用" @{ restarted=(-not $servicesUseToken); port=$agentPort }
  Set-Content -NoNewline -Encoding ascii -LiteralPath $tokenFile -Value $token
  $runtimeScript = Join-Path $root "apps\classified-offline\ui\e2e-session.js"
  ('window.DocxtoolRuntimeConfig=' + (@{ recognitionEndpoint="http://127.0.0.1:$agentPort"; commandEndpoint="http://127.0.0.1:$agentPort"; sessionToken=$token } | ConvertTo-Json -Compress) + ';if(typeof window.DocxtoolEarlyLog==="function"){window.DocxtoolEarlyLog("DEBUG","main","bootstrap.script.loaded","运行时配置脚本已执行",{asset:"ui/e2e-session.js",endpoint_origin:"http://127.0.0.1:' + $agentPort + '"});}') | Set-Content -Encoding utf8 $runtimeScript
  $publish = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
  $registeredAtFixedPort = (Test-Path -LiteralPath $publish) -and ((Get-Content -Raw -LiteralPath $publish) -match 'name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:3889/')
  $restartWpsjs = -not ((Test-Static) -and $registeredAtFixedPort)
  if ($restartWpsjs) {
    Stop-ManagedPort $staticPort
    $logs = Join-Path $runtime "logs"; New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $debug = Start-Process -FilePath "npx.cmd" -ArgumentList @("--no-install", "wpsjs", "debug", "-p", "$staticPort", "-d", "-r", "$remoteDebugPort") -WorkingDirectory (Join-Path $root "apps\classified-offline") -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "wpsjs.out.log") -RedirectStandardError (Join-Path $logs "wpsjs.err.log") -PassThru
    $null = $debug
  }
  Write-DiagnosticEvent "INFO" "launcher.wpsjs.start" "WPS 静态资源服务已启动或复用" @{ restarted=$restartWpsjs; port=$staticPort }
  for ($i = 0; $i -lt 30 -and (-not ((Test-Static) -and (Test-Health $agentPort) -and (Test-DiagnosticStatus))); $i++) { Start-Sleep -Milliseconds 500 }
  Flush-DiagnosticEvents
  $registrationReady = (Test-Path -LiteralPath $publish) -and ((Get-Content -Raw -LiteralPath $publish) -match 'name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:3889/')
  Write-DiagnosticEvent "INFO" "launcher.registration.checked" "WPS 加载项注册状态已检查" @{ registered=$registrationReady }
  $processes = @()
  foreach ($entry in @(@{name="local-service";port=$agentPort}, @{name="wpsjs";port=$staticPort})) {
    $processId = Get-NetTCPConnection -State Listen -LocalPort $entry.port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1
    if ($processId) { $processes += [pscustomobject]@{ name=$entry.name; pid=$processId } }
  }
  $processes | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runtime "processes.json")
  Write-DiagnosticEvent "INFO" "launcher.prepare.ready" "WPS 本地验收环境已就绪" @{ static_port=$staticPort; agent_port=$agentPort; diagnostics_ready=(Test-DiagnosticStatus) }
  Show-Status
  Write-Output "E2E_SESSION_READY $sessionId"
  exit
}
if ($Action -eq "auto") {
  # The E2E owns only these fixed loopback development ports. Restarting them
  # prevents a registered add-in from attaching to stale source or CORS rules.
  foreach ($port in @($staticPort, $agentPort, 9529, $remoteDebugPort)) { Stop-ManagedPort $port }
  & pwsh -NoProfile -File $PSCommandPath prepare
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  $session = Get-Session
  if (-not $session) { throw "E2E_SESSION_NOT_FOUND" }
  $metadata = Get-Content -Raw -LiteralPath (Join-Path (Join-Path $runtime $session.session_id) "test-document.json") | ConvertFrom-Json
  $working = Join-Path $root $metadata.working_project_relative
  $reportDirectory = Join-Path $root (".runtime\reports\" + $session.session_id); New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
  $before = Join-Path $root "tests\fixtures\wps-e2e-baseline.docx"
  $originalOutput = Join-Path $reportDirectory "01-original-test-copy.docx"
  $previewOutput = Join-Path $reportDirectory "02-preview-comments.docx"
  $finalOutput = Join-Path $reportDirectory "03-final-format.docx"
  Copy-Item -LiteralPath $before -Destination $originalOutput -Force
  $wps = Find-WpsWriter
  Start-Process -FilePath $wps -ArgumentList @($working) | Out-Null
  $previewCopied = $false
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    $session = Get-Session
    if (-not $previewCopied -and $session.test_results.preview_document.status -eq "PASS") {
      if (-not (Test-Path -LiteralPath $previewOutput)) { Copy-Item -LiteralPath $working -Destination $previewOutput -Force }
      $previewCopied = $true
    }
    if ($session.test_results.host_command_router) { break }
  }
  $health = if ($session.test_results.health_check) { $session.test_results.health_check } else { @{ status="FAIL"; error_code="HEALTH_CHECK_NOT_REPORTED" } }
  $preview = if ($session.test_results.preview_document) { $session.test_results.preview_document } else { @{ status="FAIL"; error_code="PREVIEW_NOT_REPORTED" } }
  $result = if ($session.test_results.one_click_format) { $session.test_results.one_click_format } else { @{ status="FAIL"; error_code="WPS_HOST_CALLBACK_TIMEOUT" } }
  $rollback = if ($session.test_results.rollback) { $session.test_results.rollback } else { @{ status="FAIL"; error_code="ROLLBACK_NOT_REPORTED" } }
  if ($result.status -eq "PASS") {
    & $python (Join-Path $root "scripts\inspect-one-click-ooxml.py") $before --out (Join-Path $reportDirectory "one-click-before-ooxml.json")
    if (-not (Test-Path -LiteralPath $previewOutput)) { throw "PREVIEW_ARTIFACT_NOT_CAPTURED" }
    & $python (Join-Path $root "scripts\inspect-one-click-ooxml.py") $previewOutput --out (Join-Path $reportDirectory "preview-comments-ooxml.json")
    & $python (Join-Path $root "scripts\inspect-one-click-ooxml.py") $working --out (Join-Path $reportDirectory "one-click-ooxml.json")
    & $python (Join-Path $root "scripts\verify-one-click-format.py") $working --profile (Join-Path $root "command-service\src\docxtool_command_service\profiles\docxtool-default.json") --expectations (Join-Path $root "tests\fixtures\one-click-format-expectations.json") --out (Join-Path $reportDirectory "one-click-format-values.json")
    $formatValues = Get-Content -Raw (Join-Path $reportDirectory "one-click-format-values.json") | ConvertFrom-Json
    $beforeInfo = Get-Content -Raw (Join-Path $reportDirectory "one-click-before-ooxml.json") | ConvertFrom-Json
    $previewInfo = Get-Content -Raw (Join-Path $reportDirectory "preview-comments-ooxml.json") | ConvertFrom-Json
    $afterInfo = Get-Content -Raw (Join-Path $reportDirectory "one-click-ooxml.json") | ConvertFrom-Json
    $contentIntegrity = [ordered]@{ body_sha256_matches=($beforeInfo.body_sha256 -eq $afterInfo.body_sha256); paragraph_count_matches=($beforeInfo.paragraph_count -eq $afterInfo.paragraph_count); paragraph_order_matches=(($beforeInfo.paragraphs.text_sha256 -join ',') -eq ($afterInfo.paragraphs.text_sha256 -join ',')); preview_docxtool_comments_present=($previewInfo.comments.docxtool_preview -gt 0); preview_fields_complete=($previewInfo.comments.docxtool_preview_complete -eq $previewInfo.comments.docxtool_preview); preview_role_colors_distinct=($previewInfo.comments.docxtool_role_author_count -ge 3); preview_user_comments_preserved=($previewInfo.comments.user_owned -eq $beforeInfo.comments.user_owned); final_docxtool_comments_cleared=($afterInfo.comments.docxtool_preview -eq 0); final_user_comments_preserved=($afterInfo.comments.user_owned -eq $beforeInfo.comments.user_owned) }
    Copy-Item -LiteralPath $working -Destination $finalOutput -Force
  } else { $contentIntegrity = [ordered]@{ body_sha256_matches=$false; paragraph_count_matches=$false; paragraph_order_matches=$false; preview_docxtool_comments_present=$false; preview_user_comments_preserved=$false; final_docxtool_comments_cleared=$false; final_user_comments_preserved=$false }; $formatValues = [ordered]@{ status="FAIL"; failures=@(@{ property="format_validation_not_run" }) } }
  $passed = $health.status -eq "PASS" -and $preview.status -eq "PASS" -and $result.status -eq "PASS" -and $rollback.status -eq "PASS" -and $contentIntegrity.body_sha256_matches -and $contentIntegrity.paragraph_count_matches -and $contentIntegrity.paragraph_order_matches -and $contentIntegrity.preview_docxtool_comments_present -and $contentIntegrity.preview_fields_complete -and $contentIntegrity.preview_role_colors_distinct -and $contentIntegrity.preview_user_comments_preserved -and $contentIntegrity.final_docxtool_comments_cleared -and $contentIntegrity.final_user_comments_preserved -and $formatValues.status -eq "PASS"
  $safe = [ordered]@{ overall_status=if ($passed) { "CLASSIFIED_THREE_ACTIONS_PASS" } else { "CLASSIFIED_THREE_ACTIONS_FAIL" }; wps_version=$session.wps_version; plugin_version=$session.plugin_version; health_check=$health; preview=$preview; one_click=$result; rollback=$rollback; content_integrity=$contentIntegrity; saved_format_validation=$formatValues; fixture_before=(Join-Path $runtime ($session.session_id + "\test-document.json")); original_document=$originalOutput; preview_document=$previewOutput; final_document=$finalOutput }
  $safe | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $reportDirectory "one-click-e2e.json")
  ("# WPS 涉密版三功能自动验收`n`n状态：" + $safe.overall_status + "`n`n功能检测：" + $health.status + "`n`n预览排版：" + $preview.status + "`n`n一键排版：" + $result.status + "`n`n回滚：" + $rollback.status + "`n`n保存后格式：" + $formatValues.status + "`n`n正文哈希：" + $contentIntegrity.body_sha256_matches + "`n`n预览批注：" + $contentIntegrity.preview_docxtool_comments_present + "`n`n用户批注保留：" + $contentIntegrity.final_user_comments_preserved + "`n`n错误码：" + $result.error_code) | Set-Content -Encoding utf8 (Join-Path $reportDirectory "one-click-e2e.md")
  if (-not $passed) { throw $(if ($health.status -ne "PASS") { $health.error_code } elseif ($preview.status -ne "PASS") { $preview.error_code } elseif ($result.status -ne "PASS") { $result.error_code } elseif ($rollback.status -ne "PASS") { $rollback.error_code } elseif ($formatValues.status -ne "PASS") { "SAVED_DOCX_FORMAT_MISMATCH" } else { "SAVED_DOCX_CONTENT_OR_COMMENT_MISMATCH" }) }
  exit
}
if ($Action -eq "stop") {
  $tokenFile = Join-Path $runtime "session-token.txt"
  if (Test-Path -LiteralPath $tokenFile) { $script:DiagnosticToken = (Get-Content -Raw -LiteralPath $tokenFile).Trim() }
  Write-DiagnosticEvent "INFO" "launcher.stop" "停止 WPS 本地验收托管进程"
  Flush-DiagnosticEvents
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
