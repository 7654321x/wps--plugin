param(
  [ValidateSet("tail", "clear", "summary", "path")]
  [string]$Action = "tail",
  [int]$Lines = 200
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$log = Join-Path $root "wps-plugin-debug.log"

switch ($Action) {
  "path" {
    Write-Output $log
  }
  "clear" {
    if (Test-Path -LiteralPath $log) { Clear-Content -LiteralPath $log }
    Write-Output ("CLEARED " + $log)
  }
  "tail" {
    if (-not (Test-Path -LiteralPath $log)) { Write-Output ("LOG_NOT_FOUND " + $log); exit 1 }
    Get-Content -LiteralPath $log -Tail $Lines -Wait
  }
  "summary" {
    if (-not (Test-Path -LiteralPath $log)) { Write-Output ("LOG_NOT_FOUND " + $log); exit 1 }
    $items = @(Get-Content -LiteralPath $log | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
    $errors = @($items | Where-Object { $_.level -in @("ERROR", "FATAL") })
    $last = @($items | Select-Object -Last 1)
    $lastError = @($errors | Select-Object -Last 1)
    [pscustomobject]@{
      file = $log
      lines = $items.Count
      first_timestamp = if ($items.Count) { $items[0].timestamp } else { "" }
      last_timestamp = if ($last.Count) { $last[0].timestamp } else { "" }
      errors = $errors.Count
      last_event = if ($last.Count) { $last[0].event } else { "" }
      last_error_event = if ($lastError.Count) { $lastError[0].event } else { "" }
      last_error_code = if ($lastError.Count) { $lastError[0].stable_error_code } else { "" }
      last_error_message = if ($lastError.Count) { $lastError[0].error.message } else { "" }
    } | Format-List
  }
}
