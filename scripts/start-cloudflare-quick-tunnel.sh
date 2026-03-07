#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8787}"
ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:${PORT}}"
TUNNEL_PROTOCOL="${TUNNEL_PROTOCOL:-http2}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "Install it with: brew install cloudflared"
  exit 1
fi

echo "Starting Cloudflare Quick Tunnel for ${ORIGIN_URL}"
echo "Using Cloudflare transport protocol: ${TUNNEL_PROTOCOL}"
echo "Keep this process running while you want internet access."
echo

exec cloudflared tunnel --protocol "${TUNNEL_PROTOCOL}" --url "${ORIGIN_URL}"
