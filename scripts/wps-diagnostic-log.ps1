param(
  [ValidateSet("tail", "clear", "summary", "path")]
  [string]$Action = "tail",
  [int]$Lines = 200
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$log = Join-Path $root "wps-plugin.log"

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
    $items = @(Get-Content -LiteralPath $log | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2} ' })
    $errors = @($items | Where-Object { $_ -match '\[(错误|致命)\]' })
    $last = @($items | Select-Object -Last 1)
    $lastError = @($errors | Select-Object -Last 1)
    $eventCode = if ($last.Count -and $last[0] -match '事件码：([^｜]+)') { $Matches[1].Trim() } else { "" }
    $lastErrorCode = if ($lastError.Count -and $lastError[0] -match '错误码：([^｜]+)') { $Matches[1].Trim() } else { "" }
    [pscustomobject]@{
      file = $log
      lines = $items.Count
      first_timestamp = if ($items.Count) { $items[0].Substring(0, 23) } else { "" }
      last_timestamp = if ($last.Count) { $last[0].Substring(0, 23) } else { "" }
      errors = $errors.Count
      last_event = $eventCode
      last_error_event = if ($lastError.Count -and $lastError[0] -match '事件码：([^｜]+)') { $Matches[1].Trim() } else { "" }
      last_error_code = $lastErrorCode
      last_error_message = if ($lastError.Count) { $lastError[0] } else { "" }
    } | Format-List
  }
}
