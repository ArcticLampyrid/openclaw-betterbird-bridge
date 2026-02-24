import { walkFolders } from "./utils.mjs";

function hasSpecialUse(folder, specialUse) {
  const uses = folder?.specialUse;
  return Array.isArray(uses) && uses.includes(specialUse);
}

export function createMailHelpers({ api }) {
  async function findSpecialFolderId({ accountId, specialUse, nameFallback = null }) {
    if (!accountId) return null;

    const account = await api("accounts", "get", accountId, true);
    for (const folder of walkFolders(account?.folders)) {
      if (hasSpecialUse(folder, specialUse)) return folder.id;
    }

    if (nameFallback) {
      const wantedName = String(nameFallback).toLowerCase();
      for (const folder of walkFolders(account?.folders)) {
        if (String(folder?.name || "").toLowerCase() === wantedName) {
          return folder.id;
        }
      }
    }

    return null;
  }

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

    for (const part of parts || []) {
      const contentType = (part.contentType || "").toLowerCase();
      if (!plain && contentType.startsWith("text/plain")) plain = part.content ?? null;
      if (!html && contentType.startsWith("text/html")) html = part.content ?? null;
    }

    if (!plain && html) {
      try {
        // TB 137+
        plain = await api("messengerUtilities", "convertToPlainText", html);
      } catch (_) {
        // optional API
      }
    }

    return { plain, html, parts };
  }

  return {
    extractInlineText,
    findSpecialFolderId,
  };
}
