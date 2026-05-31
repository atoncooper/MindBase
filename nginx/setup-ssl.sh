#!/bin/bash
# ============================================================
# SSL Certificate Setup — self-signed (dev) or Let's Encrypt
# ============================================================
#
# Usage:
#   ./nginx/setup-ssl.sh              → generate self-signed (testing)
#   ./nginx/setup-ssl.sh letsencrypt  → interactive Let's Encrypt
#
# Prerequisites for Let's Encrypt:
#   - A public domain name pointing to this server
#   - Port 80 must be reachable from the internet
#   - DNS A record: your-domain.com → server IP
# ============================================================

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$CERT_DIR"

MODE="${1:-selfsigned}"

# ── Self-signed (dev / testing) ──────────────────────────
if [ "$MODE" = "selfsigned" ]; then
    if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
        echo "[SSL] Certs already exist in $CERT_DIR — skip."
        exit 0
    fi

    echo "[SSL] Generating self-signed certificate..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out    "$CERT_DIR/fullchain.pem" \
        -subj   "/CN=localhost"

    echo "[SSL] Done.  Self-signed certs written to $CERT_DIR"
    echo "[SSL] ⚠️  Browsers will show a warning — click Advanced → Proceed."

# ── Let's Encrypt ───────────────────────────────────────
elif [ "$MODE" = "letsencrypt" ]; then
    DOMAIN="${2:-}"
    EMAIL="${3:-}"

    if [ -z "$DOMAIN" ]; then
        read -rp "Domain name (e.g. bilirag.example.com): " DOMAIN
    fi
    if [ -z "$EMAIL" ]; then
        read -rp "Email (for expiry notices): " EMAIL
    fi

    echo "[SSL] Requesting Let's Encrypt cert for $DOMAIN ..."

    # Stop nginx temporarily (certbot needs port 80)
    docker compose stop nginx 2>/dev/null || true

    docker run --rm \
        -v "$CERT_DIR:/etc/letsencrypt/live/$DOMAIN" \
        -v "$(pwd)/nginx/certbot-www:/var/www/certbot" \
        certbot/certbot \
        certonly --standalone \
        --non-interactive --agree-tos \
        -m "$EMAIL" \
        -d "$DOMAIN"

    # certbot writes to /etc/letsencrypt/live/$DOMAIN/{fullchain,privkey}.pem
    # We symlink / copy them into certs/
    LE_LIVE="/etc/letsencrypt/live/$DOMAIN"
    if [ -f "$CERT_DIR/fullchain.pem" ]; then
        echo "[SSL] Certs obtained successfully for $DOMAIN"
    else
        echo "[SSL] ERROR: Failed to obtain certs. Check certbot output above."
        exit 1
    fi

    echo "[SSL] Starting nginx..."
    docker compose up -d nginx

    echo "[SSL] Done.  HTTPS is now active for https://$DOMAIN"
    echo "[SSL] Certbot auto-renewal: add this to crontab:"
    echo "  0 3 * * * docker run --rm -v ... certbot/certbot renew --quiet && docker compose exec nginx nginx -s reload"

else
    echo "Usage: $0 [selfsigned|letsencrypt] [domain] [email]"
    exit 1
fi
