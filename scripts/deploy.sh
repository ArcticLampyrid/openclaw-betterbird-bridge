#!/usr/bin/env bash
# Build, install, and restart Betterbird with the latest addon + native host.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

ADDON_ID="openclaw-betterbird-bridge@openclaw.local"
PROFILE_DIR="$HOME/.thunderbird/aalinn3f.default-default"
EXT_DIR="$PROFILE_DIR/extensions"
EXT_JSON="$PROFILE_DIR/extensions.json"
BB_BIN="/usr/bin/betterbird"

# ── Resolve graphical session env (before killing anything) ─
_gui_env() {
  for pid in $(pgrep -u "$(id -u)"); do
    if grep -qz 'WAYLAND_DISPLAY\|DISPLAY' "/proc/$pid/environ" 2>/dev/null; then
      cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n' \
        | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)='
      return
    fi
  done
}

while IFS= read -r line; do
  export "$line"
done < <(_gui_env)

# ── Install native host manifest ────────────────────────────
echo ":: Installing native host manifest..."
"$ROOT/scripts/install-native-host.sh"

# ── Stop Betterbird (so we can safely modify profile) ───────
echo ":: Stopping Betterbird..."
if pgrep -x betterbird > /dev/null 2>&1; then
  kill $(pgrep -x betterbird) 2>/dev/null || true
  for _ in $(seq 1 20); do
    pgrep -x betterbird > /dev/null 2>&1 || break
    sleep 0.5
  done
  # Force kill if still alive (including child processes)
  kill -9 $(pgrep -x betterbird 2>/dev/null) $(pgrep -x betterbird-bin 2>/dev/null) 2>/dev/null || true
  sleep 1
fi
kill $(pgrep -f 'node.*host\.mjs' 2>/dev/null) 2>/dev/null || true
echo "   stopped"

# ── Install addon via directory pointer ─────────────────────
echo ":: Installing addon..."
mkdir -p "$EXT_DIR"
rm -f "$EXT_DIR/$ADDON_ID.xpi"
echo "$ROOT/addon" > "$EXT_DIR/$ADDON_ID"

# Remove stale addon record from extensions.json so Betterbird
# re-discovers the addon cleanly on next startup.
if [[ -f "$EXT_JSON" ]]; then
  python3 -c "
import json, sys
path, addon_id = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
before = len(data.get('addons', []))
data['addons'] = [a for a in data.get('addons', []) if a.get('id') != addon_id]
after = len(data['addons'])
if before != after:
    with open(path, 'w') as f:
        json.dump(data, f)
    print('   cleared stale addon record')
else:
    print('   no stale record found')
" "$EXT_JSON" "$ADDON_ID"
fi
echo "   installed: $EXT_DIR/$ADDON_ID -> $ROOT/addon"

# ── Start Betterbird ────────────────────────────────────────
echo ":: Starting Betterbird..."
nohup "$BB_BIN" &>/dev/null &
disown

# ── Wait for native host ────────────────────────────────────
echo ":: Waiting for native host..."
for _ in $(seq 1 60); do
  if pgrep -f 'node.*host\.mjs' > /dev/null 2>&1; then
    echo "   native host ready (PID $(pgrep -f 'node.*host\.mjs'))"
    echo ":: Done! ✅"
    exit 0
  fi
  sleep 1
done

echo "   ⚠️  native host not detected after 60s"
