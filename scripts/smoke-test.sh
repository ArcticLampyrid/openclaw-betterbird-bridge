#!/bin/bash
set -e

CONFIG="${HOME}/.config/openclaw/betterbird-bridge.json"
if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config not found at $CONFIG"
  exit 1
fi

PORT=$(jq -r '.port // 17380' "$CONFIG")
TOKEN=$(jq -r '.token // ""' "$CONFIG")

if [[ -z "$TOKEN" ]]; then
  echo "Error: token not found in config"
  exit 1
fi

BASE_URL="http://127.0.0.1:${PORT}"

echo "=== Health ==="
HEALTH=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/health")
echo "$HEALTH" | jq '{ok: .connected, addon: .addon.version}'

echo "=== Ping ==="
PING=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data '{"id":1,"method":"ping","params":{}}' \
  "$BASE_URL/rpc")
echo "$PING" | jq '{ok: .ok, ts: .result.ts}'

echo "=== Accounts List ==="
ACCOUNTS=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data '{"id":2,"method":"accounts.list","params":{}}' \
  "$BASE_URL/rpc")
ACCOUNT_COUNT=$(echo "$ACCOUNTS" | jq '[.result[] | select(.type == "account")] | length')
ACCOUNT_IDS=$(echo "$ACCOUNTS" | jq -r '[.result[] | select(.type == "account") | .id] | join(", ")')
echo "count: $ACCOUNT_COUNT"
echo "ids: $ACCOUNT_IDS"

echo "=== Messages Latest (count=3) ==="
FOLDER_ID=$(echo "$ACCOUNTS" | jq -r '.result[0].folders[0].id' 2>/dev/null || echo "")
if [[ -n "$FOLDER_ID" && "$FOLDER_ID" != "null" ]]; then
  MESSAGES=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    --data "{\"id\":3,\"method\":\"messages.latest\",\"params\":{\"folderId\":\"$FOLDER_ID\",\"count\":3}}" \
    "$BASE_URL/rpc")
  MSG_COUNT=$(echo "$MESSAGES" | jq '[.result[]] | length')
  MSG_IDS=$(echo "$MESSAGES" | jq -r '[.result[].id] | join(", ")')
  echo "count: $MSG_COUNT"
  echo "ids: $MSG_IDS"
else
  echo "count: 0 (no folder found)"
fi
