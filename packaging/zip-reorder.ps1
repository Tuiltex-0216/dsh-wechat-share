#Requires -Version 5.1
<#
zip-reorder.ps1 — rewrite a zip so OPC-critical entries come first:
[Content_Types].xml, _rels/.rels, AppxManifest.xml, AppxBlockMap.xml, then the
rest in original order. Diagnosed workaround: BuildTools makeappx emits the
manifest entries last, and SDK signtool's APPX detector then fails with
"file format cannot be signed because it is not recognized".
Usage: zip-reorder.ps1 <in.msix> <out.msix>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$In,
    [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$priority = @('[Content_Types].xml', '_rels/.rels', 'AppxManifest.xml', 'AppxBlockMap.xml')

$src = [System.IO.Compression.ZipFile]::OpenRead($In)
try {
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
    $dstStream = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
    $dst = New-Object System.IO.Compression.ZipArchive($dstStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $entries = @($src.Entries)
        $ordered = @($entries | Where-Object { $priority -contains $_.FullName }) +
                   @($entries | Where-Object { $priority -notcontains $_.FullName })
        foreach ($e in $ordered) {
            $ne = $dst.CreateEntry($e.FullName, [System.IO.Compression.CompressionLevel]::Optimal)
            $inS = $e.Open()
            $outS = $ne.Open()
            try { $inS.CopyTo($outS) } finally { $inS.Dispose(); $outS.Dispose() }
        }
    }
    finally {
        $dst.Dispose()
        $dstStream.Dispose()
    }
}
finally {
    $src.Dispose()
}
Write-Output "reordered: $In -> $Out"
