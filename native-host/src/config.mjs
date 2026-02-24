import fs from "node:fs";
import path from "node:path";

const HOME_DIR = process.env.HOME || ".";
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME_DIR, ".config");
const CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(HOME_DIR, ".cache");
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || "";

const DEFAULT_PATH = path.join(CONFIG_HOME, "betterbird-bridge", "config.json");
const DEFAULT_SOCKET_PATH = RUNTIME_DIR
  ? path.join(RUNTIME_DIR, "betterbird-bridge", "bridge.sock")
  : path.join(CACHE_HOME, "betterbird-bridge", "bridge.sock");

function expandHome(p) {
  if (p == null) return "";
  const value = String(p);
  if (value === "~") return HOME_DIR;
  if (value.startsWith("~/")) return path.join(HOME_DIR, value.slice(2));
  return value;
}

function normalizePath(p) {
  const value = expandHome(p);
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(value);
}

export function loadConfig() {
  const cfgPath = normalizePath(process.env.OPENCLAW_BB_CONFIG || DEFAULT_PATH);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {
    // allow missing
  }

  const socketPath = normalizePath(
    process.env.OPENCLAW_BB_SOCKET_PATH ?? cfg.socketPath ?? DEFAULT_SOCKET_PATH,
  );

  return { cfgPath, socketPath };
}
