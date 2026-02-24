#!/usr/bin/env bash
# Deploy pre-built artifacts from dist/ to the local system.
# After deployment the source tree is no longer needed.
#
# What gets installed:
#   ~/.local/lib/openclaw-betterbird-bridge/   — native host runtime + addon XPI
#   ~/.local/bin/bb-rpc                        — RPC helper (symlink)
#   ~/.mozilla/native-messaging-hosts/...json  — native messaging manifest
#   <betterbird>/distribution/policies.json    — enterprise policy (force-installs addon)
#   ~/.config/openclaw/betterbird-bridge.json  — config (created if missing)
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

ADDON_ID="openclaw-betterbird-bridge@openclaw.local"
NATIVE_HOST_NAME="ai.openclaw.betterbird_bridge"
INSTALL_DIR="$HOME/.local/lib/openclaw-betterbird-bridge"
BIN_DIR="$HOME/.local/bin"
CONFIG_FILE="$HOME/.config/openclaw/betterbird-bridge.json"
BB_BIN="/opt/betterbird/betterbird"
BB_APP_DIR="/opt/betterbird"

# ── Pre-flight checks ──────────────────────────────────────
if [[ ! -d "$DIST/native-host" || ! -d "$DIST/addon" ]]; then
  echo "Error: dist/ not found or incomplete. Run ./scripts/build.sh first." >&2
  exit 1
fi

if [[ ! -x "$BB_BIN" ]]; then
  echo "Error: Betterbird not found at $BB_BIN" >&2
  exit 1
fi

# ── Resolve graphical session env ───────────────────────────
_import_gui_env() {
  for pid in $(pgrep -u "$(id -u)" 2>/dev/null); do
    if grep -qz 'WAYLAND_DISPLAY\|DISPLAY' "/proc/$pid/environ" 2>/dev/null; then
      while IFS= read -r -d '' line; do
        case "$line" in
          DISPLAY=*|WAYLAND_DISPLAY=*|XDG_RUNTIME_DIR=*|DBUS_SESSION_BUS_ADDRESS=*)
            export "$line" ;;
        esac
      done < "/proc/$pid/environ"
      return
    fi
  done
}
_import_gui_env

# ── Stop Betterbird ────────────────────────────────────────
echo ":: Stopping Betterbird..."
_pids() { pgrep -x betterbird 2>/dev/null; pgrep -x betterbird-bin 2>/dev/null; pgrep -f 'node.*host\.mjs' 2>/dev/null; }
kill $(_pids) 2>/dev/null || true
for _ in $(seq 1 20); do
  [[ -z "$(_pids)" ]] && break
  sleep 0.5
done
kill -9 $(_pids) 2>/dev/null || true
for _ in $(seq 1 10); do
  [[ -z "$(_pids)" ]] && break
  sleep 0.5
done
echo "   stopped"

# ── Install to staging dir, then swap atomically ───────────
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo ":: Preparing install → $INSTALL_DIR"
cp -r "$DIST/native-host/"* "$STAGING/"

# Create launcher script
cat > "$STAGING/openclaw-bb-host" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$(readlink -f "$0")")/host.mjs"
LAUNCHER
chmod +x "$STAGING/openclaw-bb-host"

# Build addon XPI
echo ":: Building addon XPI..."
(cd "$DIST/addon" && zip -qr "$STAGING/addon.xpi" .)

# Copy bb-rpc helper
cp "$ROOT/scripts/bb-rpc.sh" "$STAGING/bb-rpc"
chmod +x "$STAGING/bb-rpc"

# Atomic swap: rename old → .bak, move staging → install, remove .bak
rm -rf "${INSTALL_DIR}.bak"
mv "$INSTALL_DIR" "${INSTALL_DIR}.bak" 2>/dev/null || true
mv "$STAGING" "$INSTALL_DIR"
rm -rf "${INSTALL_DIR}.bak"
trap - EXIT
echo "   → $INSTALL_DIR"

# ── Symlink bb-rpc into PATH ──────────────────────────────
echo ":: Installing bb-rpc → $BIN_DIR/bb-rpc"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bb-rpc" "$BIN_DIR/bb-rpc"

# ── Install native messaging manifest ──────────────────────
echo ":: Installing native messaging manifest..."
NM_DIR="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$NM_DIR"
cat > "$NM_DIR/$NATIVE_HOST_NAME.json" <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "OpenClaw Betterbird native host",
  "path": "$INSTALL_DIR/openclaw-bb-host",
  "type": "stdio",
  "allowed_extensions": ["$ADDON_ID"]
}
EOF
echo "   → $NM_DIR/$NATIVE_HOST_NAME.json"

# ── Install enterprise policy (force-installs addon) ───────
echo ":: Installing enterprise policy..."
sudo mkdir -p "$BB_APP_DIR/distribution"
sudo tee "$BB_APP_DIR/distribution/policies.json" > /dev/null <<EOF
{
  "policies": {
    "ExtensionSettings": {
      "$ADDON_ID": {
        "installation_mode": "force_installed",
        "install_url": "file://$INSTALL_DIR/addon.xpi"
      }
    }
  }
}
EOF
echo "   → $BB_APP_DIR/distribution/policies.json"

# ── Clean up profile caches and old installs ───────────────
_cleanup_profile() {
  local profiles_ini="$HOME/.thunderbird/profiles.ini"
  [[ -f "$profiles_ini" ]] || return

  # Find the locked profile
  local profile_rel
  profile_rel=$(awk -F= '/^\[Install/{found=1} found && /^Default=/{print $2; exit}' "$profiles_ini")
  [[ -n "$profile_rel" ]] || return

  local profile_dir="$HOME/.thunderbird/$profile_rel"
  [[ -d "$profile_dir" ]] || return

  # Remove old directory pointer or XPI from profile extensions
  rm -f "$profile_dir/extensions/$ADDON_ID"
  rm -f "$profile_dir/extensions/$ADDON_ID.xpi"

  # Clear addon startup cache (forces Betterbird to re-discover addons)
  rm -f "$profile_dir/addonStartup.json.lz4"
}
_cleanup_profile

# ── Create config if missing ───────────────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo ":: Creating default config..."
  mkdir -p "$(dirname "$CONFIG_FILE")"
  TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
  cat > "$CONFIG_FILE" <<EOF
{
  "port": 17380,
  "token": "$TOKEN",
  "write": {
    "enabled": true,
    "allowHardDelete": false
  },
  "compose": {
    "enabled": true
  }
}
EOF
  echo "   → $CONFIG_FILE (token auto-generated)"
else
  echo ":: Config exists: $CONFIG_FILE (skipped)"
fi

# ── Start Betterbird ───────────────────────────────────────
echo ":: Starting Betterbird..."
nohup "$BB_BIN" &>/dev/null &
disown

# ── Wait for native host ──────────────────────────────────
echo ":: Waiting for native host..."
for _ in $(seq 1 60); do
  if pgrep -f 'node.*host\.mjs' > /dev/null 2>&1; then
    echo "   native host ready (PID $(pgrep -f 'node.*host\.mjs'))"
    echo ""
    echo ":: Deploy complete ✅"
    echo "   Installed to: $INSTALL_DIR"
    echo "   Config:       $CONFIG_FILE"
    echo "   RPC helper:   bb-rpc <method> [params]"
    exit 0
  fi
  sleep 1
done

echo "   ⚠️  native host not detected after 60s (Betterbird may still be loading)"
