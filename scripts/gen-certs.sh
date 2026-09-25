#!/bin/sh
# gen-certs.sh — MindBase one-shot TLS provisioning.
#
# Provisions every certificate the stack needs from ONE shared dev CA, so a
# fresh clone (local Docker Desktop or a remote Linux server) gets a working
# TLS posture with zero manual steps:
#
#   nginx/certs/dev-ca.crt|key       shared dev CA (ECDSA P-256, 10 years)
#   nginx/certs/fullchain.pem        nginx 443 leaf (RSA-2048) + CA chain
#   nginx/certs/privkey.pem          nginx leaf key
#   app-board/certs/dev-ca.crt       shared CA copy (APISIX upstream trust)
#   app-board/certs/server.crt|key   app-board leaf (ECDSA P-256)
#   mcp/app-board-mcp/certs/dev-ca.crt       shared CA copy
#   mcp/app-board-mcp/certs/server.crt|key   app-board-mcp leaf (ECDSA P-256)
#   app-pay/certs/ca.crt             shared CA copy (app-task executor trust)
#   app-pay/certs/pay.crt|key        app-pay leaf (RSA-2048, PKCS#8 key)
#
# SANs always cover the deployment-facing alias "mindbase" (map it in DNS or
# the client hosts file to the server IP) plus localhost/loopback, every
# detected LAN IPv4 and $MB_CERT_EXTRA_SAN.
#
# Modes:  all (default) | nginx (nginx leaf + CA only) | services (leaves only)
#
# Idempotency: the CA is reused while valid; a leaf is re-signed only when
# missing, expiring within 30 days, or its SAN no longer covers $MB_CERT_HOST.
# Files are replaced atomically (tmp+rename). Keys for the nginx leaf and the
# shared CA are 0600; the service leaves/keys are 0644 so the distroless
# nonroot containers can read them through the bind mounts — dev posture only,
# production should point explicit cert/key env at externally managed files.
#
# Environment knobs (all optional):
#   MB_CERT_HOST       main hostname to cover        (default: mindbase)
#   MB_CERT_EXTRA_SAN  extra SANs, comma-separated   (e.g. "vpn.example.com,10.0.0.9")
#   MB_CERT_DAYS       leaf validity in days         (default: 825)
#   MB_CERT_KEEP       1 = never touch existing files (real-CA production)
#   MB_CERT_FORCE      1 = re-sign everything, even if valid
#   MB_CERT_NGINX_DIR / MB_CERT_APPBOARD_DIR / MB_CERT_MCP_DIR / MB_CERT_PAY_DIR  output dirs
#   OPENSSL            openssl binary                (default: openssl)
#
# Renewal: re-runs automatically on every `docker compose up` (the cert-gen
# init service executes this script); `docker compose run --rm cert-gen`
# renews without touching the rest of the stack.
set -eu

MODE="${1:-all}"
HOST="${MB_CERT_HOST:-mindbase}"
EXTRA_SAN="${MB_CERT_EXTRA_SAN:-}"
LEAF_DAYS="${MB_CERT_DAYS:-825}"
KEEP="${MB_CERT_KEEP:-0}"
FORCE="${MB_CERT_FORCE:-0}"
OPENSSL="${OPENSSL:-openssl}"

# Git Bash (MSYS) rewrites X.509 subject args ("/C=CN/...") into Windows
# paths. With MSYS_NO_PATHCONV=1 subjects survive; every openssl file
# argument in this script is a relative path (see note at SCRIPT_DIR), so
# nothing else needs conversion. No-op on Linux/macOS.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# All openssl file arguments below are repo-root-relative: under Git Bash
# (MSYS_NO_PATHCONV=1) the native Windows openssl binary cannot open POSIX
# absolute paths, and relative paths are never path-converted in the first
# place. Env overrides must therefore be repo-root-relative too (or native
# Windows paths); inside the Linux cert-gen container both forms work.
cd -- "$SCRIPT_DIR/.." || { printf '[cert-gen] ERROR: cannot cd to repo root\n' >&2; exit 1; }
NGINX_DIR="${MB_CERT_NGINX_DIR:-nginx/certs}"
APPBOARD_DIR="${MB_CERT_APPBOARD_DIR:-app-board/certs}"
MCP_DIR="${MB_CERT_MCP_DIR:-mcp/app-board-mcp/certs}"
PAY_DIR="${MB_CERT_PAY_DIR:-app-pay/certs}"

# Single standard subject for everything MindBase signs. The CN is a product
# name (never "localhost", never "dev"); hostname coverage lives in the SANs.
SUBJECT_BASE="/C=CN/ST=Sichuan/L=Chengdu/O=MindBase/OU=MindBase Platform"
CA_SUBJ="$SUBJECT_BASE/CN=MindBase Root CA"
leaf_subj() { printf '%s/CN=%s' "$SUBJECT_BASE" "$1"; }

CA_CERT="$NGINX_DIR/dev-ca.crt"
CA_KEY="$NGINX_DIR/dev-ca.key"
CA_VALIDITY_DAYS=3650
ROTATE_WITHIN_DAYS=30

log() { printf '[cert-gen] %s\n' "$*"; }
warn() { printf '[cert-gen] WARNING: %s\n' "$*" >&2; }
die() { printf '[cert-gen] ERROR: %s\n' "$*" >&2; exit 1; }

command -v "$OPENSSL" >/dev/null 2>&1 || die "openssl not found in PATH"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# cert_expires_within_days FILE DAYS — 0 (success) if the cert expires within
# DAYS days. `openssl x509 -checkend` exits 0 when the cert will NOT expire
# within the window, hence the negation. (No date parsing: busybox date
# cannot read openssl's enddate format.)
cert_expires_within_days() {
	! $OPENSSL x509 -in "$1" -checkend $(( $2 * 86400 )) -noout >/dev/null 2>&1
}

# cert_covers_host FILE HOSTNAME -> 0 if the SAN (or CN) covers HOST
cert_covers_host() {
	text=$($OPENSSL x509 -in "$1" -noout -text 2>/dev/null) || return 1
	case "$text" in
	*"DNS:$2,"*|*"DNS:$2"$*|*"DNS: $2,"*|*"DNS: $2"*) return 0 ;;
	esac
	# IP-style host: match the "IP Address:" entries too.
	case "$text" in
	*"IP Address:$2,"*|*"IP Address: $2,"*|*"IP Address: $2"*) return 0 ;;
	esac
	return 1
}

# atomic_install SRC DST MODE — move into place with target permissions
atomic_install() {
	mv -f "$1" "$2"
	chmod "$3" "$2" 2>/dev/null || true
}

# collect_lan_ips — one LAN IPv4 per line (loopback excluded); best effort
collect_lan_ips() {
	if command -v ip >/dev/null 2>&1; then
		ip -o -4 addr show 2>/dev/null | awk '{split($4,a,"/"); if (a[1] !~ /^127\./) print a[1]}'
	elif command -v hostname >/dev/null 2>&1; then
		hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | grep -v '^127\.'
	fi | sort -u
}

# ---------------------------------------------------------------------------
# Shared dev CA (lives in the nginx dir; other dirs get signed leaves + copy)
# ---------------------------------------------------------------------------

ensure_ca() {
	mkdir -p "$NGINX_DIR"
	if [ "$KEEP" = "1" ] && [ -s "$CA_CERT" ]; then
		log "CA kept as-is (MB_CERT_KEEP=1): $CA_CERT"
		return 0
	fi
	if [ -s "$CA_CERT" ] && [ -s "$CA_KEY" ]; then
		if ! cert_expires_within_days "$CA_CERT" "$ROTATE_WITHIN_DAYS"; then
			log "dev CA reused: $CA_CERT"
			return 0
		fi
		warn "dev CA expiring within ${ROTATE_WITHIN_DAYS} days — regenerating (all leaves will be re-signed)"
	else
		log "dev CA missing — generating: $CA_CERT"
	fi
	_tmpc="$CA_CERT.tmp"; _tmpk="$CA_KEY.tmp"
	$OPENSSL ecparam -name prime256v1 -genkey -noout -out "$_tmpk" 2>/dev/null
	$OPENSSL req -x509 -new -sha256 -days "$CA_VALIDITY_DAYS" \
		-key "$_tmpk" \
		-subj "$CA_SUBJ" \
		-addext "basicConstraints=critical,CA:TRUE,pathlen:1" \
		-addext "keyUsage=critical,keyCertSign,cRLSign" \
		-out "$_tmpc" 2>/dev/null
	atomic_install "$_tmpc" "$CA_CERT" 0644
	atomic_install "$_tmpk" "$CA_KEY" 0600
}

# ensure_service_leaf DIR NAME — ECDSA leaf signed by the shared CA
# (distroless containers read these in explicit mode; 0644 for nonroot).
ensure_service_leaf() {
	_dir=$1
	_name=$2
	mkdir -p "$_dir"
	_ca_copy="$_dir/dev-ca.crt"
	_cert="$_dir/server.crt"
	_key="$_dir/server.key"

	if [ "$KEEP" = "1" ] && [ -s "$_cert" ]; then
		log "$_name leaf kept as-is (MB_CERT_KEEP=1): $_cert"
		cp -f "$CA_CERT" "$_ca_copy" 2>/dev/null || true
		return 0
	fi

	# Keep the trust anchor in sync with the shared CA (migrates old
	# per-service auto-generated CAs onto the shared one).
	if ! cmp -s "$CA_CERT" "$_ca_copy" 2>/dev/null; then
		cp -f "$CA_CERT" "$_ca_copy"
		chmod 0644 "$_ca_copy" 2>/dev/null || true
		log "$_name: dev CA copy updated -> $_ca_copy"
	fi

	# Stale key from a previous auto-mode run — explicit mode never needs it.
	if [ -f "$_dir/dev-ca.key" ]; then
		rm -f "$_dir/dev-ca.key"
		log "$_name: removed stale dev-ca.key (explicit mode no longer needs it)"
	fi

	_regen=0
	if [ "$FORCE" = "1" ]; then
		_regen=1
	elif [ ! -s "$_cert" ] || [ ! -s "$_key" ]; then
		_regen=1
	else
		if cert_expires_within_days "$_cert" "$ROTATE_WITHIN_DAYS"; then
			log "$_name leaf expiring — re-signing"
			_regen=1
		elif ! cert_covers_host "$_cert" "$HOST"; then
			log "$_name leaf SAN does not cover '$HOST' — re-signing"
			_regen=1
		fi
	fi
	if [ "$_regen" != "1" ]; then
		log "$_name leaf up-to-date: $_cert"
		return 0
	fi

	_ext="$_dir/.san-ext.cnf.tmp"
	{
		printf '[leaf]\n'
		printf 'basicConstraints=CA:FALSE\n'
		printf 'keyUsage=digitalSignature,keyEncipherment\n'
		printf 'extendedKeyUsage=serverAuth\n'
	} > "$_ext"
	san_file="$_dir/.san-list.cnf.tmp"
	build_san_list "$san_file"
	printf 'subjectAltName=@san\n\n[san]\n' >> "$_ext"
	cat "$san_file" >> "$_ext"

	_keytmp="$_key.tmp"; _certtmp="$_cert.tmp"
	$OPENSSL ecparam -name prime256v1 -genkey -noout -out "$_keytmp" 2>/dev/null
	$OPENSSL req -new -key "$_keytmp" -subj "$(leaf_subj "$_name")" -out "$_dir/.leaf.csr.tmp" 2>/dev/null
	$OPENSSL x509 -req -sha256 -days "$LEAF_DAYS" \
		-in "$_dir/.leaf.csr.tmp" \
		-CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
		-extfile "$_ext" -extensions leaf \
		-out "$_certtmp" 2>/dev/null
	atomic_install "$_keytmp" "$_key" 0644
	atomic_install "$_certtmp" "$_cert" 0644
	rm -f "$_dir/.leaf.csr.tmp" "$_ext" "$san_file"
	log "$_name leaf signed: $_cert (SAN covers $HOST)"
}

# ensure_nginx_leaf — RSA-2048 leaf; fullchain.pem = leaf + CA chain
ensure_nginx_leaf() {
	mkdir -p "$NGINX_DIR"
	_cert="$NGINX_DIR/fullchain.pem"
	_key="$NGINX_DIR/privkey.pem"
	_chain="$CA_CERT"

	if [ "$KEEP" = "1" ] && [ -s "$_cert" ]; then
		log "nginx leaf kept as-is (MB_CERT_KEEP=1): $_cert"
		return 0
	fi

	_regen=0
	if [ "$FORCE" = "1" ]; then
		_regen=1
	elif [ ! -s "$_cert" ] || [ ! -s "$_key" ]; then
		_regen=1
	else
		if cert_expires_within_days "$_cert" "$ROTATE_WITHIN_DAYS"; then
			log "nginx leaf expiring — re-signing"
			_regen=1
		elif ! cert_covers_host "$_cert" "$HOST"; then
			log "nginx leaf SAN does not cover '$HOST' — re-signing"
			_regen=1
		fi
	fi
	if [ "$_regen" != "1" ]; then
		log "nginx leaf up-to-date: $_cert"
		return 0
	fi

	_ext="$NGINX_DIR/.san-ext.cnf.tmp"
	{
		printf '[leaf]\n'
		printf 'basicConstraints=CA:FALSE\n'
		printf 'keyUsage=digitalSignature,keyEncipherment\n'
		printf 'extendedKeyUsage=serverAuth\n'
	} > "$_ext"
	san_file="$NGINX_DIR/.san-list.cnf.tmp"
	build_san_list "$san_file"
	printf 'subjectAltName=@san\n\n[san]\n' >> "$_ext"
	cat "$san_file" >> "$_ext"
	_keytmp="$_key.tmp"
	_csr="$NGINX_DIR/.nginx.csr.tmp"
	_leaftmp="$NGINX_DIR/.leaf.tmp"

	$OPENSSL genrsa -out "$_keytmp" 2048 2>/dev/null
	$OPENSSL req -new -key "$_keytmp" -subj "$(leaf_subj "$HOST")" -out "$_csr" 2>/dev/null
	$OPENSSL x509 -req -sha256 -days "$LEAF_DAYS" \
		-in "$_csr" \
		-CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
		-extfile "$_ext" -extensions leaf \
		-out "$_leaftmp" 2>/dev/null
	atomic_install "$_keytmp" "$_key" 0600
	# fullchain = leaf + CA so browsers get the complete chain.
	cat "$_leaftmp" "$_chain" > "$_cert.tmp"
	atomic_install "$_cert.tmp" "$_cert" 0644
	rm -f "$_csr" "$_leaftmp" "$_ext" "$san_file"
	log "nginx leaf signed: $_cert (SAN covers $HOST)"
}

# ensure_pay_leaf — RSA-2048 leaf for app-pay (Java server.ssl, PKCS#8 key
# via `openssl genrsa` on OpenSSL 3). app-pay's startup self-check refuses to
# boot without these files, so provisioning them is what lets a fresh clone
# run `docker compose up` without errors. app-pay/certs/ca.crt is a copy of
# the shared CA (app-task's executor callback trusts it).
ensure_pay_leaf() {
	mkdir -p "$PAY_DIR"
	_cert="$PAY_DIR/pay.crt"
	_key="$PAY_DIR/pay.key"
	_ca_copy="$PAY_DIR/ca.crt"

	if [ "$KEEP" = "1" ] && [ -s "$_cert" ]; then
		log "app-pay leaf kept as-is (MB_CERT_KEEP=1): $_cert"
		return 0
	fi

	# Keep the trust anchor in sync with the shared CA (replaces the legacy
	# standalone app-pay dev CA).
	if ! cmp -s "$CA_CERT" "$_ca_copy" 2>/dev/null; then
		cp -f "$CA_CERT" "$_ca_copy"
		chmod 0644 "$_ca_copy" 2>/dev/null || true
		log "app-pay: shared CA copy updated -> $_ca_copy"
	fi

	# Stale CA key from the old standalone gen-dev-cert run — no longer needed.
	if [ -f "$PAY_DIR/ca.key" ]; then
		rm -f "$PAY_DIR/ca.key"
		log "app-pay: removed stale ca.key (leaf now signed by the shared CA)"
	fi

	_regen=0
	if [ "$FORCE" = "1" ]; then
		_regen=1
	elif [ ! -s "$_cert" ] || [ ! -s "$_key" ]; then
		_regen=1
	else
		if cert_expires_within_days "$_cert" "$ROTATE_WITHIN_DAYS"; then
			log "app-pay leaf expiring — re-signing"
			_regen=1
		elif ! cert_covers_host "$_cert" "$HOST"; then
			log "app-pay leaf SAN does not cover '$HOST' — re-signing"
			_regen=1
		fi
	fi
	if [ "$_regen" != "1" ]; then
		log "app-pay leaf up-to-date: $_cert"
		return 0
	fi

	_ext="$PAY_DIR/.san-ext.cnf.tmp"
	{
		printf '[leaf]\n'
		printf 'basicConstraints=CA:FALSE\n'
		printf 'keyUsage=digitalSignature,keyEncipherment\n'
		printf 'extendedKeyUsage=serverAuth\n'
	} > "$_ext"
	san_file="$PAY_DIR/.san-list.cnf.tmp"
	build_san_list "$san_file"
	printf 'subjectAltName=@san\n\n[san]\n' >> "$_ext"
	cat "$san_file" >> "$_ext"

	_keytmp="$_key.tmp"; _certtmp="$_cert.tmp"
	$OPENSSL genrsa -out "$_keytmp" 2048 2>/dev/null
	$OPENSSL req -new -key "$_keytmp" -subj "$(leaf_subj "app-pay")" -out "$PAY_DIR/.pay.csr.tmp" 2>/dev/null
	$OPENSSL x509 -req -sha256 -days "$LEAF_DAYS" \
		-in "$PAY_DIR/.pay.csr.tmp" \
		-CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
		-extfile "$_ext" -extensions leaf \
		-out "$_certtmp" 2>/dev/null
	atomic_install "$_keytmp" "$_key" 0644
	atomic_install "$_certtmp" "$_cert" 0644
	rm -f "$PAY_DIR/.pay.csr.tmp" "$_ext" "$san_file"
	log "app-pay leaf signed: $_cert (SAN covers $HOST)"
}

# verify_and_report — chain verification + trust instructions
verify_and_report() {
	_ok=0
	for pair in "nginx:$NGINX_DIR/fullchain.pem" "app-board:$APPBOARD_DIR/server.crt" "app-board-mcp:$MCP_DIR/server.crt" "app-pay:$PAY_DIR/pay.crt"; do
		_label=${pair%%:*}
		_file=${pair#*:}
		[ -s "$_file" ] || continue
		if $OPENSSL verify -CAfile "$CA_CERT" "$_file" >/dev/null 2>&1; then
			log "verify OK: $_label chains to the shared dev CA"
		else
			warn "verify FAILED: $_label does not chain to $CA_CERT"
			_ok=1
		fi
	done
	_fp=$($OPENSSL x509 -in "$CA_CERT" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
	log "shared dev CA sha256 fingerprint: $_fp"
	log "-------------------------------------------------------------"
	log "trust the dev CA once, then everything (https://$HOST) is trusted:"
	log "  1. hosts/DNS: point '$HOST' at this server's IP"
	log "  2. browser/desktop: import and trust $CA_CERT"
	log "  3. curl:   curl --cacert $CA_CERT https://$HOST/"
	log "production: replace with a real CA via MB_CERT_KEEP=1 + external certs."
	return $_ok
}

# build_san_list OUTFILE — [san] section lines shared by ALL leaf builders
# (nginx and service leaves use identical coverage logic).
build_san_list() {
	_out=$1
	{
		n=1
		case "$HOST" in
			*[!0-9.]*) printf 'DNS.%d=%s\n' "$n" "$HOST"; n=$((n+1)) ;;
			*) printf 'IP.%d=%s\n' "$n" "$HOST"; n=$((n+1)) ;;
		esac
		printf 'DNS.%d=localhost\n' "$n"; n=$((n+1))
		# Internal service aliases so any caller can verify any leaf.
		printf 'DNS.%d=app-pay\n' "$n"; n=$((n+1))
		printf 'DNS.%d=app-pay-test\n' "$n"; n=$((n+1))
		if [ "$EXTRA_SAN" != "" ]; then
			printf '%s\n' "$EXTRA_SAN" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | while IFS= read -r entry; do
				[ -n "$entry" ] || continue
				case "$entry" in
					*[!0-9.]*) printf 'DNS.X=%s\n' "$entry" ;;
					*) printf 'IP.X=%s\n' "$entry" ;;
				esac
			done
		fi
		lan_ips=$(collect_lan_ips)
		for ip in $lan_ips; do
			case "$ip" in "$HOST") continue ;; esac
			printf 'IP.X=%s\n' "$ip"
		done
		printf 'IP.X=127.0.0.1\n'
		printf 'IP.X=::1\n'
	} | awk '
		{ line=$0
		  if (match(line, /^DNS\.X=/)) { sub(/^DNS\.X=/, "DNS." n "=", line); n++ }
		  else if (match(line, /^IP\.X=/)) { sub(/^IP\.X=/, "IP." n "=", line); n++ }
		  print line }
	' n=1 > "$_out"
}

case "$MODE" in
	all)
		ensure_ca
		ensure_nginx_leaf
		ensure_service_leaf "$APPBOARD_DIR" "app-board"
		ensure_service_leaf "$MCP_DIR" "app-board-mcp"
		ensure_pay_leaf
		verify_and_report
		;;
	nginx)
		ensure_ca
		ensure_nginx_leaf
		verify_and_report
		;;
	services)
		[ -s "$CA_CERT" ] || die "shared CA not found at $CA_CERT — run 'gen-certs.sh all' first"
		ensure_service_leaf "$APPBOARD_DIR" "app-board"
		ensure_service_leaf "$MCP_DIR" "app-board-mcp"
		ensure_pay_leaf
		verify_and_report
		;;
	*)
		die "unknown mode '$MODE' (expected: all | nginx | services)"
		;;
esac
