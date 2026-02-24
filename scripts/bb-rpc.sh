#!/usr/bin/env bash
# bb-rpc.sh — simplified RPC caller for Betterbird Bridge
#
# Usage:
#   bb-rpc.sh <method> [json-params]
#
# Examples:
#   bb-rpc.sh ping '{}'
#   bb-rpc.sh accounts.list '{}'
#   bb-rpc.sh messages.latest '{"folderId":"abc","count":5}'
#
# Config is read from ~/.config/openclaw/betterbird-bridge.json

set -euo pipefail

CONFIG="${OPENCLAW_BB_CONFIG:-${HOME}/.config/openclaw/betterbird-bridge.json}"
DEFAULT_SOCKET_PATH="${HOME}/.cache/openclaw/betterbird-bridge.sock"

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config not found at $CONFIG" >&2
  exit 1
fi

SOCKET_PATH="${OPENCLAW_BB_SOCKET_PATH:-$(jq -r '.socketPath // empty' "$CONFIG")}"
if [[ -z "$SOCKET_PATH" ]]; then
  SOCKET_PATH="$DEFAULT_SOCKET_PATH"
fi

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "Error: Unix socket not found at $SOCKET_PATH" >&2
  exit 1
fi

METHOD="${1:?Usage: bb-rpc.sh <method> [json-params]}"
PARAMS="${2:-{\}}"

# Auto-increment id based on timestamp to keep them unique.
ID=$(($(date +%s%N) / 1000000 % 1000000))

curl -s -X POST \
  --unix-socket "$SOCKET_PATH" \
  -H "content-type: application/json" \
  --data "{\"id\":$ID,\"method\":\"$METHOD\",\"params\":$PARAMS}" \
  "http://localhost/rpc" | jq .
