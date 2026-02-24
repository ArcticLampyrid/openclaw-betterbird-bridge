#!/usr/bin/env bash
# Deploy pre-built artifacts from dist/ as a system-wide install.
# After deployment the source tree is no longer needed.
#
# System-wide (requires sudo):
#   /usr/lib/openclaw-betterbird-bridge/       — native host runtime + addon XPI
#   /usr/local/bin/bb-rpc                      — RPC helper (symlink)
#   /usr/lib/mozilla/native-messaging-hosts/   — native messaging manifest
#   <app-dir>/distribution/policies.json       — enterprise policy (force-installs addon)
#
# Per-user (no sudo):
#   ~/.config/openclaw/betterbird-bridge.json  — config (created if missing)
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"

ADDON_ID="openclaw-betterbird-bridge@openclaw.local"
NATIVE_HOST_NAME="ai.openclaw.betterbird_bridge"
INSTALL_DIR="/usr/lib/openclaw-betterbird-bridge"
BIN_DIR="/usr/local/bin"
NM_DIR="/usr/lib/mozilla/native-messaging-hosts"
CONFIG_FILE="$HOME/.config/openclaw/betterbird-bridge.json"

# ── Auto-detect Betterbird/Thunderbird ──────────────────────
_find_bb() {
  if [[ -n "${BB_APP_DIR:-}" ]]; then
    echo "$BB_APP_DIR"; return
  fi
  for d in /opt/betterbird /usr/lib/betterbird /usr/lib/thunderbird /opt/thunderbird; do
    if [[ -x "$d/betterbird" || -x "$d/thunderbird" ]]; then
      echo "$d"; return
    fi
  done
  local bin
  bin=$(command -v betterbird 2>/dev/null || command -v thunderbird 2>/dev/null || true)
  if [[ -n "$bin" ]]; then
    echo "$(dirname "$(readlink -f "$bin")")"; return
  fi
  return 1
}

BB_APP_DIR="$(_find_bb)" || { echo "Error: Betterbird/Thunderbird not found. Set BB_APP_DIR." >&2; exit 1; }
BB_BIN="$BB_APP_DIR/betterbird"
[[ -x "$BB_BIN" ]] || BB_BIN="$BB_APP_DIR/thunderbird"

# ── Pre-flight checks ──────────────────────────────────────
if [[ ! -d "$DIST/native-host" || ! -d "$DIST/addon" ]]; then
  echo "Error: dist/ not found or incomplete. Run ./scripts/build.sh first." >&2
  exit 1
fi
if [[ ! -x "$BB_BIN" ]]; then
  echo "Error: Betterbird/Thunderbird binary not found at $BB_BIN" >&2
  exit 1
fi

echo ":: Detected app: $BB_BIN"

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
_pids() {
  pgrep -x betterbird 2>/dev/null
  pgrep -x betterbird-bin 2>/dev/null
  pgrep -x thunderbird 2>/dev/null
  pgrep -x thunderbird-bin 2>/dev/null
  pgrep -f 'node.*host\.mjs' 2>/dev/null
}
kill $(_pids) 2>/dev/null || true
for _ in $(seq 1 20); do [[ -z "$(_pids)" ]] && break; sleep 0.5; done
kill -9 $(_pids) 2>/dev/null || true
for _ in $(seq 1 10); do [[ -z "$(_pids)" ]] && break; sleep 0.5; done
echo "   stopped"

# ── Stage files ────────────────────────────────────────────
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo ":: Preparing install → $INSTALL_DIR"
cp -r "$DIST/native-host/"* "$STAGING/"

cat > "$STAGING/openclaw-bb-host" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$(readlink -f "$0")")/host.mjs"
LAUNCHER
chmod +x "$STAGING/openclaw-bb-host"

echo ":: Building addon XPI..."
(cd "$DIST/addon" && zip -qr "$STAGING/addon.xpi" .)

cp "$ROOT/scripts/bb-rpc.sh" "$STAGING/bb-rpc"
chmod +x "$STAGING/bb-rpc"

# ── Install system files (sudo) ────────────────────────────
echo ":: Installing system files (sudo)..."

# Native host + addon XPI
sudo rm -rf "${INSTALL_DIR}.bak"
sudo mv "$INSTALL_DIR" "${INSTALL_DIR}.bak" 2>/dev/null || true
sudo mv "$STAGING" "$INSTALL_DIR"
sudo chmod 755 "$INSTALL_DIR"
sudo chown -R root:root "$INSTALL_DIR"
sudo rm -rf "${INSTALL_DIR}.bak"
trap - EXIT
echo "   → $INSTALL_DIR"

# bb-rpc symlink
sudo ln -sf "$INSTALL_DIR/bb-rpc" "$BIN_DIR/bb-rpc"
echo "   → $BIN_DIR/bb-rpc"

# Native messaging manifest (system-wide)
sudo mkdir -p "$NM_DIR"
sudo tee "$NM_DIR/$NATIVE_HOST_NAME.json" > /dev/null <<EOF
{
  "name": "$NATIVE_HOST_NAME",
  "description": "OpenClaw Betterbird native host",
  "path": "$INSTALL_DIR/openclaw-bb-host",
  "type": "stdio",
  "allowed_extensions": ["$ADDON_ID"]
}
EOF
echo "   → $NM_DIR/$NATIVE_HOST_NAME.json"

# Enterprise policy
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

# ── Clean up old per-user installs & profile caches ────────
_find_profiles_ini() {
  for dir in "$HOME/.thunderbird" "$HOME/Library/Thunderbird"; do
    if [[ -f "$dir/profiles.ini" ]]; then echo "$dir/profiles.ini"; return; fi
  done
  return 1
}

_cleanup_profile() {
  local profiles_ini
  profiles_ini="$(_find_profiles_ini)" || return

  local profile_rel
  profile_rel=$(awk -F= '/^\[Install/{found=1} found && /^Default=/{print $2; exit}' "$profiles_ini")
  [[ -n "$profile_rel" ]] || return

  local profile_dir
  profile_dir="$(dirname "$profiles_ini")/$profile_rel"
  [[ -d "$profile_dir" ]] || return

  # Remove old per-user addon installs
  rm -f "$profile_dir/extensions/$ADDON_ID"
  rm -f "$profile_dir/extensions/$ADDON_ID.xpi"

  # Clear addon startup cache (forces re-discovery)
  rm -f "$profile_dir/addonStartup.json.lz4"
}
_cleanup_profile

# Remove old per-user install location
if [[ -d "$HOME/.local/lib/openclaw-betterbird-bridge" ]]; then
  rm -rf "$HOME/.local/lib/openclaw-betterbird-bridge"
  rm -f "$HOME/.local/bin/bb-rpc"
  echo "   cleaned up old ~/.local install"
fi

# Remove old per-user native messaging manifest
rm -f "$HOME/.mozilla/native-messaging-hosts/$NATIVE_HOST_NAME.json"

# ── Create per-user config if missing ──────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo ":: Creating default config..."
  mkdir -p "$(dirname "$CONFIG_FILE")"
  TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null \
    || openssl rand -base64 32 2>/dev/null \
    || head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
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
