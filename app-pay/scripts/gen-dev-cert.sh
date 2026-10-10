#!/usr/bin/env bash
# ==============================================================================
# app-pay local development/test TLS certificate generation: builds a mini-CA + server leaf certificate (PEM).
#
# Output to app-pay/certs/ (gitignored):
#   ca.crt   self-built CA (callers must trust it: optional for APISIX/browser, required for app-task)
#   pay.crt  server certificate (server.ssl.certificate)
#   pay.key  server private key (server.ssl.certificate-private-key, PKCS#8 PEM)
#
# SAN covers every name used by callers (regenerate when adding a caller domain/IP):
#   localhost / 127.0.0.1 / ::1           —— local browser and direct debugging
#   app-pay / app-pay-test                —— service names inside the docker network (APISIX, app-task)
#   192.168.138.1                         —— VM development host IP (apisix.dev.yaml upstream)
#
# Re-running overwrites the old certificate; after switching CA, redistribute the old ca.crt held by callers.
# Do not use this script in production: mount a certificate issued by a real CA and configure PAY_TLS_CERT/PAY_TLS_KEY.
# ==============================================================================
set -euo pipefail

# Git Bash (MSYS) treats -subj "/CN=..." as a POSIX path and converts it to a Windows path, so it must be disabled;
# Both variables are undefined/no-ops under native Linux bash, so the script works on both platforms.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
DAYS_CA=3650
DAYS_SERVER=825
HOST_IP="${PAY_DEV_HOST_IP:-192.168.138.1}"   # VM development host IP, overridable via env

mkdir -p "$DIR"
# cd into the output directory and use [relative file names] with openssl: the mingw64 native openssl
# does not accept /d/... POSIX paths, while -subj depends on NO_PATHCONV, so relative paths work on both
cd "$DIR"

echo "==> Output directory: $DIR"
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

echo "==> Done. Certificate SAN summary:"
openssl x509 -in pay.crt -noout -subject -dates -ext subjectAltName
echo "==> Next: restart app-pay (local IDE/mvn or docker compose); app-task (which needs precise timeout delegation) mounts ca.crt."
