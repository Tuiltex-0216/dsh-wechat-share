#Requires -Version 5.1
<#
extract-key.ps1 — export the RSA private key + certificate from a PFX.

Pure PowerShell (.NET Framework CAPI path): on this host the C#-compiled
X509Certificate2 ctor route hits a blocked CNG import ("operation not
supported"), while the classic PS New-Object route loads the key fine.

usage: extract-key.ps1 -Pfx <pfx> -Password <pass> -OutKeyJson <json> -OutCer <cer>
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Pfx,
    [Parameter(Mandatory)][string]$Password,
    [Parameter(Mandatory)][string]$OutKeyJson,
    [Parameter(Mandatory)][string]$OutCer
)
$ErrorActionPreference = 'Stop'

$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $Password)
if (-not $c.HasPrivateKey) { throw "PFX has no private key" }
$p = $c.PrivateKey.ExportParameters($true)
$json = '{"modulus":"' + [Convert]::ToBase64String($p.Modulus) + '","exponent":"' + [Convert]::ToBase64String($p.Exponent) + '","p":"' + [Convert]::ToBase64String($p.P) + '","q":"' + [Convert]::ToBase64String($p.Q) + '","dp":"' + [Convert]::ToBase64String($p.DP) + '","dq":"' + [Convert]::ToBase64String($p.DQ) + '","inverseQ":"' + [Convert]::ToBase64String($p.InverseQ) + '","d":"' + [Convert]::ToBase64String($p.D) + '"}'
[IO.File]::WriteAllText($OutKeyJson, $json)
[IO.File]::WriteAllBytes($OutCer, $c.RawData)
Write-Output "extracted: cert=$($c.Thumbprint) key-> $OutKeyJson cer-> $OutCer"
