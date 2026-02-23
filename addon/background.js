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
  const acct = await B.accounts.get(accountId, true);

  for (const f of walkFolders(acct?.folders)) {
    if (hasSpecialUse(f, specialUse)) return f.id;
  }

  if (nameFallback) {
    const want = String(nameFallback).toLowerCase();
    for (const f of walkFolders(acct?.folders)) {
      const n = String(f?.name || "").toLowerCase();
      if (n === want) return f.id;
    }
  }

  return null;
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

/** Convert an ArrayBuffer to a base64 string (works in addon context). */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
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

  // =========================
  // Read methods — accounts / folders / messages
  // =========================

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

  async "messages.list"({ folderId } = {}) {
    return await B.messages.list(folderId);
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
    const attachments =
      includeAttachments && B.messages.listAttachments
        ? await B.messages.listAttachments(messageId)
        : [];

    return { header, text, attachments };
  },

  // =========================
  // Attachment content
  // =========================

  async "attachments.get"({ messageId, partName } = {}) {
    if (!messageId || !partName) {
      throw new Error("messageId and partName are required");
    }

    const file = await B.messages.getAttachmentFile(messageId, partName);
    if (!file) {
      return { messageId, partName, dataBase64: null, name: partName, contentType: null, size: 0 };
    }

    let base64 = null;
    try {
      const buf = await file.arrayBuffer();
      base64 = arrayBufferToBase64(buf);
    } catch (_) {
      // last resort: text() → encode
      try {
        const text = await file.text();
        const bytes = new TextEncoder().encode(text);
        base64 = arrayBufferToBase64(bytes.buffer);
      } catch (__) {
        // give up
      }
    }

    return {
      messageId,
      partName,
      name: file.name ?? partName,
      contentType: file.type ?? "",
      size: file.size ?? 0,
      dataBase64: base64,
    };
  },

  /** Save attachment — the addon returns base64 to the host, which writes it to disk. */
  async "attachments.save"({ messageId, partName } = {}) {
    // Re-use attachments.get and let the host handle file writing.
    return await handlers["attachments.get"]({ messageId, partName });
  },

  // =========================
  // Message export (.eml / raw source)
  // =========================

  async "messages.getRaw"({ messageId } = {}) {
    if (!messageId) throw new Error("messageId is required");

    // getRaw returns a string (the full RFC 822 source).
    // TB 72+; returns string by default, or File if data=File.
    const raw = await B.messages.getRaw(messageId);

    if (typeof raw === "string") {
      return { messageId, rawBase64: btoa(unescape(encodeURIComponent(raw))), size: raw.length };
    }

    // If getRaw returns a File/Blob (newer TB with data:"File" option)
    if (raw && typeof raw.arrayBuffer === "function") {
      const buf = await raw.arrayBuffer();
      return { messageId, rawBase64: arrayBufferToBase64(buf), size: buf.byteLength };
    }

    throw new Error("getRaw returned unexpected type");
  },

  // =========================
  // Write methods (guarded by native host config)
  // =========================

  async "messages.markRead"({ messageIds, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);
    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.markRead", messageIds: ids, changes: { read: true } };
    }

    const updated = [];
    for (const id of ids) {
      await B.messages.update(id, { read: true });
      updated.push(id);
    }

    return { ok: true, updatedCount: updated.length, messageIds: updated };
  },

  async "messages.markUnread"({ messageIds, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);
    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.markUnread", messageIds: ids, changes: { read: false } };
    }

    const updated = [];
    for (const id of ids) {
      await B.messages.update(id, { read: false });
      updated.push(id);
    }

    return { ok: true, updatedCount: updated.length, messageIds: updated };
  },

  async "messages.move"({ messageIds, folderId, options, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);
    if (!folderId) throw new Error("folderId is required");

    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.move", messageIds: ids, folderId, options: options ?? null };
    }

    await B.messages.move(ids, folderId, options);
    return { ok: true, movedCount: ids.length, messageIds: ids, folderId };
  },

  async "messages.archive"({ messageIds, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);
    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.archive", messageIds: ids };
    }

    await B.messages.archive(ids);
    return { ok: true, archivedCount: ids.length, messageIds: ids };
  },

  async "messages.trash"({ messageIds, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);

    // Figure out the trash folder per account.
    /** @type {Map<string, {messageIds: any[], trashFolderId: string | null}>} */
    const byAccount = new Map();

    for (const messageId of ids) {
      const header = await B.messages.get(messageId);
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

    const plan = [...byAccount.entries()].map(([accountId, entry]) => ({
      accountId,
      trashFolderId: entry.trashFolderId,
      messageIds: entry.messageIds,
    }));

    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.trash", plan };
    }

    for (const entry of byAccount.values()) {
      await B.messages.move(entry.messageIds, entry.trashFolderId);
    }

    return { ok: true, trashedCount: ids.length, messageIds: ids, plan };
  },

  // =========================
  // Compose + send methods
  // =========================

  async "compose.new"({
    to, cc, bcc, subject, body, plainTextBody, isPlainText,
    identityId, attachments, dryRun = false,
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

    if (dryRun) {
      return {
        ok: true, dryRun: true, method: "compose.new",
        details,
        attachmentCount: (attachments || []).length,
      };
    }

    const tab = await B.compose.beginNew(null, details);

    // Add attachments if provided.
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        // att: { name, contentBase64, contentType }
        const bytes = Uint8Array.from(atob(att.contentBase64), c => c.charCodeAt(0));
        const file = new File([bytes], att.name || "attachment", { type: att.contentType || "application/octet-stream" });
        await B.compose.addAttachment(tab.id, { file, name: att.name });
      }
    }

    // Send immediately.
    const sendResult = await B.compose.sendMessage(tab.id, { mode: "sendNow" });

    return {
      ok: true,
      method: "compose.new",
      tabId: tab.id,
      sendResult,
    };
  },

  async "compose.reply"({
    messageId, replyType = "replyToSender",
    body, plainTextBody, isPlainText,
    identityId, attachments, dryRun = false,
  } = {}) {
    if (!messageId) throw new Error("messageId is required");

    const details = {};
    if (isPlainText != null) details.isPlainText = isPlainText;
    if (body != null) details.body = body;
    if (plainTextBody != null) details.plainTextBody = plainTextBody;
    if (identityId) details.identityId = identityId;

    if (dryRun) {
      return {
        ok: true, dryRun: true, method: "compose.reply",
        messageId, replyType, details,
        attachmentCount: (attachments || []).length,
      };
    }

    const tab = await B.compose.beginReply(messageId, replyType, details);

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const bytes = Uint8Array.from(atob(att.contentBase64), c => c.charCodeAt(0));
        const file = new File([bytes], att.name || "attachment", { type: att.contentType || "application/octet-stream" });
        await B.compose.addAttachment(tab.id, { file, name: att.name });
      }
    }

    const sendResult = await B.compose.sendMessage(tab.id, { mode: "sendNow" });

    return {
      ok: true,
      method: "compose.reply",
      messageId,
      replyType,
      tabId: tab.id,
      sendResult,
    };
  },

  async "compose.forward"({
    messageId, forwardType = "forwardAsAttachment",
    to, cc, bcc, body, plainTextBody, isPlainText,
    identityId, attachments, dryRun = false,
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

    if (dryRun) {
      return {
        ok: true, dryRun: true, method: "compose.forward",
        messageId, forwardType, details,
        attachmentCount: (attachments || []).length,
      };
    }

    const tab = await B.compose.beginForward(messageId, forwardType, details);

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const bytes = Uint8Array.from(atob(att.contentBase64), c => c.charCodeAt(0));
        const file = new File([bytes], att.name || "attachment", { type: att.contentType || "application/octet-stream" });
        await B.compose.addAttachment(tab.id, { file, name: att.name });
      }
    }

    const sendResult = await B.compose.sendMessage(tab.id, { mode: "sendNow" });

    return {
      ok: true,
      method: "compose.forward",
      messageId,
      forwardType,
      tabId: tab.id,
      sendResult,
    };
  },

  async "messages.delete"({ messageIds, dryRun = false } = {}) {
    const ids = normalizeIdList(messageIds);

    if (dryRun) {
      return { ok: true, dryRun: true, method: "messages.delete", messageIds: ids, deletePermanently: true };
    }

    // Prefer the modern options object, fall back to the legacy boolean if needed.
    try {
      await B.messages.delete(ids, { deletePermanently: true, isUserAction: true });
    } catch (e) {
      await B.messages.delete(ids, true);
    }

    return { ok: true, deletedCount: ids.length, messageIds: ids, deletePermanently: true };
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

  port.postMessage({ type: "hello", id: nextId++, addonVersion: "0.2.0" });
  log("connected to native host", NATIVE_APP);
}

connectNative();
