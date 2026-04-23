import { createTopN, normalizeCount, walkFolders } from "../utils.mjs";

export function createReadHandlers({
  api,
  callAddon,
  extractInlineText,
  listLatestFromFolder,
  forEachPage,
}) {
  return {
    async ping(params) {
      let info = null;
      try {
        info = await api("runtime", "getBrowserInfo");
      } catch (_) {
        // optional during startup
      }
      return { ok: true, ts: Date.now(), params, browserInfo: info };
    },

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
      const targetCount = normalizeCount(count, 10);
      if (targetCount === 0) return [];
      return await listLatestFromFolder({ folderId, count: targetCount });
    },

    async "messages.latestAll"({ accountId, count = 10 } = {}) {
      const targetCount = normalizeCount(count, 10);
      if (targetCount === 0) return [];

      const accounts = await api("accounts", "list", true);
      const topN = createTopN(targetCount);

      for (const account of accounts || []) {
        if (accountId && account?.id !== accountId) continue;

        for (const folder of walkFolders(account?.folders)) {
          const folderId = folder?.id;
          if (!folderId) continue;

          const listResult = await api("messages", "list", folderId);
          await forEachPage(listResult, (messages) => topN.insert(messages));
        }
      }

      return topN.result();
    },

    async "messages.search"({ folderId, queryInfo = {}, count = 10 } = {}) {
      const targetCount = normalizeCount(count, 10);
      if (targetCount === 0) return [];

      const listResult = await api("messages", "query", { ...queryInfo, folderId });
      const topN = createTopN(targetCount);
      await forEachPage(listResult, (messages) => topN.insert(messages));
      return topN.result();
    },

    async "messages.unread"({ accountId, folderId, count = 25, markAsRead = false } = {}) {
      const targetCount = normalizeCount(count, 25);
      if (targetCount === 0) return [];

      const queryInfo = { unread: true };
      if (accountId) queryInfo.accountId = accountId;
      if (folderId) {
        queryInfo.folderId = folderId;
        queryInfo.includeSubFolders = true;
      }

      const listResult = await api("messages", "query", queryInfo);
      const topN = createTopN(targetCount);
      await forEachPage(listResult, (messages) => topN.insert(messages));
      const results = topN.result();

      if (markAsRead && results.length > 0) {
        for (const msg of results) {
          if (msg?.id != null) {
            await api("messages", "update", msg.id, { read: true });
          }
        }
      }

      return results;
    },

    async "messages.getRaw"({ messageId } = {}) {
      return await callAddon("binary.getRaw", { messageId });
    },

    async "attachments.get"({ messageId, partName } = {}) {
      return await callAddon("binary.getAttachment", { messageId, partName });
    },

    async "attachments.save"({ messageId, partName } = {}) {
      return await callAddon("binary.getAttachment", { messageId, partName });
    },
  };
}
