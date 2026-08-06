param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) { throw "VERIFY_PYTHON_NOT_FOUND" }

Push-Location $root
try {
  & npm run typecheck
  if ($LASTEXITCODE) { throw "TYPESCRIPT_TYPECHECK_FAILED" }
  & npm test
  if ($LASTEXITCODE) { throw "TYPESCRIPT_TEST_FAILED" }
  & $python (Join-Path $root "scripts\sync-default-format-profile.py") --check
  if ($LASTEXITCODE) { throw "PROFILE_SYNC_CHECK_FAILED" }
  $env:PYTHONPATH = "$root\control-server\src;$root\command-service\src;$root\local-agent\src"
  & $python -m pytest control-server\tests command-service\tests local-agent\tests local-runtime\tests tests\test_grid_inspector.py tests\test_unified_logging.py tests\test_wps_debug_server.py -q
  if ($LASTEXITCODE) { throw "PYTHON_TEST_FAILED" }
  & $python -m ruff check control-server command-service local-agent local-runtime scripts tests wps_logging.py
  if ($LASTEXITCODE) { throw "RUFF_FAILED" }
  & npm run build:classified
  if ($LASTEXITCODE) { throw "CLASSIFIED_BUILD_FAILED" }
  & npm run build:online
  if ($LASTEXITCODE) { throw "ONLINE_BUILD_FAILED" }
  & npm run verify:addin
  if ($LASTEXITCODE) { throw "ADDIN_VERIFY_FAILED" }
  $forbidden = rg -n "\beval\(|new Function\(" apps packages command-service control-server local-agent schemas scripts -g '!**/node_modules/**' -g '!**/dist/**'
  if ($LASTEXITCODE -eq 0) { throw "SECURITY_SCAN_FAILED" }
  if ($LASTEXITCODE -ne 1) { throw "SECURITY_SCAN_ERROR" }
  Write-Output "VERIFY_ALL_PASS"
} finally { Pop-Location }
