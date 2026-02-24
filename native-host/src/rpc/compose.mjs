function normalizeRecipients(value) {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}

export function buildComposeDetails(params = {}, { includeRecipients = false } = {}) {
  const details = {};

  if (includeRecipients) {
    const to = normalizeRecipients(params.to);
    const cc = normalizeRecipients(params.cc);
    const bcc = normalizeRecipients(params.bcc);
    if (to) details.to = to;
    if (cc) details.cc = cc;
    if (bcc) details.bcc = bcc;
  }

  if (params.subject != null) details.subject = params.subject;
  if (params.isPlainText != null) details.isPlainText = params.isPlainText;
  if (params.body != null) details.body = params.body;
  if (params.plainTextBody != null) details.plainTextBody = params.plainTextBody;
  if (params.identityId) details.identityId = params.identityId;

  return details;
}

export function createComposeHelpers({ api, callAddon }) {
  async function addAttachments(tabId, attachments) {
    if (!attachments?.length) return;

    for (const attachment of attachments) {
      await callAddon("compose.addAttachment", {
        tabId,
        name: attachment.name,
        contentBase64: attachment.contentBase64,
        contentType: attachment.contentType,
      });
    }
  }

  async function sendCompose(tab, attachments) {
    await addAttachments(tab.id, attachments);
    return await api("compose", "sendMessage", tab.id, { mode: "sendNow" });
  }

  return {
    sendCompose,
  };
}
