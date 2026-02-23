#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_NAME="ai.openclaw.betterbird_bridge"
EXT_ID="openclaw-betterbird-bridge@openclaw.local"

# Betterbird (like Firefox/Thunderbird) looks under XREUserNativeManifests/native-messaging-hosts.
# On Linux this resolves to ~/.mozilla/native-messaging-hosts.
BASE="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$BASE"

HOST_PATH="$ROOT/native-host/bin/openclaw-bb-host"
chmod +x "$HOST_PATH"

MANIFEST="$BASE/$HOST_NAME.json"
cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "OpenClaw Betterbird native host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF

echo "installed native host manifest: $MANIFEST"

echo "Tip: create config at ~/.config/openclaw/betterbird-bridge.json with: {\"port\":17380,\"token\":\"<token>\"}"
