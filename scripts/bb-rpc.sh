#!/bin/bash
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

if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config not found at $CONFIG" >&2
  exit 1
fi

PORT=$(jq -r '.port // 17380' "$CONFIG")
TOKEN=$(jq -r '.token // ""' "$CONFIG")

if [[ -z "$TOKEN" ]]; then
  echo "Error: token not found in config" >&2
  exit 1
fi

METHOD="${1:?Usage: bb-rpc.sh <method> [json-params]}"
PARAMS="${2:-{\}}"

# Auto-increment id based on timestamp to keep them unique.
ID=$(($(date +%s%N) / 1000000 % 1000000))

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data "{\"id\":$ID,\"method\":\"$METHOD\",\"params\":$PARAMS}" \
  "http://127.0.0.1:${PORT}/rpc" | jq .
