const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_QUEUE = 100;

function clampTimeout(value) {
  const n = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

function asPlainHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};

  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key || value == null) continue;
    result[String(key)] = String(value);
  }
  return result;
}

function compilePayloadScript(script) {
  if (script == null || script === "") return null;
  if (typeof script !== "string") {
    throw new Error("webhooks.newMail.payloadScript must be a JavaScript string");
  }

  // The config file is local/trusted. Use a function body so users can write
  // normal JavaScript and `return` any JSON-serializable webhook body.
  return new Function("event", `"use strict";\n${script}`);
}

function normalizeNewMailWebhook(cfg = {}) {
  const explicit = cfg.webhooks?.newMail ?? null;
  if (!explicit) return null;

  if (typeof explicit !== "object" || Array.isArray(explicit)) {
    throw new Error("webhooks.newMail must be an object");
  }
  if (explicit.enabled === false) return null;
  if (!explicit.url) return null;

  return {
    enabled: true,
    url: String(explicit.url),
    headers: asPlainHeaders(explicit.headers),
    timeoutMs: clampTimeout(explicit.timeoutMs),
    buildPayload: compilePayloadScript(explicit.payloadScript),
  };
}

function buildWebhookPayload(config, event) {
  if (!config.buildPayload) return event?.payload;

  const result = config.buildPayload(event);
  if (result == null) {
    throw new Error("webhooks.newMail.payloadScript returned null or undefined");
  }
  return result;
}

async function postJson({ url, headers, timeoutMs, payload }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "openclaw-betterbird-bridge",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch (_) {
        // ignore body read failures
      }
      throw new Error(`Webhook POST failed: HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    }

    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

export function createWebhookDispatcher({ cfg, onError = null } = {}) {
  const newMailWebhook = normalizeNewMailWebhook(cfg);
  const queue = [];
  let draining = false;
  let delivered = 0;
  let failed = 0;
  let dropped = 0;
  let lastError = null;

  function recordFailure(err) {
    failed += 1;
    lastError = {
      message: err?.message || String(err),
      at: new Date().toISOString(),
    };
    onError?.(err);
  }

  async function drain() {
    if (draining) return;
    draining = true;

    try {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await postJson(item);
          delivered += 1;
        } catch (err) {
          recordFailure(err);
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(config, payload) {
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      dropped += 1;
    }

    queue.push({
      url: config.url,
      headers: config.headers,
      timeoutMs: config.timeoutMs,
      payload,
    });

    void drain();
  }

  function handleEvent(event) {
    if (!event || event.name !== "messages.newMail") return false;
    if (!newMailWebhook) return false;

    try {
      enqueue(newMailWebhook, buildWebhookPayload(newMailWebhook, event));
      return true;
    } catch (err) {
      recordFailure(err);
      return false;
    }
  }

  function status() {
    return {
      newMail: {
        enabled: Boolean(newMailWebhook),
        url: newMailWebhook?.url || null,
        customPayload: Boolean(newMailWebhook?.buildPayload),
      },
      queue: queue.length,
      delivered,
      failed,
      dropped,
      lastError,
    };
  }

  return { handleEvent, status };
}
