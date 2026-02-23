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
  // markRead/markUnread are intentionally not included.
  "messages.move",
  "messages.archive",
  "messages.trash",
  "messages.delete",
]);

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
    }, 120_000);

    pending.set(id, { resolve, reject, timeout });
    send({ type: "request", id, method, params });
  });
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

async function assertFolderAllowlist({ messageIds, allowFolderIds }) {
  if (!allowFolderIds) return;
  if (!Array.isArray(allowFolderIds) || allowFolderIds.length === 0) {
    throw new Error("allowFolderIds must be a non-empty array when provided");
  }

  const allowSet = new Set(allowFolderIds);

  // Check each message's current folder is allowlisted.
  for (const messageId of messageIds) {
    const header = await callAddon("messages.get", { messageId });
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
  const dryRun = Boolean(p.dryRun);

  const messageIds = normalizeIdList(p.messageIds);
  if (messageIds.length === 0) {
    throw new Error("messageIds is required for write methods");
  }

  // Hard delete should always be explicitly enabled.
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

    // For moves, also require the destination folder to be allowlisted when allowFolderIds is provided.
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

  if (!cfg.writeEnabled && !dryRun) {
    throw new Error("Write methods are disabled (set write.enabled=true in config)");
  }

  return { dryRun, messageIds };
}

/**
 * Drain all pages from a messages.query result.
 * Thunderbird returns messages in ascending date order (oldest first).
 */
async function drainMessageList({ queryInfo }) {
  const queryResult = await callAddon("messages.query", { queryInfo });
  if (!queryResult) return [];

  const headers = [...(queryResult.messages || [])];
  const messageListId = queryResult.id;

  if (messageListId && headers.length > 0) {
    try {
      while (true) {
        const contResult = await callAddon("messages.continueList", { messageListId });
        if (!contResult || !contResult.messages || contResult.messages.length === 0) {
          break;
        }
        headers.push(...contResult.messages);
      }
    } catch (_) {
      // Thunderbird throws when the list is exhausted — that's fine.
    }

    try { await callAddon("messages.abortList", { messageListId }); } catch (_) { /* already done */ }
  } else if (messageListId) {
    try { await callAddon("messages.abortList", { messageListId }); } catch (_) { /* ok */ }
  }

  return headers;
}

/**
 * Drain all messages from a query, sort newest-first, return top N.
 * Used for search where we can't predict total count.
 */
async function queryLatest({ queryInfo, count }) {
  const headers = await drainMessageList({ queryInfo });
  headers.sort((a, b) => new Date(b.date) - new Date(a.date));
  return headers.slice(0, count);
}

/**
 * Get the latest N messages from a single folder efficiently.
 * Uses getFolderInfo to know the total, then skips early pages via messages.list pagination.
 */
async function listLatestFromFolder({ folderId, count, totalMessageCount = null }) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount === 0) return [];

  let total = totalMessageCount;
  if (total == null) {
    const info = await callAddon("folders.getFolderInfo", { folderId });
    total = Number(info?.totalMessageCount) || 0;
  }

  if (total <= 0) return [];

  const listResult = await callAddon("messages.list", { folderId });
  if (!listResult) return [];

  const firstPageMsgs = listResult.messages || [];
  const messageListId = listResult.id;

  // If everything fits in the first page, no pagination needed.
  if (!messageListId || firstPageMsgs.length === 0) {
    const headers = [...firstPageMsgs];
    headers.sort((a, b) => new Date(b.date) - new Date(a.date));
    return headers.slice(0, targetCount);
  }

  // Calculate how many pages to skip (page size = 100).
  // We want to keep roughly the last `targetCount` messages.
  const pagesToSkip = Math.max(0, Math.floor((total - targetCount) / 100));
  let page = 0; // page 0 = first page (already fetched)
  const headers = [];

  // Process first page
  if (page >= pagesToSkip) {
    headers.push(...firstPageMsgs);
  }

  // Paginate through the rest
  try {
    while (true) {
      page++;
      const contResult = await callAddon("messages.continueList", { messageListId });
      if (!contResult || !contResult.messages || contResult.messages.length === 0) {
        break;
      }
      if (page >= pagesToSkip) {
        headers.push(...contResult.messages);
      }
    }
  } catch (_) {
    // Thunderbird throws when the list is exhausted — that's fine.
  }

  try { await callAddon("messages.abortList", { messageListId }); } catch (_) { /* already done */ }

  headers.sort((a, b) => new Date(b.date) - new Date(a.date));
  return headers.slice(0, targetCount);
}

async function handleMessagesLatest({ folderId, count = 10 }) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount === 0) return [];
  return await listLatestFromFolder({ folderId, count: targetCount });
}

async function handleMessagesLatestAll({ accountId, count = 10 }) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount === 0) return [];
  const accounts = await callAddon("accounts.list", { includeSubFolders: true });
  const allHeaders = [];

  for (const acct of accounts || []) {
    if (accountId && acct?.id !== accountId) continue;

    for (const folder of walkFolders(acct?.folders)) {
      const folderId = folder?.id;
      if (!folderId) continue;

      const info = await callAddon("folders.getFolderInfo", { folderId });
      const total = Number(info?.totalMessageCount) || 0;
      if (total <= 0) continue;

      const headers = await listLatestFromFolder({
        folderId,
        count: targetCount,
        totalMessageCount: total,
      });
      allHeaders.push(...headers);
    }
  }

  allHeaders.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allHeaders.slice(0, targetCount);
}

async function handleMessagesSearch({ folderId, queryInfo = {}, count = 10 }) {
  const targetCount = Math.max(0, Number(count) || 0);
  if (targetCount === 0) return [];
  return await queryLatest({
    queryInfo: { ...queryInfo, folderId },
    count: targetCount,
  });
}

async function validateComposeCall(method, params) {
  const p = params && typeof params === "object" ? params : {};
  const dryRun = Boolean(p.dryRun);

  if (!cfg.composeEnabled && !dryRun) {
    throw new Error("Compose/send methods are disabled (set compose.enabled=true in config)");
  }

  // Basic sanity checks.
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

  return { dryRun };
}

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
  // Ensure every request has a correlation id for tracing.
  const correlationId = id ?? `auto-${crypto.randomUUID()}`;

  try {
    let result;

    if (method === "messages.latest") {
      result = await handleMessagesLatest(params);
    } else if (method === "messages.latestAll") {
      result = await handleMessagesLatestAll(params);
    } else if (method === "messages.search") {
      result = await handleMessagesSearch(params);
    } else {
      if (WRITE_METHODS.has(method)) {
        await validateWriteCall(method, params);
      }
      if (COMPOSE_METHODS.has(method)) {
        await validateComposeCall(method, params);
      }
      result = await callAddon(method, params);
    }

    return { id: correlationId, ok: true, result };
  } catch (e) {
    return { id: correlationId, ok: false, error: { message: e.message, method: method ?? null } };
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
