import { isSupportedUrl } from "../shared/constants.js";
import {
  createLinkedAbortSignal,
  extractApiError,
  isAbortError,
  safeParseJson,
  sleep,
  throwIfAborted
} from "../shared/async.js";

const TAB_CACHE_TTL_MS = 3_000;
const DNR_RULE_ID = 1001;

let dnrRefCount = 0;
let lastRuleKey = "";
const tabMetaCache = new Map();

export function invalidateTabCache(tabId) {
  tabMetaCache.delete(tabId);
}

export function clearCookieCache() {
  // No-op in Chrome (credentials: "include" uses Chrome's cookie store directly)
}

export function initNetworkListeners() {
  // No-op in Chrome; session rules are managed per run
}

async function applyHeaderRule(origin, referer) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const key = `${origin}|${referer}`;
  if (key === lastRuleKey) return;

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: origin },
            { header: "Referer", operation: "set", value: referer }
          ]
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          urlFilter: `${origin}/api/*`,
          resourceTypes: ["xmlhttprequest", "other"]
        }
      }
    ]
  });
  lastRuleKey = key;
}

export function retainWebRequestListener() {
  dnrRefCount++;
}

export function releaseWebRequestListener() {
  dnrRefCount = Math.max(0, dnrRefCount - 1);
  if (dnrRefCount === 0) {
    lastRuleKey = "";
    chrome.declarativeNetRequest
      ?.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] })
      .catch(() => {});
  }
}

async function getTabMetaCached(tabId) {
  const now = Date.now();
  const cached = tabMetaCache.get(tabId);
  if (cached && now - cached.updatedAt < TAB_CACHE_TTL_MS) {
    return cached;
  }
  const tab = await chrome.tabs.get(tabId);
  const meta = {
    url: tab.url,
    updatedAt: now
  };
  tabMetaCache.set(tabId, meta);
  return meta;
}

async function apiFetchRaw(origin, referer, url, fetchOptions, timeoutMs, signal) {
  throwIfAborted(signal);
  await applyHeaderRule(origin, referer);

  const { signal: reqSignal, cleanup } = createLinkedAbortSignal(signal, timeoutMs);
  try {
    return await fetch(url, {
      ...fetchOptions,
      credentials: "include",
      signal: reqSignal
    });
  } finally {
    cleanup();
  }
}

function computeBackoffMs(attempt, retryAfterHeader = null) {
  if (retryAfterHeader) {
    const secs = Number(retryAfterHeader);
    if (!Number.isNaN(secs) && secs > 0) {
      return Math.min(15000, Math.ceil(secs * 1000));
    }
  }
  const base = 700 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 300);
  return Math.min(10000, base + jitter);
}

export async function apiFetchWithRetry(run, url, fetchOptions = {}, retryConfig = {}) {
  const { settings, signal, tabId, log } = run;
  const maxRetries = retryConfig.maxRetries ?? settings.maxRetries;
  const tabMeta = await getTabMetaCached(tabId);
  const origin = new URL(url).origin;
  const referer =
    retryConfig.refererOverride ||
    (tabMeta.url && isSupportedUrl(tabMeta.url) ? tabMeta.url : `${origin}/`);

  let retriedAuthOnce = false;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(signal);

    try {
      const response = await apiFetchRaw(
        origin,
        referer,
        url,
        fetchOptions,
        settings.requestTimeoutMs,
        signal
      );

      if (response.status === 401 || response.status === 403) {
        if (!retriedAuthOnce) {
          retriedAuthOnce = true;
          invalidateTabCache(tabId);
          attempt--;
          continue;
        }
        throw new Error(`Authentication failed (HTTP ${response.status}). Please log in again.`);
      }

      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = response.headers?.get?.("Retry-After") || null;
        const backoffMs = computeBackoffMs(attempt, retryAfter);
        log?.("warn", `HTTP ${response.status} on ${new URL(url).pathname}, retrying in ${backoffMs}ms...`);
        await sleep(backoffMs, signal);
        continue;
      }

      return response;
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err;
      lastError = err;
      if (attempt < maxRetries) {
        const backoffMs = computeBackoffMs(attempt);
        log?.("warn", `Network error (${err.message}), retrying in ${backoffMs}ms...`);
        await sleep(backoffMs, signal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error("Request failed.");
}

export async function apiFetchJson(run, url, fetchOptions = {}, retryConfig = {}) {
  const response = await apiFetchWithRetry(run, url, fetchOptions, retryConfig);
  const json = await safeParseJson(response);

  if (!response.ok) {
    throw new Error(extractApiError(json, response.status));
  }
  if (json === null) {
    throw new Error(`Unexpected non-JSON response from ${new URL(url).pathname} (session may have expired).`);
  }
  return { response, json };
}
