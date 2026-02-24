import crypto from "node:crypto";
import { encodeNativeMessage, createNativeMessageReader } from "./nativeMessaging.mjs";
import { loadConfig } from "./config.mjs";
import { startHttpServer } from "./http.mjs";
import { createPaginationHelpers } from "./rpc/pagination.mjs";
import { createMailHelpers } from "./rpc/mail.mjs";
import { createComposeHelpers } from "./rpc/compose.mjs";
import { createReadHandlers } from "./rpc/handlers/read.mjs";
import { createWriteHandlers } from "./rpc/handlers/write.mjs";
import { createComposeHandlers } from "./rpc/handlers/compose.mjs";

const cfg = loadConfig();

let connected = false;
let addon = { version: null };
let browserVersion = 0;
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

/**
 * Send a request to the addon and await the response.
 * The addon only exposes thin relay handlers:
 *   "api.call", "binary.getAttachment", "binary.getRaw", "compose.addAttachment"
 */
async function callAddon(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for addon response: ${method}`));
    }, 120_000);

    pending.set(id, { resolve, reject, timeout });
    send({ type: "request", id, method, params });
  });
}

/**
 * Convenience: call any browser.* API via the addon's generic relay.
 *   api("messages", "get", messageId) -> browser.messages.get(messageId)
 */
async function api(namespace, method, ...args) {
  return await callAddon("api.call", { namespace, method, args });
}

async function detectBrowserVersion() {
  if (browserVersion > 0) return browserVersion;

  try {
    const info = await api("runtime", "getBrowserInfo");
    browserVersion = parseInt(info?.version, 10) || 0;
  } catch (_) {
    browserVersion = 0;
  }

  return browserVersion;
}

/**
 * Whether messages.list supports sort options (TB 148+).
 */
async function supportsListSortOptions() {
  return (await detectBrowserVersion()) >= 148;
}

const { forEachPage, listLatestFromFolder } = createPaginationHelpers({
  api,
  supportsListSortOptions,
});
const { findSpecialFolderId, extractInlineText } = createMailHelpers({ api });
const { sendCompose } = createComposeHelpers({ api, callAddon });

const handlers = {
  ...createReadHandlers({
    api,
    callAddon,
    extractInlineText,
    listLatestFromFolder,
    forEachPage,
  }),
  ...createWriteHandlers({
    api,
    findSpecialFolderId,
  }),
  ...createComposeHandlers({
    api,
    sendCompose,
  }),
};

function status() {
  return {
    connected,
    addon,
    pending: pending.size,
    transport: {
      kind: "unix_socket",
      socketPath: cfg.socketPath,
    },
  };
}

async function rpcCall({ method, params, id }) {
  const correlationId = id ?? `auto-${crypto.randomUUID()}`;

  try {
    const handler = handlers[method];
    if (!handler) {
      return {
        id: correlationId,
        ok: false,
        error: { message: `Unknown method: ${method}`, method },
      };
    }

    const result = await handler(params);
    return { id: correlationId, ok: true, result };
  } catch (e) {
    return {
      id: correlationId,
      ok: false,
      error: { message: e.message, method: method ?? null },
    };
  }
}

startHttpServer({
  socketPath: cfg.socketPath,
  rpcCall,
  status,
});

send({ type: "host-ready", version: "0.3.0" });
