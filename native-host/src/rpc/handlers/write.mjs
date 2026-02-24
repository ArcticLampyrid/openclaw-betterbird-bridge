import { normalizeIdList } from "../utils.mjs";

export function createWriteHandlers({ api, findSpecialFolderId }) {
  return {
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
  };
}
