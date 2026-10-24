#Requires -Version 5.1
<#
install.ps1 — install the dsh-wechat-share plugin into the DSH web profile.

DryRun (default): prints every action ([check]/[will]) and validates
prerequisites; makes NO changes. -Execute: runs for real.

Execution order (T9 spec):
  1. make-msix.ps1 — register the WeChat share target (developer mode)
  2. copy the plugin package to
     profiles\.generations\live\dsh-wechat-share+1.0.0+<hash12>\node_modules\dsh-wechat-share\
     (hash12 = deterministic sha256 over the package files, first 12 hex)
  3. profile package.json — 4 injection points (node JSON DOM rewrite):
     dependencies, pnpm.overrides, dsh.profile.bundles,
     dsh.desktop.generationProjection.plugins
  4. dsh.cmd install (profile dir)
  5. verify: node resolves dsh-wechat-share from the profile node_modules
  6. hint: HMR activates the bundle; restart DSH if the overlay is absent
#>
[CmdletBinding()]
param(
    [switch]$DryRun,   # explicit dry-run (also the default when -Execute is absent)
    [switch]$Execute,
    [string]$ProfileDir = '',
    [string]$DshCmd = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot 'plugin'
$harnessHome = Join-Path $env:APPDATA 'dsh-desktop\harness'
if (-not $ProfileDir) { $ProfileDir = Join-Path $harnessHome 'profiles\web' }
if (-not $DshCmd) { $DshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd' }
$node = Join-Path $env:APPDATA 'dsh-desktop\harness\plugins\rea-bundle\vendor\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }

$pluginName = 'dsh-wechat-share'
$pluginVersion = '1.0.0'
$genDirName = $null   # filled after hash computation
$failures = 0

function Say([string]$m) { Write-Output $m }
function Check([string]$what, [bool]$ok, [string]$detail = '') {
    if ($ok) { Say "[check] OK   $what" }
    else { Say "[check] FAIL $what $(if ($detail) { "— $detail" } else { '' })"; $script:failures++ }
}
function Will([string]$what) {
    if ($Execute) { Say "[do]    $what" }
    else { Say "[will]  $what" }
}

Say "=== dsh-wechat-share install ($($(if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' }))) ==="

# ── prerequisites ─────────────────────────────────────────────────────────
Check "profile dir exists" (Test-Path -LiteralPath $ProfileDir) $ProfileDir
Check "profile package.json exists" (Test-Path -LiteralPath (Join-Path $ProfileDir 'package.json'))
Check "dsh.cmd exists" (Test-Path -LiteralPath $DshCmd) $DshCmd
Check "node (pinned vendor) exists" (Test-Path -LiteralPath $node) $node

$requiredFiles = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg',
    'lib\inbox.js', 'lib\deliver.js', 'locale\zh.json', 'locale\en.json')
$missing = @()
foreach ($f in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir $f))) { $missing += $f }
}
Check "plugin files complete" ($missing.Count -eq 0) ($missing -join ', ')

if ($failures -gt 0) {
    Say "=== $failures prerequisite(s) failed — nothing to do ==="
    exit 1
}

# ── deterministic hash12 over the package files ───────────────────────────
$sha = [System.Security.Cryptography.SHA256]::Create()
$combined = New-Object System.Text.StringBuilder
Get-ChildItem -LiteralPath $pluginDir -Recurse -File | Sort-Object -Property FullName | ForEach-Object {
    $rel = $_.FullName.Substring($pluginDir.Length + 1).Replace('\', '/')
    $h = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($_.FullName))).Replace('-', '').ToLower()
    [void]$combined.AppendLine("$rel $h")
}
$hash12 = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($combined.ToString()))).Replace('-', '').ToLower().Substring(0, 12)
$genDirName = "$pluginName+$pluginVersion+$hash12"
$genDir = Join-Path $ProfileDir ".generations\live\$genDirName\node_modules\$pluginName"
Say "[check] OK   package hash12=$hash12 generation=$genDirName"

# ── step 1: share target ──────────────────────────────────────────────────
$makeMsix = Join-Path $repoRoot 'packaging\make-msix.ps1'
Check "make-msix.ps1 exists" (Test-Path -LiteralPath $makeMsix)
$registered = $null
try { $registered = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction Stop } catch {}
if ($registered) {
    Say "[check] OK   share target already registered: $($registered.PackageFullName)"
    Will "refresh share target (re-register via make-msix.ps1 -SkipRegister:$false)"
    if ($Execute) {
        & $makeMsix
        if ($LASTEXITCODE -ne 0) { throw "make-msix.ps1 failed ($LASTEXITCODE)" }
    }
} else {
    Will "register share target (make-msix.ps1; requires Developer Mode enabled in Settings)"
    if ($Execute) {
        & $makeMsix
        if ($LASTEXITCODE -ne 0) { throw "make-msix.ps1 failed ($LASTEXITCODE)" }
    }
}

# ── step 2: generation dir ────────────────────────────────────────────────
Will "copy plugin package → $genDir"
if ($Execute) {
    if (Test-Path -LiteralPath $genDir) { Remove-Item -LiteralPath $genDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $genDir | Out-Null
    Copy-Item -Path (Join-Path $pluginDir '*') -Destination $genDir -Recurse -Force
}

# ── step 3: profile package.json (4 injection points, node JSON DOM) ─────
$profilePkg = Join-Path $ProfileDir 'package.json'
$nodeScript = @'
const fs = require('fs');
const [p, genDirName, pluginName, version, genAbs] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[pluginName] = version;
pkg.pnpm = pkg.pnpm || {};
pkg.pnpm.overrides = pkg.pnpm.overrides || {};
pkg.pnpm.overrides[pluginName] = 'link:../.generations/live/' + genDirName + '/node_modules/' + pluginName;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
if (!pkg.dsh.profile.bundles.includes(pluginName)) pkg.dsh.profile.bundles.push(pluginName);
pkg.dsh.desktop = pkg.dsh.desktop || {};
pkg.dsh.desktop.generationProjection = pkg.dsh.desktop.generationProjection || {};
pkg.dsh.desktop.generationProjection.plugins = pkg.dsh.desktop.generationProjection.plugins || {};
pkg.dsh.desktop.generationProjection.plugins[pluginName] = {
  generationId: genDirName,
  visibleVersion: version,
  previousOverride: ''
};
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile package.json updated');
'@
$nodeScriptFile = Join-Path $env:TEMP "wxshare-install-pkg-$([guid]::NewGuid().ToString('N')).js"
Set-Content -LiteralPath $nodeScriptFile -Value $nodeScript -Encoding ascii
Will "inject 4 profile package.json points (dependencies / pnpm.overrides / dsh.profile.bundles / generationProjection.plugins)"
if ($Execute) {
    & $node $nodeScriptFile $profilePkg $genDirName $pluginName $pluginVersion $genDir
    if ($LASTEXITCODE -ne 0) { throw "profile package.json update failed ($LASTEXITCODE)" }
}
Remove-Item -LiteralPath $nodeScriptFile -Force -ErrorAction SilentlyContinue

# ── step 4: dsh.cmd install ───────────────────────────────────────────────
Will "run: $DshCmd install (in $ProfileDir)"
if ($Execute) {
    Push-Location $ProfileDir
    try { & $DshCmd install } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "dsh.cmd install failed ($LASTEXITCODE)" }
}

# ── step 5: verify resolution ─────────────────────────────────────────────
$verifyScript = @'
const path = process.argv[2];
const m = require(path);
if (typeof m.apply !== 'function') throw new Error('entry has no apply()');
console.log('resolved ' + path + ' (name=' + (m.name || '?') + ')');
'@
$verifyScriptFile = Join-Path $env:TEMP "wxshare-verify-$([guid]::NewGuid().ToString('N')).js"
Set-Content -LiteralPath $verifyScriptFile -Value $verifyScript -Encoding ascii
Will "verify: node resolves $pluginName from profile node_modules"
if ($Execute) {
    $resolvedProbe = Join-Path $ProfileDir "node_modules\$pluginName"
    if (-not (Test-Path -LiteralPath $resolvedProbe)) {
        Say "[verify] WARN profile node_modules link absent (dsh.cmd install may link lazily); generation dir present: $(Test-Path -LiteralPath $genDir)"
    } else {
        & $node $verifyScriptFile $resolvedProbe
        if ($LASTEXITCODE -ne 0) { throw "verification failed ($LASTEXITCODE)" }
    }
}
Remove-Item -LiteralPath $verifyScriptFile -Force -ErrorAction SilentlyContinue

# ── step 6: hint ──────────────────────────────────────────────────────────
Say "[hint] new bundle activates via HMR; if the WeChat-share overlay is absent from the GUI, restart DSH Desktop."
Say "=== done ($($(if ($Execute) { 'executed' } else { 'dry-run, nothing changed' }))) ==="
