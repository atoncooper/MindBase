# ==============================================================================
# app-pay-admin 本地开发 TLS 证书生成（PowerShell 版，与 gen-dev-cert.sh 等价）：
# 自建 mini-CA + 服务端叶子证书，输出到 app-pay-admin/certs/（gitignored）。
#   ca.crt / admin.crt / admin.key —— 用法见 .sh 版头部注释。
# SAN 覆盖：localhost / 127.0.0.1 / ::1 / app-pay-admin。
# 生产不要用本脚本：挂正式 CA 签发证书。
# ==============================================================================
$ErrorActionPreference = "Stop"

$Dir = Join-Path $PSScriptRoot "..\certs"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path

$DaysCa = 3650
$DaysServer = 825

# openssl 优先取 PATH，其次常见 Git 安装位置（Windows 无内置 openssl）
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
    foreach ($cand in @(
        "$env:ProgramFiles\Git\usr\bin\openssl.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
        "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe")) {
        if (Test-Path $cand) { $openssl = $cand; break }
    }
}
if (-not $openssl) { throw "未找到 openssl.exe（请安装 Git for Windows 或加入 PATH）" }
Write-Host "==> openssl: $openssl"
Write-Host "==> 输出目录: $Dir"

& $openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$Dir\ca.key" 2>$null
& $openssl req -x509 -new -key "$Dir\ca.key" -sha256 -days $DaysCa `
    -subj "/CN=app-pay-admin-dev-ca/O=MindBase" `
    -addext "basicConstraints=critical,CA:TRUE" `
    -addext "keyUsage=critical,keyCertSign,cRLSign" `
    -out "$Dir\ca.crt"

& $openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$Dir\admin.key" 2>$null
& $openssl req -new -key "$Dir\admin.key" -subj "/CN=app-pay-admin/O=MindBase" -out "$Dir\admin.csr"

$SanFile = "$env:TEMP\apa-san.cnf"
@"
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1,DNS:app-pay-admin
"@ | Set-Content -Encoding ASCII $SanFile

& $openssl x509 -req -in "$Dir\admin.csr" -CA "$Dir\ca.crt" -CAkey "$Dir\ca.key" `
    -CAcreateserial -days $DaysServer -sha256 `
    -extfile $SanFile -out "$Dir\admin.crt" 2>$null
Remove-Item "$Dir\admin.csr" -ErrorAction SilentlyContinue
Remove-Item "$Dir\ca.srl" -ErrorAction SilentlyContinue
Remove-Item $SanFile -ErrorAction SilentlyContinue

Write-Host "==> 生成完成: ca.crt / admin.crt / admin.key"
Write-Host "==> 启用方式: PAYADMIN__SERVER__TLS__ENABLED=true PAYADMIN__SERVER__TLS__CERT=$Dir\admin.crt PAYADMIN__SERVER__TLS__KEY=$Dir\admin.key"
