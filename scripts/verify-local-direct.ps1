param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Push-Location $root
try {
  & npm run typecheck
  if ($LASTEXITCODE) { throw "TYPESCRIPT_TYPECHECK_FAILED" }

  $scanTargets = @(
    "apps/classified-offline/main.production.js",
    "apps/classified-offline/js/ribbon-production.js",
    "apps/classified-offline/src/host-runtime.ts",
    "apps/classified-offline/src/composition-root.ts",
    "apps/classified-offline/src/health-check.ts",
    "apps/classified-offline/src/taskpane-workflow.ts",
    "apps/classified-offline/ui/taskpane.html",
    "apps/classified-offline/ui/local-runtime-config.js",
    "apps/classified-offline/vite.config.js"
  )
  $forbidden = "HttpLocalRecognitionTransport|HttpCommandServiceClient|LocalEndpointProvider|sessionToken|recognitionEndpoint|commandEndpoint|127\.0\.0\.1:9528|/v1/recognize|/v1/commands|DocxtoolHostDispatch|fetch\("
  $matches = rg -n $forbidden @scanTargets
  if ($LASTEXITCODE -eq 0) { throw "LOCAL_DIRECT_FORBIDDEN_PRODUCTION_DEPENDENCY" }
  if ($LASTEXITCODE -ne 1) { throw "LOCAL_DIRECT_SCAN_FAILED" }

  & npm run build:classified
  if ($LASTEXITCODE) { throw "CLASSIFIED_BUILD_FAILED" }
  & npm run verify:addin -- classified-offline
  if ($LASTEXITCODE) { throw "ADDIN_VERIFY_FAILED" }

  $port = Get-NetTCPConnection -LocalPort 9528 -State Listen -ErrorAction SilentlyContinue
  if ($port) { throw "PORT_9528_LISTENING" }
  Write-Output "VERIFY_LOCAL_DIRECT_PASS"
} finally {
  Pop-Location
}
