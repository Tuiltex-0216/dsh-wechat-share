#Requires -Version 5.1
<#
ensure-dotnet.ps1 — resolve a working .NET 8 SDK, installing to %USERPROFILE%\.dotnet when absent.
PowerShell 5.1 compatible (this host has no pwsh 7).
stdout contract: exactly one line — the path to a dotnet executable whose --list-sdks contains 8.*
Exit codes: 0 ok, 1 no SDK obtainable.
#>
[CmdletBinding()]
param([switch]$ForceInstall)

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$installDir = Join-Path $env:USERPROFILE '.dotnet'
$localDotnet = Join-Path $installDir 'dotnet.exe'

function Test-Dotnet8([string]$exe) {
    if (-not (Test-Path -LiteralPath $exe)) { return $false }
    try {
        $sdks = & $exe --list-sdks 2>$null
        return @($sdks) -match '^8\.'
    } catch { return $false }
}

if (-not $ForceInstall) {
    if (Test-Dotnet8 $localDotnet) { Write-Output $localDotnet; exit 0 }
    $sys = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($sys -and (Test-Dotnet8 $sys.Source)) { Write-Output $sys.Source; exit 0 }
}

Write-Host "[ensure-dotnet] installing .NET 8 SDK to $installDir ..."
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$installer = Join-Path $env:TEMP ("dotnet-install-{0}.ps1" -f (Get-Random))
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
    & $installer -Channel 8.0 -InstallDir $installDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet-install.ps1 exited $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}

if (Test-Dotnet8 $localDotnet) { Write-Output $localDotnet; exit 0 }
Write-Error "[ensure-dotnet] install finished but no 8.* SDK found under $installDir"
exit 1
