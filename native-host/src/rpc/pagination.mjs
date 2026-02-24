import { createTopN, normalizeCount } from "./utils.mjs";

export function createPaginationHelpers({ api, supportsListSortOptions }) {
  /**
   * Iterate all pages from a MessageList result, calling `visitor`
   * for each batch of messages. Handles continueList/abortList.
   *
   * `visitor` may return `false` to stop paging early.
   */
  async function forEachPage(listResult, visitor) {
    if (!listResult) return;

    const firstPage = listResult.messages || [];
    const messageListId = listResult.id;

    let shouldContinue = true;
    if (firstPage.length > 0) {
      shouldContinue = visitor(firstPage) !== false;
    }

    if (messageListId) {
      if (firstPage.length > 0 && shouldContinue) {
        try {
          while (true) {
            const contResult = await api("messages", "continueList", messageListId);
            const messages = contResult?.messages;
            if (!messages?.length) break;

            if (visitor(messages) === false) break;
          }
        } catch (_) {
          // Thunderbird throws when the list is exhausted — that's fine.
        }
      }

      try {
        await api("messages", "abortList", messageListId);
      } catch (_) {
        // already done
      }
    }
  }

  /**
   * Collect up to `count` messages from a pre-sorted MessageList.
   * Stops reading pages once enough messages are collected.
   */
  async function collectFromList(listResult, count) {
    const targetCount = normalizeCount(count);
    if (targetCount === 0) return [];

    const headers = [];
    await forEachPage(listResult, (messages) => {
      headers.push(...messages.slice(0, targetCount - headers.length));
      return headers.length < targetCount;
    });

    return headers;
  }

  /**
   * Get the latest N messages from a single folder.
   * On TB 148+: uses sorted list (fast, early termination).
   * On older versions: iterates all pages with a top-N min-heap.
   */
  async function listLatestFromFolder({ folderId, count }) {
    const targetCount = normalizeCount(count);
    if (targetCount === 0) return [];

    if (await supportsListSortOptions()) {
      const listResult = await api("messages", "list", folderId, {
        sortType: "date",
        sortOrder: "descending",
      });
      return await collectFromList(listResult, targetCount);
    }

    const listResult = await api("messages", "list", folderId);
    const topN = createTopN(targetCount);
    await forEachPage(listResult, (messages) => topN.insert(messages));
    return topN.result();
  }

  return {
    forEachPage,
    collectFromList,
    listLatestFromFolder,
  };
}
