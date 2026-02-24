import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH = path.join(
  process.env.HOME || ".",
  ".config",
  "betterbird-bridge",
  "config.json",
);
const DEFAULT_SOCKET_PATH = path.join(
  process.env.HOME || ".",
  ".cache",
  "betterbird-bridge",
  "bridge.sock",
);

export function loadConfig() {
  const cfgPath = process.env.OPENCLAW_BB_CONFIG || DEFAULT_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {
    // allow missing
  }

  const socketPath = String(
    process.env.OPENCLAW_BB_SOCKET_PATH ?? cfg.socketPath ?? DEFAULT_SOCKET_PATH,
  );

  return { cfgPath, socketPath };
}
