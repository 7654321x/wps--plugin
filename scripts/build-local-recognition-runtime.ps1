param(
  [string]$PythonExecutable = (Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe")
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$python = (Resolve-Path $PythonExecutable).Path
$entry = Join-Path $root "local-runtime\recognize_entry.py"
$distRoot = Join-Path $root "dist\local-runtime\win-x64"
$workRoot = Join-Path $root "dist\local-runtime\_build"
$specRoot = Join-Path $root "dist\local-runtime\_spec"
$exe = Join-Path $distRoot "docxtool-recognize.exe"
$manifestPath = Join-Path $distRoot "runtime-manifest.json"

if (-not (Test-Path -LiteralPath $entry)) {
  throw "LOCAL_RECOGNITION_RUNTIME_ENTRY_MISSING: 未找到 local-runtime\recognize_entry.py。"
}

try {
  & $python -c "import PyInstaller" | Out-Null
} catch {
  throw "PYINSTALLER_NOT_INSTALLED: 当前 .venv 未安装 PyInstaller，无法构建 docxtool-recognize.exe。"
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
New-Item -ItemType Directory -Force -Path $specRoot | Out-Null
Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue

& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name "docxtool-recognize" `
  --distpath $distRoot `
  --workpath $workRoot `
  --specpath $specRoot `
  $entry

if ($LASTEXITCODE) {
  throw "LOCAL_RECOGNITION_RUNTIME_BUILD_FAILED: PyInstaller 构建失败。"
}

if (-not (Test-Path -LiteralPath $exe)) {
  throw "LOCAL_RECOGNITION_RUNTIME_BUILD_FAILED: 未生成 docxtool-recognize.exe。"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
$packageVersion = (& $python -c "from importlib.metadata import version; print(version('docxtool'))").Trim()
$pythonVersion = (& $python -c "import platform; print(platform.python_version())").Trim()
$manifest = @{
  schema_version = 1
  contract_version = 1
  runtime_version = "docxtool-$packageVersion"
  platform = "win-x64"
  executable = "docxtool-recognize.exe"
  executable_sha256 = $hash
  recognition_package_version = $packageVersion
  python_version = $pythonVersion
  build_timestamp = (Get-Date).ToUniversalTime().ToString("o")
}

$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
Write-Output ("LOCAL_RUNTIME_BUILD_PASS " + $exe)
Write-Output ("runtime_version: " + $manifest.runtime_version)
Write-Output ("sha256: " + $hash)
