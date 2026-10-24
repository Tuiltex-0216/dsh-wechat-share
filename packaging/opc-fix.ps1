#Requires -Version 5.1
<#
opc-fix.ps1 — complete a MakeAppx-packaged MSIX for signtool recognition:
add the missing _rels/.rels package-relationship part and the `rels`
content-type default. (BuildTools 10.0.22621.755 makeappx omits _rels/.rels;
signtool then refuses the package as "not recognized".)
Usage: opc-fix.ps1 <path-to-msix>
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$MsixPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($MsixPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    # 1) _rels/.rels (skip if present)
    if (-not $zip.GetEntry('_rels/.rels')) {
        $entry = $zip.CreateEntry('_rels/.rels')
        $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
        $writer.Write('<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="AppxManifest.xml" Id="appx" Type="http://schemas.microsoft.com/appx/2010/relationships/manifest"/></Relationships>')
        $writer.Flush()
        $writer.Close()
        Write-Output 'added _rels/.rels'
    }
    # 2) [Content_Types].xml: ensure rels default
    $ct = $zip.GetEntry('[Content_Types].xml')
    $reader = [System.IO.StreamReader]::new($ct.Open())
    $xml = $reader.ReadToEnd()
    $reader.Close()
    if ($xml -notmatch 'Extension="rels"') {
        $xml = $xml -replace '</Types>', '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>'
        $ct.Delete()
        $ct2 = $zip.CreateEntry('[Content_Types].xml')
        $writer2 = [System.IO.StreamWriter]::new($ct2.Open(), [System.Text.UTF8Encoding]::new($false))
        $writer2.Write($xml)
        $writer2.Flush()
        $writer2.Close()
        Write-Output 'patched [Content_Types].xml'
    }
}
finally {
    $zip.Dispose()
}
Write-Output "opc-fix done: $MsixPath"
