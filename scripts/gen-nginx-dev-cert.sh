#!/usr/bin/env bash
# Generate the self-signed dev certificate for the nginx HTTPS entry
# (Option A: https://localhost works, browser shows a one-time warning).
#
# Output: nginx/certs/fullchain.pem + privkey.pem (gitignored), matching the
# paths in nginx/nginx.conf's 443 server block.
# Runs in Git Bash / any shell with openssl. To get rid of the browser
# warning entirely, trust this cert in the OS store or switch to mkcert.
set -euo pipefail
cd "$(dirname "$0")/../nginx/certs"

# MSYS2/Git Bash rewrites "/CN=..." into a Windows path; exclude all args.
export MSYS2_ARG_CONV_EXCL="*"
rm -f fullchain.pem privkey.pem
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout privkey.pem -out fullchain.pem -days 825 -nodes \
    -subj "/CN=localhost/O=MindBase" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null

echo "generated:"
ls -la fullchain.pem privkey.pem
