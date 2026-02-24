#!/usr/bin/env bash
# Build distributable artifacts into dist/.
# After build, dist/ is self-contained — source tree is not needed for deployment.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST/native-host" "$DIST/addon"

# ── 1. Addon ────────────────────────────────────────────────
echo ":: Copying addon..."
cp "$ROOT/addon/"* "$DIST/addon/"
echo "   → dist/addon/"

# ── 2. Native host sources (pure Node.js, no bundling needed)
echo ":: Copying native host..."
cp "$ROOT/native-host/src/"*.mjs "$DIST/native-host/"
cp "$ROOT/native-host/package.json" "$DIST/native-host/"
echo "   → dist/native-host/"

echo ":: Build complete ✅"
echo "   Run ./scripts/deploy.sh to install."
