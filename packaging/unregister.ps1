#Requires -Version 5.1
<#
unregister.ps1 — remove the DSH Harness share-target package.

The dev cert is intentionally NOT removed: trust is machine-wide and may be
shared with other registrations; removal is a manual follow-up if desired
(see packaging\certs\fingerprints.json for the exact thumbprint).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("unregister-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$m) { Add-Content -Path $logFile -Value ("{0:O} {1}" -f [DateTimeOffset]::UtcNow, $m) }

$pkg = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction SilentlyContinue
if (-not $pkg) {
    Log 'no DshDesktop.ShareTarget package registered; nothing to do'
    Write-Output 'not-registered'
    exit 0
}
# Y8 (review): Remove-AppxPackage is a cmdlet — it does not update
# $LASTEXITCODE; EAP=Stop throws on failure. The real verification is the
# existence check below.
Remove-AppxPackage -Package $pkg.PackageFullName
$left = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction SilentlyContinue
if ($left) { throw 'package still present after removal' }
Log "removed $($pkg.PackageFullName)"
Write-Output "removed $($pkg.PackageFullName)"
