/* global browser */

// Betterbird/Thunderbird provides `browser` (and sometimes `messenger`).
const B = globalThis.browser ?? globalThis.messenger;

const NATIVE_APP = "ai.openclaw.betterbird_bridge";

let port = null;
let nextId = 1;
let newMailListenerRegistered = false;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log("[openclaw-bb]", ...args);
}

function serializeError(err) {
  if (!err) return { message: "Unknown error" };
  if (typeof err === "string") return { message: err };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Handlers ───────────────────────────────────────────────
//
// The addon is intentionally kept as a thin relay.
// All business logic lives in the native host (host.mjs).
//
// Handler categories:
//   1. api.call            — generic relay for any browser.* API
//   2. binary.*            — methods returning non-serializable types (File)
//   3. compose.addAttachment — needs to construct a File from base64
//

const handlers = {
  /**
   * Generic API relay: call any browser.* API.
   *   { namespace: "messages", method: "get", args: [12345] }
   *   → browser.messages.get(12345)
   */
  async "api.call"({ namespace, method, args = [] } = {}) {
    if (!namespace) throw new Error("namespace is required");
    if (!method) throw new Error("method is required");

    const ns = B[namespace];
    if (ns == null) throw new Error(`Unknown namespace: ${namespace}`);

    const fn = ns[method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown method: ${namespace}.${method}`);
    }

    // Bind to the namespace so `this` is correct.
    return await fn.apply(ns, args);
  },

  /**
   * Get attachment file content as base64.
   * B.messages.getAttachmentFile() returns a File object (not serializable).
   */
  async "binary.getAttachment"({ messageId, partName } = {}) {
    if (!messageId || !partName) {
      throw new Error("messageId and partName are required");
    }

    const file = await B.messages.getAttachmentFile(messageId, partName);
    if (!file) {
      return {
        messageId, partName,
        dataBase64: null, name: partName, contentType: null, size: 0,
      };
    }

    let base64 = null;
    try {
      const buf = await file.arrayBuffer();
      base64 = arrayBufferToBase64(buf);
    } catch (_) {
      try {
        const text = await file.text();
        base64 = textToBase64(text);
      } catch (__) {
        // give up
      }
    }

    return {
      messageId, partName,
      name: file.name ?? partName,
      contentType: file.type ?? "",
      size: file.size ?? 0,
      dataBase64: base64,
    };
  },

  /**
   * Get raw RFC 822 message source as base64.
   * B.messages.getRaw() may return a string or a File depending on TB version.
   */
  async "binary.getRaw"({ messageId } = {}) {
    if (!messageId) throw new Error("messageId is required");

    const raw = await B.messages.getRaw(messageId);

    if (typeof raw === "string") {
      const bytes = new TextEncoder().encode(raw);
      return {
        messageId,
        rawBase64: bytesToBase64(bytes),
        size: bytes.byteLength,
      };
    }

    // Newer TB: may return a File/Blob.
    if (raw && typeof raw.arrayBuffer === "function") {
      const buf = await raw.arrayBuffer();
      return {
        messageId,
        rawBase64: arrayBufferToBase64(buf),
        size: buf.byteLength,
      };
    }

    throw new Error("getRaw returned unexpected type");
  },

  /**
   * Add an attachment to a compose tab from base64 data.
   * B.compose.addAttachment() requires a File object.
   */
  async "compose.addAttachment"({ tabId, name, contentBase64, contentType } = {}) {
    if (!tabId) throw new Error("tabId is required");
    if (!contentBase64) throw new Error("contentBase64 is required");

    const bytes = base64ToBytes(contentBase64);
    const file = new File(
      [bytes],
      name || "attachment",
      { type: contentType || "application/octet-stream" },
    );
    await B.compose.addAttachment(tabId, { file, name });
    return { ok: true };
  },
};


function postEvent(name, payload) {
  if (!port) return;

  try {
    port.postMessage({
      type: "event",
      name,
      receivedAt: new Date().toISOString(),
      payload,
    });
  } catch (err) {
    log("failed to post event", name, err);
  }
}

async function drainMessageList(initialList) {
  const messages = Array.isArray(initialList?.messages) ? [...initialList.messages] : [];
  const listId = initialList?.id || null;

  if (!listId) return messages;

  try {
    while (true) {
      const page = await B.messages.continueList(listId);
      const batch = Array.isArray(page?.messages) ? page.messages : [];
      if (!batch.length) break;
      messages.push(...batch);
      if (!page?.id) break;
    }
  } catch (err) {
    // Thunderbird throws when the list is exhausted — that's fine.
    log("continueList ended", err?.message);
  }

  try {
    await B.messages.abortList(listId);
  } catch (_) {
    // already done
  }

  return messages;
}

function setupNewMailListener() {
  if (newMailListenerRegistered) return;
  const event = B.messages?.onNewMailReceived;
  if (!event || typeof event.addListener !== "function") {
    log("messages.onNewMailReceived is unavailable");
    return;
  }

  event.addListener(async (folder, messageList) => {
    try {
      const messages = await drainMessageList(messageList);
      postEvent("messages.newMail", { folder, messages });
    } catch (err) {
      log("failed to handle new mail event", err);
    }
  }, /* monitorAllFolders */ true);
  newMailListenerRegistered = true;
  log("registered new mail listener (monitorAllFolders=true)");
}

// ─── Native Messaging ──────────────────────────────────────

async function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "request") {
    const { id, method, params } = msg;
    const handler = handlers[method];

    if (!handler) {
      port.postMessage({
        type: "response", id,
        error: { message: `Unknown method: ${method}` },
      });
      return;
    }

    try {
      const result = await handler(params);
      port.postMessage({ type: "response", id, result });
    } catch (err) {
      port.postMessage({ type: "response", id, error: serializeError(err) });
    }
  }
}

function connectNative() {
  if (port) return;

  try {
    port = B.runtime.connectNative(NATIVE_APP);
  } catch (err) {
    log("connectNative failed", err);
    return;
  }

  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => {
    const e = B.runtime.lastError;
    log("native disconnected", e?.message);
    port = null;
    // Try reconnect later.
    setTimeout(connectNative, 2000);
  });

  port.postMessage({ type: "hello", id: nextId++, addonVersion: "0.3.0" });
  setupNewMailListener();
  log("connected to native host", NATIVE_APP);
}

connectNative();
