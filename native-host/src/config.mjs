import fs from "node:fs";
import path from "node:path";

const DEFAULT_PATH = path.join(process.env.HOME || ".", ".config", "openclaw", "betterbird-bridge.json");

export function loadConfig() {
  const cfgPath = process.env.OPENCLAW_BB_CONFIG || DEFAULT_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {
    // allow missing
  }

  const port = Number(cfg.port ?? process.env.OPENCLAW_BB_PORT ?? 17380);
  const token = String(cfg.token ?? process.env.OPENCLAW_BB_TOKEN ?? "");

  return { cfgPath, port, token };
}
