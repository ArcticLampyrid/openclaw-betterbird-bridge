#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
NAME="openclaw-betterbird-bridge.xpi"

mkdir -p "$DIST"
(
  cd "$ROOT/addon"
  zip -qr "$DIST/$NAME" .
)

echo "built: $DIST/$NAME"
