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
SOCKET_PATH="$HOME/.cache/openclaw/betterbird-bridge.sock"
GRACE_TIMEOUT=10
TARGET_UID="${SUDO_UID:-$(id -u)}"

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

stop_with_timeout() {
  local pid="$1"
  local timeout="${2:-10}"

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  kill -TERM "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + timeout))
  while kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      echo "   PID $pid did not exit in ${timeout}s; sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.2
  done

  wait "$pid" 2>/dev/null || true
}

_app_pids() {
  {
    pgrep -u "$TARGET_UID" -x betterbird 2>/dev/null || true
    pgrep -u "$TARGET_UID" -x betterbird-bin 2>/dev/null || true
    pgrep -u "$TARGET_UID" -x thunderbird 2>/dev/null || true
    pgrep -u "$TARGET_UID" -x thunderbird-bin 2>/dev/null || true
  } | sort -u
}

_app_parent_pids() {
  mapfile -t all_pids < <(_app_pids)
  [[ ${#all_pids[@]} -gt 0 ]] || return 0

  declare -A app_pid_set=()
  local pid ppid
  for pid in "${all_pids[@]}"; do
    app_pid_set["$pid"]=1
  done

  for pid in "${all_pids[@]}"; do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$ppid" || -z "${app_pid_set[$ppid]:-}" ]]; then
      printf '%s\n' "$pid"
    fi
  done | sort -u
}

# ── Stop Betterbird/Thunderbird ────────────────────────────
echo ":: Stopping Betterbird/Thunderbird..."
mapfile -t APP_PARENT_PIDS < <(_app_parent_pids)
if [[ ${#APP_PARENT_PIDS[@]} -gt 0 ]]; then
  for pid in "${APP_PARENT_PIDS[@]}"; do
    echo "   stopping app parent PID $pid"
    stop_with_timeout "$pid" "$GRACE_TIMEOUT"
  done
else
  echo "   no running app parent process found"
fi

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

# ── Clear profile addon cache ──────────────────────────────
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

  # Clear addon startup cache (forces re-discovery)
  rm -f "$profile_dir/addonStartup.json.lz4"
}
_cleanup_profile

# ── Create per-user config if missing ──────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo ":: Creating default config..."
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cat > "$CONFIG_FILE" <<EOF
{
  "socketPath": "$SOCKET_PATH"
}
EOF
  echo "   → $CONFIG_FILE"
else
  echo ":: Config exists: $CONFIG_FILE (skipped)"
fi

echo ""
echo ":: Deploy complete ✅"
echo "   Installed to: $INSTALL_DIR"
echo "   Config:       $CONFIG_FILE"
echo "   Socket:       $SOCKET_PATH"
echo "   RPC helper:   bb-rpc <method> [params]"
echo ""
echo ":: Manual step required"
echo "   Start Betterbird/Thunderbird yourself: $BB_BIN"
