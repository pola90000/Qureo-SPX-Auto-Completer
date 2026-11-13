import { isSupportedUrl } from "../shared/constants.js";
import {
  createLinkedAbortSignal,
  extractApiError,
  isAbortError,
  safeParseJson,
  sleep,
  throwIfAborted
} from "../shared/async.js";

const REQ_ID_HEADER = "X-Ext-Req-Id";
const COOKIE_CACHE_TTL_MS = 30_000;
const TAB_CACHE_TTL_MS = 3_000;

let extOrigin = "";
try {
  extOrigin = browser.runtime.getURL("").replace(/\/$/, "");
} catch {
  // In non-extension test environments, caller/mock can ignore
}

let webRequestRefCount = 0;
let reqSeq = 0;
const headerContextByReqId = new Map();
const cookieCache = new Map();
const tabMetaCache = new Map();

export function invalidateTabCache(tabId) {
  tabMetaCache.delete(tabId);
}

export function clearCookieCache() {
  cookieCache.clear();
}

export function initNetworkListeners() {
  if (typeof browser !== "undefined" && browser.cookies?.onChanged) {
    browser.cookies.onChanged.addListener((changeInfo) => {
      const domain = changeInfo?.cookie?.domain || "";
      if (domain.includes("qureo.education") || domain.includes("spx-learning-square.com")) {
        cookieCache.clear();
      }
    });
  }
}

export function onBeforeSendHeadersHandler(details) {
  if (details.tabId !== -1) return;
  if (extOrigin && details.originUrl && !details.originUrl.startsWith(extOrigin)) return;

  const headers = details.requestHeaders || [];
  let reqId = null;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].name.toLowerCase() === "x-ext-req-id") {
      reqId = headers[i].value;
      break;
    }
  }
  if (!reqId) return;

  const ctx = headerContextByReqId.get(reqId);
  if (!ctx) return;
  if (!details.url.startsWith(ctx.origin + "/")) return;

  const filtered = headers.filter((h) => {
    const lower = h.name.toLowerCase();
    return (
      lower !== "x-ext-req-id" &&
      lower !== "cookie" &&
      lower !== "referer" &&
      lower !== "origin"
    );
  });

  if (ctx.cookieHeader) {
    filtered.push({ name: "Cookie", value: ctx.cookieHeader });
  }
  filtered.push({ name: "Referer", value: ctx.referer });
  filtered.push({ name: "Origin", value: ctx.origin });

  return { requestHeaders: filtered };
}

export function retainWebRequestListener() {
  if (webRequestRefCount === 0) {
    browser.webRequest.onBeforeSendHeaders.addListener(
      onBeforeSendHeadersHandler,
      {
        urls: [
          "*://*.qureo.education/api/*",
          "*://*.spx-learning-square.com/api/*"
        ]
      },
      ["blocking", "requestHeaders"]
    );
  }
  webRequestRefCount++;
}

export function releaseWebRequestListener() {
  webRequestRefCount = Math.max(0, webRequestRefCount - 1);
  if (webRequestRefCount === 0) {
    headerContextByReqId.clear();
    if (browser.webRequest.onBeforeSendHeaders.hasListener(onBeforeSendHeadersHandler)) {
      browser.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeadersHandler);
    }
  }
}

async function getTabMetaCached(tabId) {
  const now = Date.now();
  const cached = tabMetaCache.get(tabId);
  if (cached && now - cached.updatedAt < TAB_CACHE_TTL_MS) {
    return cached;
  }
  const tab = await browser.tabs.get(tabId);
  const meta = {
    cookieStoreId: tab.cookieStoreId,
    url: tab.url,
    updatedAt: now
  };
  tabMetaCache.set(tabId, meta);
  return meta;
}

export async function getCookieHeader(origin, cookieStoreId, forceRefresh = false) {
  const cacheKey = `${origin}|${cookieStoreId || "default"}`;
  const now = Date.now();

  if (!forceRefresh) {
    const cached = cookieCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.value;
    }
  }

  const baseQuery = { url: origin };
  if (cookieStoreId) baseQuery.storeId = cookieStoreId;

  let cookies = [];
  try {
    cookies = await browser.cookies.getAll({ ...baseQuery, partitionKey: {} });
  } catch {
    cookies = await browser.cookies.getAll(baseQuery);
  }

  if (cookies.length === 0) {
    try {
      cookies = await browser.cookies.getAll({ ...baseQuery, firstPartyDomain: null });
    } catch {
      // Ignore if firstPartyDomain isn't applicable
    }
  }

  const seen = new Map();
  for (const c of cookies) {
    if (!seen.has(c.name)) {
      seen.set(c.name, c.value);
    }
  }

  const headerValue = Array.from(seen.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  cookieCache.set(cacheKey, {
    value: headerValue,
    expiresAt: now + COOKIE_CACHE_TTL_MS
  });

  return headerValue;
}

async function apiFetchRaw(headerCtx, url, fetchOptions, timeoutMs, signal) {
  throwIfAborted(signal);
  const reqId = `${++reqSeq}-${Math.random().toString(36).slice(2, 10)}`;
  const { signal: reqSignal, cleanup } = createLinkedAbortSignal(signal, timeoutMs);

  const mergedHeaders = {
    ...(fetchOptions.headers || {}),
    [REQ_ID_HEADER]: reqId
  };

  headerContextByReqId.set(reqId, headerCtx);
  try {
    return await fetch(url, {
      ...fetchOptions,
      headers: mergedHeaders,
      signal: reqSignal
    });
  } finally {
    cleanup();
    headerContextByReqId.delete(reqId);
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

  let forceCookieRefresh = false;
  let refreshedAuthOnce = false;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(signal);

    const cookieHeader = await getCookieHeader(origin, tabMeta.cookieStoreId, forceCookieRefresh);
    forceCookieRefresh = false;

    const headerCtx = {
      origin,
      referer:
        retryConfig.refererOverride ||
        (tabMeta.url && isSupportedUrl(tabMeta.url) ? tabMeta.url : `${origin}/`),
      cookieHeader
    };

    try {
      const response = await apiFetchRaw(
        headerCtx,
        url,
        fetchOptions,
        settings.requestTimeoutMs,
        signal
      );

      if (response.status === 401 || response.status === 403) {
        if (!refreshedAuthOnce) {
          refreshedAuthOnce = true;
          forceCookieRefresh = true;
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
