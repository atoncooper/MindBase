#!/usr/bin/env bash
# ==============================================================================
# app-pay-admin 本地开发 TLS 证书生成：自建 mini-CA + 服务端叶子证书（PEM）。
# 与 app-pay/scripts/gen-dev-cert.* 同一套做法，输出到 app-pay-admin/certs/
# （gitignored）：
#   ca.crt     自建 CA（浏览器可选信任；信任后无证书告警）
#   admin.crt  服务端证书（PAYADMIN__SERVER__TLS__CERT）
#   admin.key  服务端私钥（PAYADMIN__SERVER__TLS__KEY，PKCS#8 PEM）
#
# SAN 覆盖：localhost / 127.0.0.1 / ::1 / app-pay-admin。
# 重复执行会覆盖旧证书。生产不要用本脚本：挂正式 CA 签发证书。
# ==============================================================================
set -euo pipefail

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
DAYS_CA=3650
DAYS_SERVER=825

mkdir -p "$DIR"
cd "$DIR"

echo "==> 输出目录: $DIR"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ca.key 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days "$DAYS_CA" \
  -subj "/CN=app-pay-admin-dev-ca/O=MindBase" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.crt

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out admin.key 2>/dev/null
openssl req -new -key admin.key \
  -subj "/CN=app-pay-admin/O=MindBase" -out admin.csr
# extfile 写临时文件而非进程替换 /dev/fd：mingw64 原生 openssl.exe 读不了它
printf '%s\n' \
  "basicConstraints=critical,CA:FALSE" \
  "keyUsage=critical,digitalSignature,keyEncipherment" \
  "extendedKeyUsage=serverAuth" \
  "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1,DNS:app-pay-admin" > ext.cnf
openssl x509 -req -in admin.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "$DAYS_SERVER" -sha256 -extfile ext.cnf -out admin.crt 2>/dev/null
rm -f admin.csr ca.srl ext.cnf

echo "==> 生成完成: ca.crt / admin.crt / admin.key"
echo "==> 启用方式: PAYADMIN__SERVER__TLS__ENABLED=true \
PAYADMIN__SERVER__TLS__CERT=<路径>/admin.crt PAYADMIN__SERVER__TLS__KEY=<路径>/admin.key"
