# ==============================================================================
# app-pay local development/test TLS certificate generation (PowerShell version, equivalent to gen-dev-cert.sh):
# Builds a mini-CA + server leaf certificate (PEM), output to app-pay/certs/ (gitignored).
#   ca.crt / pay.crt / pay.key —— see the .sh version's header comment for their meaning.
# SAN coverage: localhost / 127.0.0.1 / ::1 / app-pay / app-pay-test / 192.168.138.1.
# Do not use this script in production: mount a certificate issued by a real CA and configure PAY_TLS_CERT/PAY_TLS_KEY.
# ==============================================================================
$ErrorActionPreference = "Stop"

$Dir = Join-Path $PSScriptRoot "..\certs" | Resolve-Path -ErrorAction SilentlyContinue
if (-not $Dir) { $Dir = Join-Path $PSScriptRoot "..\certs" }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path

$DaysCa = 3650
$DaysServer = 825
$HostIp = if ($env:PAY_DEV_HOST_IP) { $env:PAY_DEV_HOST_IP } else { "192.168.138.1" }

# Prefer openssl from PATH, then common Git install locations (Windows has no built-in openssl)
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
    foreach ($cand in @(
        "$env:ProgramFiles\Git\usr\bin\openssl.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
        "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe")) {
        if (Test-Path $cand) { $openssl = $cand; break }
    }
}
if (-not $openssl) { throw "openssl.exe not found (install Git for Windows or add it to PATH)" }
Write-Host "==> openssl: $openssl"
Write-Host "==> Output directory: $Dir"

& $openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$Dir\ca.key" 2>$null
& $openssl req -x509 -new -key "$Dir\ca.key" -sha256 -days $DaysCa `
    -subj "/CN=app-pay-dev-ca/O=MindBase" `
    -addext "basicConstraints=critical,CA:TRUE" `
    -addext "keyUsage=critical,keyCertSign,cRLSign" `
    -out "$Dir\ca.crt"

& $openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$Dir\pay.key" 2>$null
& $openssl req -new -key "$Dir\pay.key" -subj "/CN=app-pay/O=MindBase" -out "$Dir\pay.csr"
@"
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:app-pay,DNS:app-pay-test,IP:127.0.0.1,IP:$HostIp,IP:::1
"@ | Set-Content -Encoding ascii -Path "$Dir\pay.ext"

& $openssl x509 -req -in "$Dir\pay.csr" `
    -CA "$Dir\ca.crt" -CAkey "$Dir\ca.key" -CAcreateserial `
    -days $DaysServer -sha256 -extfile "$Dir\pay.ext" -out "$Dir\pay.crt" 2>$null
Remove-Item "$Dir\pay.csr", "$Dir\pay.ext", "$Dir\ca.srl" -ErrorAction SilentlyContinue

Write-Host "==> Done. Certificate SAN summary:"
& $openssl x509 -in "$Dir\pay.crt" -noout -subject -dates -ext subjectAltName
Write-Host "==> Next: restart app-pay (local IDE/mvn or docker compose); app-task (which needs precise timeout delegation) mounts ca.crt."
