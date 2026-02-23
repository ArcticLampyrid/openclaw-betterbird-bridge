/* global browser */

// Betterbird/Thunderbird provides `browser` (and sometimes `messenger`).
const B = globalThis.browser ?? globalThis.messenger;

const NATIVE_APP = "ai.openclaw.betterbird_bridge";

let port = null;
let nextId = 1;

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

async function extractInlineText(messageId) {
  // TB 128+ supports listInlineTextParts.
  if (!B.messages.listInlineTextParts) {
    return { plain: null, html: null, parts: [] };
  }

  const parts = await B.messages.listInlineTextParts(messageId);
  let plain = null;
  let html = null;

  for (const p of parts || []) {
    const ct = (p.contentType || "").toLowerCase();
    if (!plain && ct.startsWith("text/plain")) plain = p.content ?? null;
    if (!html && ct.startsWith("text/html")) html = p.content ?? null;
  }

  // If only HTML is available, try to convert it (TB 137+).
  if (!plain && html && B.messengerUtilities?.convertToPlainText) {
    try {
      plain = await B.messengerUtilities.convertToPlainText(html);
    } catch (_) {
      // ignore
    }
  }

  return { plain, html, parts };
}

const handlers = {
  async ping(params) {
    const info = await (B.runtime.getBrowserInfo ? B.runtime.getBrowserInfo() : null);
    return {
      ok: true,
      ts: Date.now(),
      params,
      browserInfo: info,
    };
  },

  async "accounts.list"({ includeSubFolders = true } = {}) {
    return await B.accounts.list(includeSubFolders);
  },

  async "accounts.get"({ accountId, includeSubFolders = true } = {}) {
    return await B.accounts.get(accountId, includeSubFolders);
  },

  async "folders.get"({ folderId, includeSubFolders = true } = {}) {
    return await B.folders.get(folderId, includeSubFolders);
  },

  async "folders.getSubFolders"({ folderId, includeSubFolders = true } = {}) {
    return await B.folders.getSubFolders(folderId, includeSubFolders);
  },

  async "messages.query"({ queryInfo = {} } = {}) {
    return await B.messages.query(queryInfo);
  },

  async "messages.continueList"({ messageListId } = {}) {
    return await B.messages.continueList(messageListId);
  },

  async "messages.abortList"({ messageListId } = {}) {
    return await B.messages.abortList(messageListId);
  },

  async "messages.get"({ messageId } = {}) {
    return await B.messages.get(messageId);
  },

  async "messages.read"({ messageId, includeAttachments = true } = {}) {
    const header = await B.messages.get(messageId);
    const text = await extractInlineText(messageId);
    const attachments = includeAttachments && B.messages.listAttachments
      ? await B.messages.listAttachments(messageId)
      : [];

    return {
      header,
      text,
      attachments,
    };
  },
};

async function handleNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "request") {
    const { id, method, params } = msg;
    const handler = handlers[method];

    if (!handler) {
      port.postMessage({ type: "response", id, error: { message: `Unknown method: ${method}` } });
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

  port.postMessage({ type: "hello", id: nextId++, addonVersion: "0.1.0" });
  log("connected to native host", NATIVE_APP);
}

connectNative();
