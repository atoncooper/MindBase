#!/usr/bin/env bash
# ==============================================================================
# app-pay 本地开发/测试 TLS 证书生成：自建 mini-CA + 服务端叶子证书（PEM）。
#
# 输出到 app-pay/certs/（gitignored）：
#   ca.crt   自建 CA（调用方信任它：APISIX/浏览器可选、app-task 必需）
#   pay.crt  服务端证书（server.ssl.certificate）
#   pay.key  服务端私钥（server.ssl.certificate-private-key，PKCS#8 PEM）
#
# SAN 覆盖所有调用方使用的名字（新增调用方域名/IP 需重新生成）：
#   localhost / 127.0.0.1 / ::1           —— 本机浏览器与直连调试
#   app-pay / app-pay-test                —— docker 网络内服务名（APISIX、app-task）
#   192.168.138.1                         —— VM 开发宿主 IP（apisix.dev.yaml 上游）
#
# 重复执行会覆盖旧证书；换 CA 后调用方持有的旧 ca.crt 需重新分发。
# 生产不要用本脚本：挂载正式 CA 签发的证书并配置 PAY_TLS_CERT/PAY_TLS_KEY。
# ==============================================================================
set -euo pipefail

# Git Bash(MSYS) 会把 -subj "/CN=..." 当 POSIX 路径转换成 Windows 路径，必须禁用；
# 两个变量在原生 Linux bash 下未定义/无副作用，脚本可双平台复用。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
DAYS_CA=3650
DAYS_SERVER=825
HOST_IP="${PAY_DEV_HOST_IP:-192.168.138.1}"   # VM 开发宿主 IP，可用 env 覆盖

mkdir -p "$DIR"
# 统一 cd 进输出目录用【相对文件名】操作 openssl：mingw64 原生版 openssl
# 不认 /d/... POSIX 路径，而 -subj 又依赖 NO_PATHCONV，相对路径两边都兼容
cd "$DIR"

echo "==> 输出目录: $DIR"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days "$DAYS_CA" \
  -subj "/CN=app-pay-dev-ca/O=MindBase" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.crt

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out pay.key 2>/dev/null
openssl req -new -key pay.key -subj "/CN=app-pay/O=MindBase" -out pay.csr
cat > pay.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:app-pay,DNS:app-pay-test,IP:127.0.0.1,IP:${HOST_IP},IP:::1
EOF
openssl x509 -req -in pay.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "$DAYS_SERVER" -sha256 -extfile pay.ext -out pay.crt 2>/dev/null
rm -f pay.csr pay.ext ca.srl
chmod 600 pay.key ca.key 2>/dev/null || true

echo "==> 完成。证书 SAN 摘要："
openssl x509 -in pay.crt -noout -subject -dates -ext subjectAltName
echo "==> 下一步：重启 app-pay（本地 IDE/mvn 或 docker compose）；需要精确超时委托的 app-task 挂载 ca.crt。"
