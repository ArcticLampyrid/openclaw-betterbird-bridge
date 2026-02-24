export function normalizeIdList(maybeIds) {
  if (!maybeIds) return [];
  if (Array.isArray(maybeIds)) return maybeIds;
  return [maybeIds];
}

export function normalizeCount(value, fallback = 0) {
  return Math.max(0, Number(value ?? fallback) || 0);
}

export function* walkFolders(folders) {
  for (const folder of folders || []) {
    yield folder;
    if (folder?.subFolders?.length) {
      yield* walkFolders(folder.subFolders);
    }
  }
}

/**
 * Maintain a top-N set (by date descending) while iterating pages.
 * Only keeps the newest `count` messages in memory at any time.
 */
export function createTopN(count) {
  const heap = [];

  function pushHeap(entry) {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].ts <= heap[i].ts) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function replaceTop(entry) {
    heap[0] = entry;
    let i = 0;

    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (left < heap.length && heap[left].ts < heap[smallest].ts) smallest = left;
      if (right < heap.length && heap[right].ts < heap[smallest].ts) smallest = right;
      if (smallest === i) break;

      [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
      i = smallest;
    }
  }

  function insert(msgs) {
    for (const msg of msgs || []) {
      const ts = new Date(msg?.date).getTime();
      if (!Number.isFinite(ts)) continue;

      const entry = { ts, msg };
      if (heap.length < count) {
        pushHeap(entry);
      } else if (count > 0 && ts > heap[0].ts) {
        replaceTop(entry);
      }
    }
  }

  function result() {
    return heap
      .sort((a, b) => b.ts - a.ts)
      .map((entry) => entry.msg);
  }

  return { insert, result };
}
