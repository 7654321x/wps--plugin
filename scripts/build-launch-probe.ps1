param(
  [string]$PythonExecutable = (Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe")
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = (Resolve-Path $PythonExecutable).Path
$entry = Join-Path $root "local-runtime\launch_probe.py"
$distRoot = Join-Path $root "dist\local-runtime\win-x64"
$workRoot = Join-Path $root "dist\local-runtime\_build-launch-probe"
$specRoot = Join-Path $root "dist\local-runtime\_spec-launch-probe"
$exe = Join-Path $distRoot "docxtool-launch-probe.exe"

if (-not (Test-Path -LiteralPath $entry)) {
  throw "LAUNCH_PROBE_ENTRY_MISSING: 未找到 local-runtime\launch_probe.py。"
}

try {
  & $python -c "import PyInstaller" | Out-Null
} catch {
  throw "PYINSTALLER_NOT_INSTALLED: 当前 .venv 未安装 PyInstaller，无法构建启动探针。"
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
New-Item -ItemType Directory -Force -Path $specRoot | Out-Null
Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue

& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name "docxtool-launch-probe" `
  --distpath $distRoot `
  --workpath $workRoot `
  --specpath $specRoot `
  $entry

if ($LASTEXITCODE) {
  throw "LAUNCH_PROBE_BUILD_FAILED: PyInstaller 构建失败。"
}
if (-not (Test-Path -LiteralPath $exe)) {
  throw "LAUNCH_PROBE_BUILD_FAILED: 未生成 docxtool-launch-probe.exe。"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
Write-Output ("LAUNCH_PROBE_BUILD_PASS " + $exe)
Write-Output ("sha256: " + $hash)
