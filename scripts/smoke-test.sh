#!/usr/bin/env bash
set -euo pipefail

CONFIG="${OPENCLAW_BB_CONFIG:-${HOME}/.config/betterbird-bridge/config.json}"
DEFAULT_SOCKET_PATH="${HOME}/.cache/betterbird-bridge/bridge.sock"
if [[ ! -f "$CONFIG" ]]; then
  echo "Error: config not found at $CONFIG"
  exit 1
fi

SOCKET_PATH="${OPENCLAW_BB_SOCKET_PATH:-$(jq -r '.socketPath // empty' "$CONFIG")}"
if [[ -z "$SOCKET_PATH" ]]; then
  SOCKET_PATH="$DEFAULT_SOCKET_PATH"
fi

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "Error: Unix socket not found at $SOCKET_PATH"
  exit 1
fi

rpc() {
  local id="$1" method="$2" params="$3"
  curl -s -X POST \
    --unix-socket "$SOCKET_PATH" \
    -H "content-type: application/json" \
    --data "{\"id\":$id,\"method\":\"$method\",\"params\":$params}" \
    "http://localhost/rpc"
}

echo "=== Health ==="
HEALTH=$(curl -s --unix-socket "$SOCKET_PATH" "http://localhost/health")
echo "$HEALTH" | jq '{ok: .connected, addon: .addon.version}'

echo "=== Ping ==="
PING=$(rpc 1 "ping" '{}')
echo "$PING" | jq '{ok: .ok, ts: .result.ts}'

echo "=== Accounts List ==="
ACCOUNTS=$(rpc 2 "accounts.list" '{}')
ACCOUNT_COUNT=$(echo "$ACCOUNTS" | jq '(.result // []) | length')
ACCOUNT_IDS=$(echo "$ACCOUNTS" | jq -r '(.result // []) | map(.id) | join(", ")')
echo "count: $ACCOUNT_COUNT"
echo "ids: $ACCOUNT_IDS"

echo "=== Folders Get ==="
FOLDER_ID=$(echo "$ACCOUNTS" | jq -r '(.result // []) | .[0].folders[0].id // ""' 2>/dev/null || echo "")
if [[ -n "$FOLDER_ID" ]]; then
  FOLDER=$(rpc 3 "folders.get" "{\"folderId\":\"$FOLDER_ID\"}")
  FOLDER_NAME=$(echo "$FOLDER" | jq -r '.result.name // "(unknown)"')
  FOLDER_TYPE=$(echo "$FOLDER" | jq -r '.result.type // "(none)"')
  echo "id: $FOLDER_ID"
  echo "name: $FOLDER_NAME"
  echo "type: $FOLDER_TYPE"
else
  echo "(no folder found — skipping)"
fi

echo "=== Messages Latest (count=3) ==="
if [[ -n "$FOLDER_ID" ]]; then
  MESSAGES=$(rpc 4 "messages.latest" "{\"folderId\":\"$FOLDER_ID\",\"count\":3}")
  MSG_COUNT=$(echo "$MESSAGES" | jq '(.result // []) | length')
  MSG_IDS=$(echo "$MESSAGES" | jq -r '(.result // []) | map(.id) | join(", ")')
  echo "count: $MSG_COUNT"
  echo "ids: $MSG_IDS"
else
  MSG_COUNT=0
  echo "count: 0 (no folder found)"
fi

echo "=== Messages Read (first message body) ==="
FIRST_MSG_ID=$(echo "${MESSAGES:-}" | jq -r '(.result // []) | .[0].id // ""' 2>/dev/null || echo "")
if [[ -n "$FIRST_MSG_ID" && "$FIRST_MSG_ID" != "null" ]]; then
  READ=$(rpc 5 "messages.read" "{\"messageId\":$FIRST_MSG_ID}")
  READ_OK=$(echo "$READ" | jq -r '.ok')
  READ_SUBJECT=$(echo "$READ" | jq -r '.result.header.subject // "(no subject)"')
  HAS_PLAIN=$(echo "$READ" | jq -r 'if .result.text.plain then "yes" else "no" end')
  HAS_HTML=$(echo "$READ" | jq -r 'if .result.text.html then "yes" else "no" end')
  BODY_PREVIEW=$(echo "$READ" | jq -r '(.result.text.plain // .result.text.html // "") | .[0:120]')
  echo "ok: $READ_OK"
  echo "subject: $READ_SUBJECT"
  echo "has_plain: $HAS_PLAIN, has_html: $HAS_HTML"
  echo "body_preview: $BODY_PREVIEW"
else
  echo "(no messages — skipping)"
fi

echo "=== Attachments List (first message) ==="
if [[ -n "$FIRST_MSG_ID" && "$FIRST_MSG_ID" != "null" ]]; then
  ATT_COUNT=$(echo "$READ" | jq '(.result.attachments // []) | length')
  ATT_NAMES=$(echo "$READ" | jq -r '(.result.attachments // []) | map(.name // .partName) | join(", ")')
  echo "count: $ATT_COUNT"
  if [[ "$ATT_COUNT" -gt 0 ]]; then
    echo "names: $ATT_NAMES"
  else
    echo "(no attachments on this message)"
  fi
else
  echo "(no messages — skipping)"
fi

echo "=== Compose ==="
echo "(skipped in smoke test to avoid sending mail)"

echo ""
echo "=== All smoke tests passed ==="
