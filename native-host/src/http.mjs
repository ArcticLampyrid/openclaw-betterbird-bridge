import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const JSON_HEADERS = { "content-type": "application/json" };
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const SOCKET_MODE = 0o600;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function readJson(req, { maxBodyBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > maxBodyBytes) {
        const err = new Error("request body too large");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data) return resolve(null);

      try {
        resolve(JSON.parse(data));
      } catch (e) {
        e.code = "INVALID_JSON";
        reject(e);
      }
    });

    req.on("error", reject);
  });
}

function removeSocketIfPresent(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Socket path exists and is not a socket: ${socketPath}`);
    }
    fs.unlinkSync(socketPath);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
}

function prepareSocketPath(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  removeSocketIfPresent(socketPath);
}

export function startHttpServer({ socketPath, rpcCall, status }) {
  if (!socketPath) {
    throw new Error("socketPath is required");
  }

  prepareSocketPath(socketPath);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, ...status() });
        return;
      }

      if (url.pathname === "/rpc" && req.method === "POST") {
        const body = await readJson(req);
        const { method, params, id } = body || {};

        const result = await rpcCall({ method, params, id });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (e) {
      if (e?.code === "INVALID_JSON") {
        sendJson(res, 400, { error: "invalid_json", message: e.message });
        return;
      }

      if (e?.code === "PAYLOAD_TOO_LARGE") {
        sendJson(res, 413, { error: "payload_too_large", maxBytes: MAX_BODY_BYTES });
        return;
      }

      sendJson(res, 500, { error: "internal_error", message: String(e?.message || e) });
    }
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, SOCKET_MODE);
    } catch (_) {
      // best effort
    }
  });

  const cleanup = () => {
    try {
      removeSocketIfPresent(socketPath);
    } catch (_) {
      // best effort
    }
  };

  process.on("exit", cleanup);
  server.on("close", cleanup);

  return server;
}
