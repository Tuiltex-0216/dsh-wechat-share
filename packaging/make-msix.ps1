#Requires -Version 5.1
<#
make-msix.ps1 — build, sign, and register the DSH Harness share-target MSIX.

Idempotent: re-runs reuse the dev cert (fingerprint-pinned), restage, re-sign,
and re-register. Logs to packaging\logs\make-msix-<ts>.log.
Final stdout line: the registered PackageFullName.

Steps: ensure stub\dist -> generate assets -> dev cert (+trust) ->
       MakeAppx/signtool (from Microsoft.Windows.SDK.BuildTools nupkg) ->
       pack -> sign -> verify -> register (ExternalLocation) -> identity probe.
#>
[CmdletBinding()]
param(
    [string]$ExternalLocation = '',
    [switch]$SkipTrust
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packDir = $PSScriptRoot
$distDir = if ($ExternalLocation) { $ExternalLocation } else { Join-Path $repoRoot 'stub\dist' }
$toolsDir = Join-Path $packDir 'tools'
$certDir = Join-Path $packDir 'certs'
$assetDir = Join-Path $packDir 'Assets'
$stageDir = Join-Path $packDir 'stage'
$logDir = Join-Path $packDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("make-msix-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$m) { Add-Content -Path $logFile -Value ("{0:O} {1}" -f [DateTimeOffset]::UtcNow, $m) }
function Test-IsAdmin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
    Log "start dist=$distDir"

    # ── 1. stub\dist — always republish: dotnet publish is incremental and
    #      fast when current; a presence-only check shipped a stale exe once
    #      (T3: dist from T2 lacked --gen-assets and the probe exited 0 silent).
    $stubExe = Join-Path $distDir 'WeChatShare.Stub.exe'
    Log "publishing stub..."
    $dotnet = & (Join-Path $repoRoot 'scripts\ensure-dotnet.ps1')
    if (-not $dotnet) { throw "ensure-dotnet returned no path" }
    & $dotnet publish (Join-Path $repoRoot 'stub') -c Release -o $distDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed ($LASTEXITCODE)" }
    if (-not (Test-Path -LiteralPath $stubExe)) { throw "stub exe missing after publish: $stubExe" }

    # ── 2. assets (share-target logos) ──────────────────────────────────────
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

    # ── 3. dev cert (fingerprint-pinned) ────────────────────────────────────
    New-Item -ItemType Directory -Force -Path $certDir | Out-Null
    $pfxPath = Join-Path $certDir 'DshDesktop.Dev.pfx'
    $cerPath = Join-Path $certDir 'DshDesktop.Dev.cer'
    $pinPath = Join-Path $certDir 'fingerprints.json'
    $passPath = Join-Path $certDir 'pfx-password.txt'
    if (-not (Test-Path -LiteralPath $pfxPath)) {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=DSH Desktop Dev' `
            -KeyUsage DigitalSignature -KeyLength 2048 -HashAlgorithm SHA256 `
            -NotAfter (Get-Date).AddYears(5) -FriendlyName 'DSH Desktop Dev' `
            -CertStoreLocation Cert:\CurrentUser\My
        # ASCII DIGIT characters: [string](Get-Random) — [char](0..9) would be
        # control chars U+0000..U+0009 (a NUL truncates native argv; bit us).
        $pass = -join ((1..32) | ForEach-Object { [string](Get-Random -Maximum 10) })
        [IO.File]::WriteAllText($passPath, $pass) # no trailing newline: X509 rejects it
        Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password (ConvertTo-SecureString $pass -AsPlainText -Force) | Out-Null
        Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null
        Set-Content -LiteralPath $pinPath -Value ('{{"leaf":"{0}"}}' -f $cert.Thumbprint) -Encoding ascii
        Log "minted dev cert $($cert.Thumbprint)"
    } else {
        $loaded = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $pfxPath,
            (Get-Content -LiteralPath $passPath -Raw).Trim())
        if (Test-Path -LiteralPath $pinPath) {
            $pin = Get-Content -LiteralPath $pinPath -Raw | ConvertFrom-Json
            if ($loaded.Thumbprint -cne $pin.leaf) {
                throw "cert fingerprint mismatch: pfx=$($loaded.Thumbprint) pin=$($pin.leaf) — refusing to trust unpinned bytes"
            }
        } else {
            # pin missing (interrupted first run): re-pin from the loaded cert
            Set-Content -LiteralPath $pinPath -Value ('{{"leaf":"{0}"}}' -f $loaded.Thumbprint) -Encoding ascii
            Log "pin file was missing; re-pinned $($loaded.Thumbprint)"
        }
        if (-not (Test-Path -LiteralPath $cerPath)) {
            # re-export cer from pfx so trust import has the payload
            $loaded | Export-Certificate -FilePath $cerPath -Type CERT | Out-Null
        }
        $loaded.Dispose()
        Log "reusing pinned dev cert $($pin.leaf)"
    }

    # ── 4. trust the leaf in LocalMachine\TrustedPeople ────────────────────
    if (-not $SkipTrust) {
        $leaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cerPath)
        $inStore = [bool](Get-ChildItem Cert:\LocalMachine\TrustedPeople -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $leaf.Thumbprint })
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        $chain.ChainPolicy.RevocationMode = 'NoCheck'
        $chainTrusted = $chain.Build($leaf)
        $chain.Dispose()
        $leaf.Dispose()
        if (-not $inStore -and -not $chainTrusted) {
            if (Test-IsAdmin) {
                Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPeople -Confirm:$false | Out-Null
                Log "trusted leaf in LocalMachine\TrustedPeople"
            } else {
                $cmd = "-NoProfile -ExecutionPolicy Bypass -Command `"Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPeople -Confirm:`$false`""
                $proc = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $cmd -Verb RunAs -WindowStyle Hidden -Wait -PassThru
                if ($proc.ExitCode -ne 0) { throw "certificate import failed or was cancelled ($($proc.ExitCode))" }
                Log "trusted leaf (elevated)"
            }
        } else {
            Log "leaf already trusted; no import"
        }
    } else {
        Log "skip trust (-SkipTrust)"
    }

    # ── 5. MakeAppx + signtool from BuildTools nupkg ───────────────────────
    $makeappx = Join-Path $toolsDir 'bin\10.0.22621.0\x64\makeappx.exe'
    $signtool = Join-Path $toolsDir 'bin\10.0.22621.0\x64\signtool.exe'
    if (-not (Test-Path -LiteralPath $makeappx) -or -not (Test-Path -LiteralPath $signtool)) {
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

    # ── 6. stage + pack ─────────────────────────────────────────────────────
    # MakeAppx validates the manifest against the package CONTENTS: the
    # declared Executable must exist in the package even though
    # -ExternalLocation redirects physical placement to stub\dist at
    # registration time (same shape as WeChatBridge's sparse package).
    if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $packDir 'AppxManifest.xml') -Destination $stageDir
    Copy-Item -LiteralPath $assetDir -Destination (Join-Path $stageDir 'Assets') -Recurse
    Copy-Item -Path (Join-Path $distDir '*') -Destination $stageDir -Recurse
    $msix = Join-Path $packDir 'dist\DshDesktop.ShareTarget.msix'
    New-Item -ItemType Directory -Force -Path (Split-Path $msix) | Out-Null
    & $makeappx pack /d $stageDir /p $msix /o
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed ($LASTEXITCODE)" }
    Log "packed $msix"

    # ── 7. sign ─────────────────────────────────────────────────────────────
    $pass = (Get-Content -LiteralPath $passPath -Raw).Trim()
    & $signtool sign /fd SHA256 /f $pfxPath /p $pass $msix
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed ($LASTEXITCODE)" }
    $sig = Get-AuthenticodeSignature -FilePath $msix
    if ($sig.Status -ne 'Valid') { throw "MSIX signature is not trusted: $($sig.Status)" }
    Log "signed + verified"

    # ── 8. register (ExternalLocation: exe stays in stub\dist) ─────────────
    $existing = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-AppxPackage -Package $existing.PackageFullName -ErrorAction SilentlyContinue
        Log "removed previous $($existing.PackageFullName)"
    }
    Add-AppxPackage -Path $msix -ExternalLocation $distDir
    if ($LASTEXITCODE -ne 0) { throw "Add-AppxPackage failed ($LASTEXITCODE)" }
    $registered = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction SilentlyContinue
    if (-not $registered) { throw 'package registration did not stick' }
    if ($registered.Status -ne 'Ok') { throw "registered package unhealthy: $($registered.Status)" }
    Log "registered $($registered.PackageFullName)"

    # ── 9. identity probe ───────────────────────────────────────────────────
    $probe = & $stubExe --registration-check
    $identity = $probe | ConvertFrom-Json
    if ($identity.PackageFullName -cne $registered.PackageFullName) {
        throw "identity mismatch: probe=$($identity.PackageFullName) registered=$($registered.PackageFullName)"
    }
    $expectedAumid = ($registered.PackageFamilyName + '!Share.Hub')
    if ($identity.ApplicationUserModelId -cne $expectedAumid) {
        throw "AUMID mismatch: probe=$($identity.ApplicationUserModelId) expected=$expectedAumid"
    }
    Log "identity probe ok ($expectedAumid)"

    Write-Output $registered.PackageFullName
}
catch {
    Log "FAILED $($_.Exception.Message)"
    throw
}
