#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PORT="${1:-8765}"
URL="http://127.0.0.1:${PORT}/"

echo "CET-6 语境词书: ${URL}"
echo "按 Ctrl+C 停止服务。"

if command -v microsoft-edge >/dev/null 2>&1; then
  (sleep 0.5; microsoft-edge --app="${URL}" >/dev/null 2>&1 &) || true
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 0.5; xdg-open "${URL}" >/dev/null 2>&1 &) || true
fi

exec python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory site
