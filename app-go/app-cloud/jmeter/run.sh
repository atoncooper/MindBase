#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${1:-read}"
THREADS="${2:-20}"
RAMP="${3:-10}"
DURATION="${4:-60}"
HOST="${5:-127.0.0.1}"
PORT="${6:-8007}"
PROTOCOL="${7:-https}"
UIDS_FILE="${8:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN="$HERE/app-cloud-${SCENARIO}.jmx"
if [[ -z "$UIDS_FILE" ]]; then
  UIDS_FILE="$HERE/uids.csv"
fi
if [[ ! -f "$PLAN" ]]; then
  echo "Unknown scenario '$SCENARIO' (expected read, quota, search, upload-init)" >&2
  exit 2
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RESULT_DIR="$HERE/results/${SCENARIO}-${STAMP}"
JTL="$RESULT_DIR/results.jtl"
mkdir -p "$RESULT_DIR"

echo "Running JMeter: ${SCENARIO} threads=${THREADS} ramp=${RAMP} duration=${DURATION}s target=${PROTOCOL}://${HOST}:${PORT}"
jmeter -n \
  -t "$PLAN" \
  -q "$HERE/loadtest.properties" \
  -l "$JTL" \
  -e -o "$RESULT_DIR" \
  -Jhost="$HOST" \
  -Jport="$PORT" \
  -Jprotocol="$PROTOCOL" \
  -Jthreads="$THREADS" \
  -Jramp="$RAMP" \
  -Jduration="$DURATION" \
  -JuidsFile="$UIDS_FILE"

echo "JMeter HTML report: $RESULT_DIR/index.html"