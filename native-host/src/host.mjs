import { encodeNativeMessage, createNativeMessageReader } from "./nativeMessaging.mjs";
import { loadConfig } from "./config.mjs";
import { startHttpServer } from "./http.mjs";

const cfg = loadConfig();

let connected = false;
let addon = { version: null };
let nextId = 1;

/** @type {Map<number, {resolve: Function, reject: Function, timeout: NodeJS.Timeout}>} */
const pending = new Map();

function send(msg) {
  process.stdout.write(encodeNativeMessage(msg));
}

function onNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "hello") {
    connected = true;
    addon.version = msg.addonVersion || null;
    return;
  }

  if (msg.type === "response" && typeof msg.id === "number") {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timeout);
    pending.delete(msg.id);

    if (msg.error) {
      p.reject(Object.assign(new Error(msg.error.message || "RPC error"), { data: msg.error }));
    } else {
      p.resolve(msg.result);
    }
  }
}

process.stdin.on("data", createNativeMessageReader(onNativeMessage));
process.stdin.on("end", () => process.exit(0));

async function callAddon(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for addon response: ${method}`));
    }, 30_000);

    pending.set(id, { resolve, reject, timeout });
    send({ type: "request", id, method, params });
  });
}

async function handleMessagesLatest({ folderId, count = 10 }) {
  const queryResult = await callAddon("messages.query", { queryInfo: { folderId } });
  if (!queryResult || !queryResult.id) {
    return [];
  }

  const headers = [...(queryResult.messages || [])];
  const messageListId = queryResult.id;

  while (headers.length < count) {
    const contResult = await callAddon("messages.continueList", { messageListId });
    if (!contResult || !contResult.messages || contResult.messages.length === 0) {
      break;
    }
    headers.push(...contResult.messages);
  }

  await callAddon("messages.abortList", { messageListId });

  return headers.slice(0, count);
}

async function handleMessagesSearch({ folderId, queryInfo = {}, count = 10 }) {
  const fullQuery = { ...queryInfo, folderId };
  const queryResult = await callAddon("messages.query", { queryInfo: fullQuery });
  if (!queryResult || !queryResult.id) {
    return [];
  }

  const headers = [...(queryResult.messages || [])];
  const messageListId = queryResult.id;

  while (headers.length < count) {
    const contResult = await callAddon("messages.continueList", { messageListId });
    if (!contResult || !contResult.messages || contResult.messages.length === 0) {
      break;
    }
    headers.push(...contResult.messages);
  }

  await callAddon("messages.abortList", { messageListId });

  return headers.slice(0, count);
}

function status() {
  return {
    connected,
    addon,
    pending: pending.size,
  };
}

async function rpcCall({ method, params, id }) {
  try {
    let result;
    if (method === "messages.latest") {
      result = await handleMessagesLatest(params);
    } else if (method === "messages.search") {
      result = await handleMessagesSearch(params);
    } else {
      result = await callAddon(method, params);
    }
    return { id: id ?? null, ok: true, result };
  } catch (e) {
    return { id: id ?? null, ok: false, error: { message: e.message } };
  }
}

// Start HTTP server.
startHttpServer({
  port: cfg.port,
  token: cfg.token,
  rpcCall,
  status,
});

// Tell addon we're ready.
send({ type: "host-ready", version: "0.1.0" });
