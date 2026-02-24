import { buildComposeDetails } from "../compose.mjs";

export function createComposeHandlers({ api, sendCompose }) {
  return {
    async "compose.new"(params = {}) {
      const details = buildComposeDetails(params, { includeRecipients: true });
      const tab = await api("compose", "beginNew", null, details);
      const sendResult = await sendCompose(tab, params.attachments);
      return { ok: true, method: "compose.new", tabId: tab.id, sendResult };
    },

    async "compose.reply"(params = {}) {
      const {
        messageId,
        replyType = "replyToSender",
      } = params;

      if (!messageId) throw new Error("messageId is required");

      const details = buildComposeDetails(params, { includeRecipients: false });
      const tab = await api("compose", "beginReply", messageId, replyType, details);
      const sendResult = await sendCompose(tab, params.attachments);

      return {
        ok: true,
        method: "compose.reply",
        messageId,
        replyType,
        tabId: tab.id,
        sendResult,
      };
    },

    async "compose.forward"(params = {}) {
      const {
        messageId,
        forwardType = "forwardAsAttachment",
      } = params;

      if (!messageId) throw new Error("messageId is required");

      const details = buildComposeDetails(params, { includeRecipients: true });
      const tab = await api("compose", "beginForward", messageId, forwardType, details);
      const sendResult = await sendCompose(tab, params.attachments);

      return {
        ok: true,
        method: "compose.forward",
        messageId,
        forwardType,
        tabId: tab.id,
        sendResult,
      };
    },
  };
}
