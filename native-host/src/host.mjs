import crypto from "node:crypto";
import { encodeNativeMessage, createNativeMessageReader } from "./nativeMessaging.mjs";
import { loadConfig } from "./config.mjs";
import { startHttpServer } from "./http.mjs";

const cfg = loadConfig();

let connected = false;
let addon = { version: null };
let nextId = 1;

/** @type {Map<number, {resolve: Function, reject: Function, timeout: NodeJS.Timeout}>} */
const pending = new Map();

// ─── Method classification sets ────────────────────────────

const WRITE_METHODS = new Set([
  "messages.markRead",
  "messages.markUnread",
  "messages.move",
  "messages.archive",
  "messages.trash",
  "messages.delete",
]);

const COMPOSE_METHODS = new Set([
  "compose.new",
  "compose.reply",
  "compose.forward",
]);

const DESTRUCTIVE_METHODS = new Set([
  "messages.move",
  "messages.archive",
  "messages.trash",
  "messages.delete",
]);

// ─── Native Messaging plumbing ─────────────────────────────

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
 * The addon now only exposes thin relay handlers:
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
 *   api("messages", "get", messageId)  →  browser.messages.get(messageId)
 */
async function api(namespace, method, ...args) {
  return await callAddon("api.call", { namespace, method, args });
}

// ─── Utilities ─────────────────────────────────────────────

function normalizeIdList(maybeIds) {
  if (!maybeIds) return [];
  if (Array.isArray(maybeIds)) return maybeIds;
  return [maybeIds];
}

function* walkFolders(folders) {
  for (const f of folders || []) {
    yield f;
    if (f?.subFolders?.length) {
      yield* walkFolders(f.subFolders);
    }
  }
}

function hasSpecialUse(folder, specialUse) {
  const su = folder?.specialUse;
  if (!Array.isArray(su)) return false;
  return su.includes(specialUse);
}

async function findSpecialFolderId({ accountId, specialUse, nameFallback = null }) {
  if (!accountId) return null;
  const acct = await api("accounts", "get", accountId, true);

  for (const f of walkFolders(acct?.folders)) {
    if (hasSpecialUse(f, specialUse)) return f.id;
  }

  if (nameFallback) {
    const want = String(nameFallback).toLowerCase();
    for (const f of walkFolders(acct?.folders)) {
      if (String(f?.name || "").toLowerCase() === want) return f.id;
    }
  }

  return null;
}

// ─── Message body extraction ───────────────────────────────

async function extractInlineText(messageId) {
  let parts;
  try {
    // TB 128+ supports listInlineTextParts.
    parts = await api("messages", "listInlineTextParts", messageId);
  } catch (_) {
    return { plain: null, html: null, parts: [] };
  }

  let plain = null;
  let html = null;

  for (const p of parts || []) {
    const ct = (p.contentType || "").toLowerCase();
    if (!plain && ct.startsWith("text/plain")) plain = p.content ?? null;
    if (!html && ct.startsWith("text/html")) html = p.content ?? null;
  }

  // If only HTML is available, try to convert (TB 137+).
  if (!plain && html) {
    try {
      plain = await api("messengerUtilities", "convertToPlainText", html);
    } catch (_) {
      // not available
    }
  }

  return { plain, html, parts };
}

// ─── Compose helpers ───────────────────────────────────────

async function addAttachments(tabId, attachments) {
  if (!attachments || attachments.length === 0) return;

  for (const att of attachments) {
    await callAddon("compose.addAttachment", {
      tabId,
      name: att.name,
      contentBase64: att.contentBase64,
      contentType: att.contentType,
    });
  }
}

async function sendCompose(tab, attachments) {
  await addAttachments(tab.id, attachments);
  return await api("compose", "sendMessage", tab.id, { mode: "sendNow" });
}

// ─── Pagination helpers ────────────────────────────────────

/**
 * Drain all pages from a MessageList result.
 */
async function drainMessageList(listResult) {
  if (!listResult) return [];

  const headers = [...(listResult.messages || [])];
  const messageListId = listResult.id;

  if (messageListId && headers.length > 0) {
    try {
      while (true) {
        const contResult = await api("messages", "continueList", messageListId);
        if (!contResult?.messages?.length) break;
        headers.push(...contResult.messages);
      }
    } catch (_) {
      // Thunderbird throws when the list is exhausted — that's fine.
    }

    try { await api("messages", "abortList", messageListId); } catch (_) { /* already done */ }
  } else if (messageListId) {
    try { await api("messages", "abortList", messageListId); } catch (_) { /* ok */ }
  }

  return headers;
}

/**
 * Collect up to `count` messages from a paginated MessageList result.
 * Stops reading pages as soon as enough messages are collected.
 */
async function collectFromMessageList(listResult, count) {
  if (!listResult) return [];

  const headers = [...(listResult.messages || [])];
  const messageListId = listResult.id;

  if (messageListId && headers.length < count) {
    try {
      while (headers.length < count) {
        const contResult = await api("messages", "continueList", messageListId);
        if (!contResult?.messages?.length) break;
        headers.push(...contResult.messages);
      }
    } catch (_) {
      // exhausted
    }

    try { await api("messages", "abortList", messageListId); } catch (_) { /* already done */ }
  } else if (messageListId) {
    try { await api("messages", "abortList", messageListId); } catch (_) { /* ok */ }
  }

  return headers.slice(0, count);
}

/**
 * Get the latest N messages from a single folder.
 * Drains all messages and sorts by date descending, since the
 * return order of messages.list is not guaranteed.
 */
async function listLatestFromFolder({ folderId, count }) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount === 0) return [];

  const listResult = await api("messages", "list", folderId);
  const headers = await drainMessageList(listResult);
  headers.sort((a, b) => new Date(b.date) - new Date(a.date));
  return headers.slice(0, targetCount);
}

// ─── Security validation ───────────────────────────────────

async function assertFolderAllowlist({ messageIds, allowFolderIds }) {
  if (!allowFolderIds) return;
  if (!Array.isArray(allowFolderIds) || allowFolderIds.length === 0) {
    throw new Error("allowFolderIds must be a non-empty array when provided");
  }

  const allowSet = new Set(allowFolderIds);

  for (const messageId of messageIds) {
    const header = await api("messages", "get", messageId);
    const folderId = header?.folder?.id;
    if (!folderId) {
      throw new Error(`Message ${messageId} has no folder.id (accountsRead missing? external message?)`);
    }
    if (!allowSet.has(folderId)) {
      throw new Error(`Folder not allowlisted for message ${messageId}: ${folderId}`);
    }
  }
}

async function validateWriteCall(method, params) {
  const p = params && typeof params === "object" ? params : {};

  const messageIds = normalizeIdList(p.messageIds);
  if (messageIds.length === 0) {
    throw new Error("messageIds is required for write methods");
  }

  if (method === "messages.delete") {
    if (!cfg.allowHardDelete) {
      throw new Error("Hard delete is disabled (set write.allowHardDelete=true in config)");
    }
    if (p.confirm !== "DELETE") {
      throw new Error('Hard delete requires confirm="DELETE"');
    }
  }

  if (DESTRUCTIVE_METHODS.has(method)) {
    await assertFolderAllowlist({ messageIds, allowFolderIds: p.allowFolderIds });

    if (method === "messages.move" && p.allowFolderIds) {
      const allowSet = new Set(p.allowFolderIds);
      if (!p.folderId || typeof p.folderId !== "string") {
        throw new Error("folderId is required for messages.move");
      }
      if (!allowSet.has(p.folderId)) {
        throw new Error(`Destination folderId not allowlisted: ${p.folderId}`);
      }
    }
  }

  if (!cfg.writeEnabled) {
    throw new Error("Write methods are disabled (set write.enabled=true in config)");
  }

  return { messageIds };
}

async function validateComposeCall(method, params) {
  const p = params && typeof params === "object" ? params : {};

  if (!cfg.composeEnabled) {
    throw new Error("Compose/send methods are disabled (set compose.enabled=true in config)");
  }

  if (method === "compose.new") {
    if (!p.to || (Array.isArray(p.to) && p.to.length === 0)) {
      throw new Error("compose.new requires at least one recipient in 'to'");
    }
  }

  if ((method === "compose.reply" || method === "compose.forward") && !p.messageId) {
    throw new Error(`${method} requires messageId`);
  }

  if (method === "compose.forward") {
    if (!p.to || (Array.isArray(p.to) && p.to.length === 0)) {
      throw new Error("compose.forward requires at least one recipient in 'to'");
    }
  }
}

// ─── RPC handlers ──────────────────────────────────────────
//
// All business logic lives here; the addon is a thin relay.
//

const handlers = {
  // ── Health ──

  async ping(params) {
    let info = null;
    try { info = await api("runtime", "getBrowserInfo"); } catch (_) { /* ok */ }
    return { ok: true, ts: Date.now(), params, browserInfo: info };
  },

  // ── Accounts & Folders ──

  async "accounts.list"({ includeSubFolders = true } = {}) {
    return await api("accounts", "list", includeSubFolders);
  },

  async "accounts.get"({ accountId, includeSubFolders = true } = {}) {
    return await api("accounts", "get", accountId, includeSubFolders);
  },

  async "folders.get"({ folderId, includeSubFolders = true } = {}) {
    return await api("folders", "get", folderId, includeSubFolders);
  },

  async "folders.getSubFolders"({ folderId, includeSubFolders = true } = {}) {
    return await api("folders", "getSubFolders", folderId, includeSubFolders);
  },

  async "folders.getFolderInfo"({ folderId } = {}) {
    return await api("folders", "getFolderInfo", folderId);
  },

  // ── Messages (read) ──

  async "messages.list"({ folderId } = {}) {
    return await api("messages", "list", folderId);
  },

  async "messages.query"({ queryInfo = {} } = {}) {
    return await api("messages", "query", queryInfo);
  },

  async "messages.continueList"({ messageListId } = {}) {
    return await api("messages", "continueList", messageListId);
  },

  async "messages.abortList"({ messageListId } = {}) {
    return await api("messages", "abortList", messageListId);
  },

  async "messages.get"({ messageId } = {}) {
    return await api("messages", "get", messageId);
  },

  async "messages.read"({ messageId, includeAttachments = true } = {}) {
    const header = await api("messages", "get", messageId);
    const text = await extractInlineText(messageId);

    let attachments = [];
    if (includeAttachments) {
      try {
        attachments = await api("messages", "listAttachments", messageId);
      } catch (_) {
        // listAttachments might not be available
      }
    }

    return { header, text, attachments };
  },

  async "messages.latest"({ folderId, count = 10 } = {}) {
    const targetCount = Math.max(0, Number(count) || 0);
    if (targetCount === 0) return [];
    return await listLatestFromFolder({ folderId, count: targetCount });
  },

  async "messages.latestAll"({ accountId, count = 10 } = {}) {
    const targetCount = Math.max(0, Number(count) || 0);
    if (targetCount === 0) return [];

    const accounts = await api("accounts", "list", true);
    const allHeaders = [];

    for (const acct of accounts || []) {
      if (accountId && acct?.id !== accountId) continue;

      for (const folder of walkFolders(acct?.folders)) {
        const folderId = folder?.id;
        if (!folderId) continue;

        const headers = await listLatestFromFolder({
          folderId,
          count: targetCount,
        });
        allHeaders.push(...headers);
      }
    }

    allHeaders.sort((a, b) => new Date(b.date) - new Date(a.date));
    return allHeaders.slice(0, targetCount);
  },

  async "messages.search"({ folderId, queryInfo = {}, count = 10 } = {}) {
    const targetCount = Math.max(0, Number(count) || 0);
    if (targetCount === 0) return [];

    const listResult = await api("messages", "query", { ...queryInfo, folderId });
    const headers = await drainMessageList(listResult);
    headers.sort((a, b) => new Date(b.date) - new Date(a.date));
    return headers.slice(0, targetCount);
  },

  async "messages.unread"({ accountId, folderId, count = 25 } = {}) {
    const targetCount = Math.max(0, Number(count) || 0);
    if (targetCount === 0) return [];

    const queryInfo = { unread: true };
    if (accountId) queryInfo.accountId = accountId;
    if (folderId) {
      queryInfo.folderId = folderId;
      queryInfo.includeSubFolders = true;
    }

    const listResult = await api("messages", "query", queryInfo);
    const headers = await drainMessageList(listResult);
    headers.sort((a, b) => new Date(b.date) - new Date(a.date));
    return headers.slice(0, targetCount);
  },

  // ── Raw / Attachments ──

  async "messages.getRaw"({ messageId } = {}) {
    return await callAddon("binary.getRaw", { messageId });
  },

  async "attachments.get"({ messageId, partName } = {}) {
    return await callAddon("binary.getAttachment", { messageId, partName });
  },

  async "attachments.save"({ messageId, partName } = {}) {
    return await callAddon("binary.getAttachment", { messageId, partName });
  },

  // ── Write methods ──

  async "messages.markRead"({ messageIds } = {}) {
    const ids = normalizeIdList(messageIds);
    for (const id of ids) {
      await api("messages", "update", id, { read: true });
    }
    return { ok: true, updatedCount: ids.length, messageIds: ids };
  },

  async "messages.markUnread"({ messageIds } = {}) {
    const ids = normalizeIdList(messageIds);
    for (const id of ids) {
      await api("messages", "update", id, { read: false });
    }
    return { ok: true, updatedCount: ids.length, messageIds: ids };
  },

  async "messages.move"({ messageIds, folderId, options } = {}) {
    const ids = normalizeIdList(messageIds);
    if (!folderId) throw new Error("folderId is required");
    await api("messages", "move", ids, folderId, options);
    return { ok: true, movedCount: ids.length, messageIds: ids, folderId };
  },

  async "messages.archive"({ messageIds } = {}) {
    const ids = normalizeIdList(messageIds);
    await api("messages", "archive", ids);
    return { ok: true, archivedCount: ids.length, messageIds: ids };
  },

  async "messages.trash"({ messageIds } = {}) {
    const ids = normalizeIdList(messageIds);

    /** @type {Map<string, {messageIds: any[], trashFolderId: string | null}>} */
    const byAccount = new Map();

    for (const messageId of ids) {
      const header = await api("messages", "get", messageId);
      const accountId = header?.folder?.accountId;
      if (!accountId) {
        throw new Error(`Cannot determine accountId for message ${messageId}`);
      }

      let entry = byAccount.get(accountId);
      if (!entry) {
        entry = { messageIds: [], trashFolderId: null };
        byAccount.set(accountId, entry);
      }
      entry.messageIds.push(messageId);
    }

    for (const [accountId, entry] of byAccount) {
      entry.trashFolderId = await findSpecialFolderId({
        accountId,
        specialUse: "trash",
        nameFallback: "trash",
      });
      if (!entry.trashFolderId) {
        throw new Error(`Trash folder not found for accountId: ${accountId}`);
      }
    }

    for (const entry of byAccount.values()) {
      await api("messages", "move", entry.messageIds, entry.trashFolderId);
    }

    return { ok: true, trashedCount: ids.length, messageIds: ids };
  },

  async "messages.delete"({ messageIds } = {}) {
    const ids = normalizeIdList(messageIds);
    try {
      await api("messages", "delete", ids, { deletePermanently: true, isUserAction: true });
    } catch (_) {
      await api("messages", "delete", ids, true);
    }
    return { ok: true, deletedCount: ids.length, messageIds: ids };
  },

  // ── Compose ──

  async "compose.new"({
    to, cc, bcc, subject, body, plainTextBody, isPlainText,
    identityId, attachments,
  } = {}) {
    const details = {};
    if (to) details.to = Array.isArray(to) ? to : [to];
    if (cc) details.cc = Array.isArray(cc) ? cc : [cc];
    if (bcc) details.bcc = Array.isArray(bcc) ? bcc : [bcc];
    if (subject != null) details.subject = subject;
    if (isPlainText != null) details.isPlainText = isPlainText;
    if (body != null) details.body = body;
    if (plainTextBody != null) details.plainTextBody = plainTextBody;
    if (identityId) details.identityId = identityId;

    const tab = await api("compose", "beginNew", null, details);
    const sendResult = await sendCompose(tab, attachments);
    return { ok: true, method: "compose.new", tabId: tab.id, sendResult };
  },

  async "compose.reply"({
    messageId, replyType = "replyToSender",
    body, plainTextBody, isPlainText,
    identityId, attachments,
  } = {}) {
    if (!messageId) throw new Error("messageId is required");

    const details = {};
    if (isPlainText != null) details.isPlainText = isPlainText;
    if (body != null) details.body = body;
    if (plainTextBody != null) details.plainTextBody = plainTextBody;
    if (identityId) details.identityId = identityId;

    const tab = await api("compose", "beginReply", messageId, replyType, details);
    const sendResult = await sendCompose(tab, attachments);
    return { ok: true, method: "compose.reply", messageId, replyType, tabId: tab.id, sendResult };
  },

  async "compose.forward"({
    messageId, forwardType = "forwardAsAttachment",
    to, cc, bcc, body, plainTextBody, isPlainText,
    identityId, attachments,
  } = {}) {
    if (!messageId) throw new Error("messageId is required");

    const details = {};
    if (to) details.to = Array.isArray(to) ? to : [to];
    if (cc) details.cc = Array.isArray(cc) ? cc : [cc];
    if (bcc) details.bcc = Array.isArray(bcc) ? bcc : [bcc];
    if (isPlainText != null) details.isPlainText = isPlainText;
    if (body != null) details.body = body;
    if (plainTextBody != null) details.plainTextBody = plainTextBody;
    if (identityId) details.identityId = identityId;

    const tab = await api("compose", "beginForward", messageId, forwardType, details);
    const sendResult = await sendCompose(tab, attachments);
    return { ok: true, method: "compose.forward", messageId, forwardType, tabId: tab.id, sendResult };
  },
};

// ─── RPC dispatcher ────────────────────────────────────────

function status() {
  return {
    connected,
    addon,
    pending: pending.size,
    write: {
      enabled: cfg.writeEnabled,
      allowHardDelete: cfg.allowHardDelete,
    },
    compose: {
      enabled: cfg.composeEnabled,
    },
  };
}

async function rpcCall({ method, params, id }) {
  const correlationId = id ?? `auto-${crypto.randomUUID()}`;

  try {
    const handler = handlers[method];
    if (!handler) {
      return { id: correlationId, ok: false, error: { message: `Unknown method: ${method}`, method } };
    }

    // Security gates.
    if (WRITE_METHODS.has(method)) {
      await validateWriteCall(method, params);
    }
    if (COMPOSE_METHODS.has(method)) {
      await validateComposeCall(method, params);
    }

    const result = await handler(params);
    return { id: correlationId, ok: true, result };
  } catch (e) {
    return { id: correlationId, ok: false, error: { message: e.message, method: method ?? null } };
  }
}

// ─── Boot ──────────────────────────────────────────────────

startHttpServer({
  port: cfg.port,
  token: cfg.token,
  rpcCall,
  status,
});

send({ type: "host-ready", version: "0.2.0" });
