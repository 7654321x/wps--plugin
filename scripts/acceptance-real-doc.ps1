param([ValidateSet("prepare", "status", "report")][string]$Action = "status")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtime = Join-Path $root ".runtime\manual-acceptance"
$source = Join-Path $root "005班子对照检查材料.docx"
$e2e = Join-Path $PSScriptRoot "e2e-classified.ps1"
$buildInfo = Join-Path $root "apps\classified-offline\ui\build-info.js"

function Get-BuildInfo {
  if (-not (Test-Path -LiteralPath $buildInfo)) { throw "BUILD_INFO_MISSING" }
  $raw = Get-Content -LiteralPath $buildInfo -Raw
  if ($raw -notmatch 'Object\.freeze\((\{.+\})\)') { throw "BUILD_INFO_INVALID" }
  return ($matches[1] | ConvertFrom-Json)
}
function Get-CurrentSession {
  $file = Join-Path $runtime "current.json"
  if (Test-Path -LiteralPath $file) { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
  return $null
}
function Get-DocumentStats([string]$Path) {
  $python = Join-Path $root "..\.venv\Scripts\python.exe"
  $script = @'
import hashlib,json,os,sys,zipfile,xml.etree.ElementTree as ET
p=sys.argv[1]
# WPS can save relationship entries that python-docx rejects (for example a
# literal NULL target).  Count only OOXML element names; never extract text.
with zipfile.ZipFile(p) as z:
    root=ET.fromstring(z.read("word/document.xml"))
local=lambda node: node.tag.rsplit("}",1)[-1]
nodes=list(root.iter()); paragraphs=[node for node in nodes if local(node)=="p"]
stats={"sha256":hashlib.sha256(open(p,"rb").read()).hexdigest(),"size_bytes":os.path.getsize(p),"paragraph_count":len(paragraphs),"non_empty_paragraph_count":sum(any(local(child)=="t" for child in node.iter()) for node in paragraphs),"section_count":max(1,sum(local(node)=="sectPr" for node in nodes)),"table_count":sum(local(node)=="tbl" for node in nodes),"inspection_mode":"OOXML_METADATA_ONLY"}
print(json.dumps(stats,ensure_ascii=False))
'@
  $result = $script | & $python - $Path
  if ($LASTEXITCODE) { throw "DOCX_INSPECTION_FAILED" }
  return $result | ConvertFrom-Json
}
function Test-Port([int]$Port, [string]$Path = "/v1/health") {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port$Path").StatusCode -eq 200 } catch { return $false }
}
function Get-Registration {
  $publish = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
  if (-not (Test-Path -LiteralPath $publish)) { return "FAIL" }
  return $(if ((Get-Content -LiteralPath $publish -Raw) -match 'name="docxtool-classified-offline"[^>]+url="http://127\.0\.0\.1:3891/') { "PASS" } else { "FAIL" })
}
function Show-Status {
  $session = Get-CurrentSession
  $expected = if ($session) { $session.expected_build_id } else { "" }
  $current = try { (Get-BuildInfo).build_id } catch { "" }
  [pscustomobject]@{
    static_resources = if (Test-Port 3891 "/ui/taskpane-development.html") { "PASS" } else { "FAIL" }
    local_agent = if (Test-Port 9528) { "PASS" } else { "FAIL" }
    command_service = if (Test-Port 9528) { "PASS（统一入口）" } else { "FAIL" }
    debug_registration = Get-Registration
    session_id = if ($session) { $session.session_id } else { "" }
    expected_build_id = $expected
    current_build_id = $current
    addin_context = if (-not $session) { "NO_ACCEPTANCE_SESSION" } elseif ($expected -ne $current) { "ADDIN_CONTEXT_STALE" } else { "BUILD_READY" }
    working_copy_ready = if ($session -and (Test-Path -LiteralPath (Join-Path (Join-Path $runtime $session.session_id) "01-original-copy.docx"))) { "PASS" } else { "FAIL" }
  } | Format-List
}

if ($Action -eq "prepare") {
  if (-not (Test-Path -LiteralPath $source)) { throw "REAL_ACCEPTANCE_SOURCE_NOT_FOUND" }
  & pwsh -NoProfile -File $e2e prepare
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  & npm.cmd run build:classified | Out-Null
  # e2e-classified.ps1 owns the fixed-port wpsjs service and registration.
  $id = [Guid]::NewGuid().ToString("N")
  $directory = Join-Path $runtime $id
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $original = Join-Path $directory "01-original-copy.docx"
  $preview = Join-Path $directory "02-preview-copy.docx"
  $after = Join-Path $directory "03-after-format.docx"
  Copy-Item -LiteralPath $source -Destination $original -ErrorAction Stop
  Copy-Item -LiteralPath $original -Destination $preview -ErrorAction Stop
  Copy-Item -LiteralPath $original -Destination $after -ErrorAction Stop
  $info = Get-BuildInfo; $stats = Get-DocumentStats $original
  $session = [ordered]@{ session_id=$id; created_at=(Get-Date).ToUniversalTime().ToString("o"); expected_build_id=$info.build_id; plugin_version=$info.plugin_version; asset_hash=$info.asset_hash; source_sha256=$stats.sha256; source_size_bytes=$stats.size_bytes; paragraph_count=$stats.paragraph_count; non_empty_paragraph_count=$stats.non_empty_paragraph_count; section_count=$stats.section_count; table_count=$stats.table_count; preview_comment_count=$null; command_count=$null; category_counts=@{}; status="PREPARED" }
  $session | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $directory "acceptance-session.json")
  $session | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $directory "acceptance-report.json")
  @("# 真实文档验收（脱敏报告）", "", "状态：PREPARED", "", "Session：$id", "构建：$($info.build_id)", "原文 SHA-256：$($stats.sha256)", "段落：$($stats.paragraph_count)；节：$($stats.section_count)；表格：$($stats.table_count)", "", "本报告不包含正文、完整文件路径或批注正文。") | Set-Content -Encoding utf8 (Join-Path $directory "acceptance-report.md")
  $session | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $runtime "current.json")
  Show-Status
  Write-Output "REAL_DOCUMENT_ACCEPTANCE_READY $id"
  Write-Output "WORKING_COPY $original"
  exit
}
if ($Action -eq "report") {
  $session = Get-CurrentSession
  if (-not $session) { throw "NO_ACCEPTANCE_SESSION" }
  Get-Content -LiteralPath (Join-Path (Join-Path $runtime $session.session_id) "acceptance-report.md") -Raw
  exit
}
Show-Status
