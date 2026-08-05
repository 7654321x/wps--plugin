param([string]$ExpectedUrl = "http://127.0.0.1:3889/")

$ErrorActionPreference = "Stop"
$publish = Join-Path $env:APPDATA "Kingsoft\wps\jsaddons\publish.xml"
$runningWps = @(Get-Process wps -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -ExpandProperty Path -Unique)
$programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
$wpsCandidates = @($runningWps | ForEach-Object { Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue })
if (-not $wpsCandidates) { $wpsCandidates = @($programRoots | ForEach-Object { Get-ChildItem (Join-Path $_ "WPS Office\*\office6\wps.exe") -ErrorAction SilentlyContinue } | Sort-Object LastWriteTime -Descending) }
$wps = @($wpsCandidates | Select-Object -First 1)
$entry = $null
if (Test-Path -LiteralPath $publish) {
  [xml]$document = Get-Content -LiteralPath $publish -Raw
  $entry = @($document.SelectNodes("//jspluginonline") | Where-Object { $_.name -eq "docxtool-classified-offline" } | Select-Object -First 1)
}
$wpsjsVersion = (& node -p "require('./node_modules/wpsjs/package.json').version" 2>$null).Trim()
$report = [ordered]@{
  schema_version = 1
  wps_executable = if ($wps) { $wps[0].FullName } else { "" }
  wps_file_version = if ($wps) { $wps[0].VersionInfo.FileVersion } else { "" }
  wps_product_version = if ($wps) { $wps[0].VersionInfo.ProductVersion } else { "" }
  wpsjs_version = $wpsjsVersion
  jsaddons_path = Split-Path -Parent $publish
  publish_xml_exists = (Test-Path -LiteralPath $publish)
  docxtool_registration_found = [bool]$entry
  docxtool_url = if ($entry) { [string]$entry[0].url } else { "" }
  docxtool_type = if ($entry) { [string]$entry[0].type } else { "" }
  docxtool_debug_attribute = if ($entry) { [string]$entry[0].debug } else { "" }
  registration_matches_current_server = [bool]($entry -and [string]$entry[0].url -eq $ExpectedUrl -and [string]$entry[0].type -eq "wps")
}
$output = Join-Path $env:TEMP "docxtool-wps-registration-report.json"
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $output -Encoding utf8NoBOM
$report | ConvertTo-Json -Depth 6
