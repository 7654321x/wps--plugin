#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [switch]$Check
)

$ErrorActionPreference = "Stop"
$destination = Join-Path $PSScriptRoot "..\docs\HOST_TEXT_V1_GOLDEN.json"
$sourcePath = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "HOST_TEXT_GOLDEN_SOURCE_MISSING"
}

$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$destinationHash = if (Test-Path -LiteralPath $destination -PathType Leaf) {
    (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
}
else {
    ""
}

if ($Check) {
    if ($sourceHash -ne $destinationHash) {
        throw "HOST_TEXT_GOLDEN_OUT_OF_SYNC"
    }
    Write-Host "HOST_TEXT_GOLDEN_SYNCED $sourceHash"
    return
}

Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
Write-Host "HOST_TEXT_GOLDEN_UPDATED $sourceHash"
