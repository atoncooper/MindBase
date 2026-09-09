# ==============================================================================
# app-pay 本地开发/测试 TLS 证书生成（PowerShell 版，与 gen-dev-cert.sh 等价）：
# 自建 mini-CA + 服务端叶子证书（PEM），输出到 app-pay/certs/（gitignored）。
#   ca.crt / pay.crt / pay.key —— 含义见 .sh 版头部注释。
# SAN 覆盖：localhost / 127.0.0.1 / ::1 / app-pay / app-pay-test / 192.168.138.1。
# 生产不要用本脚本：挂载正式 CA 签发的证书并配置 PAY_TLS_CERT/PAY_TLS_KEY。
# ==============================================================================
$ErrorActionPreference = "Stop"

$Dir = Join-Path $PSScriptRoot "..\certs" | Resolve-Path -ErrorAction SilentlyContinue
if (-not $Dir) { $Dir = Join-Path $PSScriptRoot "..\certs" }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path

$DaysCa = 3650
$DaysServer = 825
$HostIp = if ($env:PAY_DEV_HOST_IP) { $env:PAY_DEV_HOST_IP } else { "192.168.138.1" }

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

Write-Host "==> 完成。证书 SAN 摘要："
& $openssl x509 -in "$Dir\pay.crt" -noout -subject -dates -ext subjectAltName
Write-Host "==> 下一步：重启 app-pay（本地 IDE/mvn 或 docker compose）；需要精确超时委托的 app-task 挂载 ca.crt。"
