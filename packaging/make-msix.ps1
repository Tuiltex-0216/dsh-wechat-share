#Requires -Version 5.1
<#
make-msix.ps1 — build and register the DSH Harness WeChat share target.

Host-adapted (T3 adjudication): this machine's signing toolchain is broken
(signtool rejects all APPX packages including the reference one; CNG RSA
key material drifts; crypt32 store APIs stripped), so the package is
registered via the DEVELOPER-MODE path:

    Add-AppxPackage -Register <stage>\AppxManifest.xml -ExternalLocation <stub\dist>

No MSIX signature is required. Prerequisite: Windows Developer Mode is
enabled (Settings → Privacy & security → For developers → Developer mode;
the legacy AppModelUnlock registry key alone is ignored on 25H2).

Idempotent: re-runs republish, restage, and re-register cleanly.
Logs to packaging\logs\make-msix-<ts>.log.
Final stdout line: the registered PackageFullName.
#>
[CmdletBinding()]
param(
    [string]$ExternalLocation = '',
    [switch]$SkipRegister
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packDir = $PSScriptRoot
$distDir = if ($ExternalLocation) { $ExternalLocation } else { Join-Path $repoRoot 'stub\dist' }
$toolsDir = Join-Path $packDir 'tools'
$assetDir = Join-Path $packDir 'Assets'
$stageDir = Join-Path $packDir 'stage'
$logDir = Join-Path $packDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("make-msix-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$m) { Add-Content -Path $logFile -Value ("{0:O} {1}" -f [DateTimeOffset]::UtcNow, $m) }

try {
    Log "start dist=$distDir mode=dev-register"

    # ── 1. developer mode preflight ─────────────────────────────────────────
    $devKey = $null
    try { $devKey = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction Stop).AllowDevelopmentWithoutDevLicenseRegistryKey } catch {}
    $alreadyRegistered = $null
    try { $alreadyRegistered = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction Stop } catch {}
    if (-not $devKey -and -not $alreadyRegistered) {
        throw "Developer Mode is not enabled and no share target is registered yet. Enable it once: Settings → Privacy & security → For developers → Developer mode. (Legacy registry key alone is ignored on Windows 11 25H2.)"
    }
    Log "developer mode preflight ok (key=$devKey, registered=$([bool]$alreadyRegistered))"

    # ── 2. stub\dist — self-contained publish (runtime bundled) ─────────────
    Log "publishing stub (self-contained win-x64)..."
    $dotnet = & (Join-Path $repoRoot 'scripts\ensure-dotnet.ps1')
    if (-not $dotnet) { throw "ensure-dotnet returned no path" }
    & $dotnet publish (Join-Path $repoRoot 'stub') -c Release -r win-x64 --self-contained true -o $distDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
    $stubExe = Join-Path $distDir 'WeChatShare.Stub.exe'
    if (-not (Test-Path -LiteralPath $stubExe)) { throw "stub exe missing after publish: $stubExe" }
    Log "stub published ($(Get-ChildItem $distDir -Recurse -File | Measure-Object | Select-Object -ExpandProperty Count) files)"

    # ── 3. assets (share-target logos) ──────────────────────────────────────
    New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
    $dshIcon = 'C:\Program Files\DSH Desktop\resources\icon.png'
    if (Test-Path -LiteralPath $dshIcon) {
        & $stubExe --gen-assets $dshIcon $assetDir
        if ($LASTEXITCODE -ne 0) { throw "gen-assets from DSH icon failed" }
        Log "assets from $dshIcon"
    } else {
        Log "DSH icon missing; generating placeholder"
        Add-Type -AssemblyName System.Drawing
        $bmp = New-Object System.Drawing.Bitmap(150, 150)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::FromArgb(255, 69, 97, 238))
        $g.Dispose()
        $placeholder = Join-Path $assetDir 'placeholder-src.png'
        $bmp.Save($placeholder, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        & $stubExe --gen-assets $placeholder $assetDir
        if ($LASTEXITCODE -ne 0) { throw "gen-assets from placeholder failed" }
        Remove-Item -LiteralPath $placeholder -Force
    }
    foreach ($a in @('Square44x44Logo.png', 'Square150x150Logo.png')) {
        if (-not (Test-Path -LiteralPath (Join-Path $assetDir $a))) { throw "asset missing: $a" }
    }
    # mirror assets into the external location (the share UI resolves logos
    # from the package layout at the external location)
    New-Item -ItemType Directory -Force -Path (Join-Path $distDir 'Assets') | Out-Null
    Copy-Item -Path (Join-Path $assetDir '*') -Destination (Join-Path $distDir 'Assets') -Force

    # ── 4. stage + makeappx pack (pack only — signing is host-broken) ──────
    $makeappx = Join-Path $toolsDir 'bin\10.0.22621.0\x64\makeappx.exe'
    if (-not (Test-Path -LiteralPath $makeappx)) {
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $nupkg = Join-Path $toolsDir 'buildtools.nupkg'
        if (-not (Test-Path -LiteralPath $nupkg)) {
            Log "downloading Microsoft.Windows.SDK.BuildTools..."
            Invoke-WebRequest -UseBasicParsing `
                -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/10.0.22621.755/microsoft.windows.sdk.buildtools.10.0.22621.755.nupkg' `
                -OutFile $nupkg
        }
        $zipCopy = $nupkg -replace '\.nupkg$', '.zip'
        Copy-Item -LiteralPath $nupkg -Destination $zipCopy -Force
        Expand-Archive -LiteralPath $zipCopy -DestinationPath $toolsDir -Force
        Remove-Item -LiteralPath $zipCopy -Force
        if (-not (Test-Path -LiteralPath $makeappx)) { throw "MakeAppx.exe missing after tool extract" }
        Log "tools ready"
    }

    if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $packDir 'AppxManifest.xml') -Destination $stageDir
    New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'Assets') | Out-Null
    Copy-Item -Path (Join-Path $assetDir '*') -Destination (Join-Path $stageDir 'Assets') -Force
    Copy-Item -Path (Join-Path $distDir '*') -Destination $stageDir -Recurse -Force
    # pre-seed [Content_Types].xml WITH the p7x override so the blockmap
    # covers the final CT (makeappx auto-generates a CT without it)
    $ct = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="dll" ContentType="application/x-msdownload" /><Default Extension="pdb" ContentType="application/octet-stream" /><Default Extension="exe" ContentType="application/x-msdownload" /><Default Extension="json" ContentType="application/json" /><Default Extension="png" ContentType="image/png" /><Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml" /><Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml" /><Override PartName="/AppxSignature.p7x" ContentType="application/vnd.ms-appx.signature" /></Types>'
    [IO.File]::WriteAllText((Join-Path $stageDir '[Content_Types].xml'), $ct, (New-Object System.Text.UTF8Encoding($false)))
    $msix = Join-Path $packDir 'dist\DshDesktop.ShareTarget.msix'
    New-Item -ItemType Directory -Force -Path (Split-Path $msix) | Out-Null
    & $makeappx pack /d $stageDir /p $msix /o
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed ($LASTEXITCODE)" }
    Log "packed $msix ((Get-Item $msix).Length bytes)"

    # ── 5. register (developer mode: manifest + external location) ─────────
    if ($SkipRegister) {
        Log "skip register (-SkipRegister)"
        Write-Output 'skipped'
        return
    }
    if ($alreadyRegistered) {
        Remove-AppxPackage -Package $alreadyRegistered.PackageFullName -ErrorAction SilentlyContinue
        Log "removed previous $($alreadyRegistered.PackageFullName)"
    }
    Add-AppxPackage -Register (Join-Path $stageDir 'AppxManifest.xml') -ExternalLocation $distDir
    if ($LASTEXITCODE -ne 0) { throw "Add-AppxPackage -Register failed ($LASTEXITCODE)" }
    $registered = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction SilentlyContinue
    if (-not $registered) { throw 'package registration did not stick' }
    if ($registered.Status -ne 'Ok') { throw "registered package unhealthy: $($registered.Status)" }
    Log "registered $($registered.PackageFullName)"

    # ── 6. extension verification (identity probe via manifest) ─────────────
    $mf = [IO.File]::ReadAllText((Join-Path $stageDir 'AppxManifest.xml'))
    if ($mf -notmatch 'windows.shareTarget') { throw 'shareTarget extension missing from manifest' }
    if ($mf -notmatch 'SupportsAnyFileType') { throw 'SupportsAnyFileType missing from manifest' }
    $displayName = [regex]::Match($mf, 'DisplayName="([^"]+)"').Groups[1].Value
    Log "share target verified: DisplayName='$displayName' AUMID=$($registered.PackageFamilyName)!Share.Hub"

    Write-Output $registered.PackageFullName
}
catch {
    Log "FAILED $($_.Exception.Message)"
    throw
}
