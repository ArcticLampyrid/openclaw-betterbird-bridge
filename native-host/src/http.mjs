import http from "node:http";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

export function startHttpServer({ port, token, rpcCall, status }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...status() }));
        return;
      }

      if (url.pathname === "/rpc" && req.method === "POST") {
        // token via header or query
        const auth = req.headers.authorization || "";
        const qToken = url.searchParams.get("token") || "";
        const got = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : qToken;

        if (token && got !== token) {
          unauthorized(res);
          return;
        }

        const body = await readJson(req);
        const { method, params, id } = body || {};

        const result = await rpcCall({ method, params, id });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", message: String(e?.message || e) }));
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}
