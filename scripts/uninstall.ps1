#Requires -Version 5.1
<#
uninstall.ps1 — remove the dsh-wechat-share plugin from the DSH web profile.

DryRun (default): prints every action; makes NO changes. -Execute: runs.
Reverse of install.ps1:
  1. profile package.json — remove the 4 injection points (node JSON DOM)
  2. delete the generation dir (.generations\live\dsh-wechat-share+*)
  3. dsh.cmd install (profile dir)
  4. unregister the share target (Add-AppxPackage removal)
#>
[CmdletBinding()]
param(
    [switch]$DryRun,   # explicit dry-run (also the default when -Execute is absent)
    [switch]$Execute,
    [string]$ProfileDir = '',
    [string]$DshCmd = ''
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-wechat-share'
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web' }
if (-not $DshCmd) { $DshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd' }
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

Say "=== dsh-wechat-share uninstall ($($(if ($Execute) { 'EXECUTE' } else { 'DRY-RUN' }))) ==="

Check "profile dir exists" (Test-Path -LiteralPath $ProfileDir) $ProfileDir
$profilePkg = Join-Path $ProfileDir 'package.json'
Check "profile package.json exists" (Test-Path -LiteralPath $profilePkg)
Check "dsh.cmd exists" (Test-Path -LiteralPath $DshCmd) $DshCmd
if ($failures -gt 0) { Say "=== prerequisites failed — nothing to do ==="; exit 1 }

# ── locate the generation dir(s) ──────────────────────────────────────────
$genRoot = Join-Path $ProfileDir '.generations\live'
$genDirs = @()
if (Test-Path -LiteralPath $genRoot) {
    $genDirs = Get-ChildItem -LiteralPath $genRoot -Directory | Where-Object { $_.Name -like "$pluginName+*" } | Select-Object -ExpandProperty FullName
}
Say "[check] OK   generation dirs: $(if ($genDirs.Count) { $genDirs -join '; ' } else { 'none' })"

# ── step 1: profile package.json (remove 4 points) ───────────────────────
$node = Join-Path $env:APPDATA 'dsh-desktop\harness\plugins\rea-bundle\vendor\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
$nodeScript = @'
const fs = require('fs');
const [p, pluginName] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
let changed = 0;
if (pkg.dependencies && pluginName in pkg.dependencies) { delete pkg.dependencies[pluginName]; changed++; }
if (pkg.pnpm && pkg.pnpm.overrides && pluginName in pkg.pnpm.overrides) { delete pkg.pnpm.overrides[pluginName]; changed++; }
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  const i = pkg.dsh.profile.bundles.indexOf(pluginName);
  if (i >= 0) { pkg.dsh.profile.bundles.splice(i, 1); changed++; }
}
if (pkg.dsh && pkg.dsh.desktop && pkg.dsh.desktop.generationProjection &&
    pkg.dsh.desktop.generationProjection.plugins &&
    pluginName in pkg.dsh.desktop.generationProjection.plugins) {
  delete pkg.dsh.desktop.generationProjection.plugins[pluginName]; changed++;
}
if (changed > 0) fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile package.json: ' + changed + ' point(s) removed');
'@
$nodeScriptFile = Join-Path $env:TEMP "wxshare-uninstall-pkg-$([guid]::NewGuid().ToString('N')).js"
Set-Content -LiteralPath $nodeScriptFile -Value $nodeScript -Encoding ascii
Will "remove 4 profile package.json points (dependencies / pnpm.overrides / dsh.profile.bundles / generationProjection.plugins)"
if ($Execute) {
    & $node $nodeScriptFile $profilePkg $pluginName
    if ($LASTEXITCODE -ne 0) { throw "profile package.json update failed ($LASTEXITCODE)" }
}
Remove-Item -LiteralPath $nodeScriptFile -Force -ErrorAction SilentlyContinue

# ── step 2: generation dirs ───────────────────────────────────────────────
foreach ($g in $genDirs) {
    Will "delete generation dir $g"
    if ($Execute) { Remove-Item -LiteralPath $g -Recurse -Force }
}

# ── step 3: pnpm de-registration ─────────────────────────────────────────
# `dsh plugin --profile web remove <pkg>` is the clean path when present;
# the profile package.json removal (step 1) is the source of truth and the
# runner reconciles pnpm-lock on the next plugin install / DSH load.
Will "reconcile pnpm state after removal (best-effort runner pass)"
if ($Execute) {
    Push-Location $ProfileDir
    try {
        & $DshCmd plugin --profile web remove 'dsh-wechat-share'
        if ($LASTEXITCODE -ne 0) {
            Say "[warn] dsh plugin remove unavailable/failed ($LASTEXITCODE) — package.json strip stands; lockfile reconciles on next load"
        }
    } finally { Pop-Location }
}

# ── step 4: unregister share target ──────────────────────────────────────
$registered = $null
try { $registered = Get-AppxPackage -Name 'DshDesktop.ShareTarget' -ErrorAction Stop } catch {}
if ($registered) {
    Will "unregister share target $($registered.PackageFullName)"
    if ($Execute) {
        # Y8 (review): cmdlet — no $LASTEXITCODE; EAP=Stop throws on failure
        Remove-AppxPackage -Package $registered.PackageFullName
    }
} else {
    Say "[check] OK   no share target registered"
}

Say "=== done ($($(if ($Execute) { 'executed' } else { 'dry-run, nothing changed' }))) ==="
