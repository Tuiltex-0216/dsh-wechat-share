param([string]$pfx, [string]$pass, [string]$outKeyJson, [string]$outCer)
try {
  $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfx, $pass)
  Write-Output ("nested OK: " + $c.Subject + " hasKey=" + $c.HasPrivateKey)
  $rsa = $c.GetRSAPrivateKey()
  Write-Output ("rsa key present: " + ($rsa -ne $null))
  $p = $rsa.ExportParameters($true)
  $json = '{"modulus":"' + [Convert]::ToBase64String($p.Modulus) + '","exponent":"' + [Convert]::ToBase64String($p.Exponent) + '","p":"' + [Convert]::ToBase64String($p.P) + '","q":"' + [Convert]::ToBase64String($p.Q) + '","dp":"' + [Convert]::ToBase64String($p.DP) + '","dq":"' + [Convert]::ToBase64String($p.DQ) + '","inverseQ":"' + [Convert]::ToBase64String($p.InverseQ) + '","d":"' + [Convert]::ToBase64String($p.D) + '"}'
  [IO.File]::WriteAllText($outKeyJson, $json)
  [IO.File]::WriteAllBytes($outCer, $c.RawData)
  Write-Output "exported key+cert"
} catch {
  Write-Output ("nested FAIL: " + $_.Exception.Message)
  Write-Output $_.Exception.StackTrace
}
