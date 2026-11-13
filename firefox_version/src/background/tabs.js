import { createAbortError, sleep, throwIfAborted } from "../shared/async.js";
import { invalidateTabCache } from "./network.js";

export async function navigateAndWait(tabId, url, timeoutMs, signal, expectedHost) {
  throwIfAborted(signal);
  invalidateTabCache(tabId);

  const currentTab = await browser.tabs.get(tabId).catch(() => null);
  const currentUrl = currentTab?.url?.split("#")[0];
  const targetUrl = url.split("#")[0];

  const loadPromise = waitForTabLoad(tabId, timeoutMs, signal, expectedHost, false);
  if (currentUrl && currentUrl === targetUrl) {
    await browser.tabs.reload(tabId);
  } else {
    await browser.tabs.update(tabId, { url });
  }
  await loadPromise;
  invalidateTabCache(tabId);
}

export async function reloadAndWait(tabId, timeoutMs, signal, expectedHost) {
  throwIfAborted(signal);
  invalidateTabCache(tabId);
  const loadPromise = waitForTabLoad(tabId, timeoutMs, signal, expectedHost, false);
  await browser.tabs.reload(tabId);
  await loadPromise;
  invalidateTabCache(tabId);
}

export function waitForTabLoad(tabId, timeoutMs, signal, expectedHost = null, checkInitial = false) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const matchesLoadedTab = (tab) => {
      if (!tab || tab.status !== "complete") return false;
      if (!tab.url || tab.url === "about:blank") return false;
      if (expectedHost) {
        try {
          return new URL(tab.url).hostname === expectedHost;
        } catch {
          return false;
        }
      }
      return true;
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete" && matchesLoadedTab(tab)) {
        finish();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(new Error("Target tab was closed."));
      }
    };

    const onAbort = () => {
      finish(createAbortError(signal.reason));
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (checkInitial) {
      browser.tabs
        .get(tabId)
        .then((tab) => {
          if (matchesLoadedTab(tab)) finish();
        })
        .catch(() => {});
    }

    timer = setTimeout(() => {
      browser.tabs
        .get(tabId)
        .then((tab) => {
          if (tab && tab.url && tab.url !== "about:blank") finish();
          else finish(new Error(`Timed out waiting for tab ${tabId} to load.`));
        })
        .catch(() => finish(new Error(`Timed out waiting for tab ${tabId} to load.`)));
    }, timeoutMs);
  });
}

export function attachTabApiTracker(targetTabId) {
  const inFlight = new Set();
  let totalStarted = 0;
  let lastActivityAt = Date.now();
  let detached = false;

  const filter = { urls: ["*://*.qureo.education/api/*"], tabId: targetTabId };

  const onBeforeRequest = (details) => {
    totalStarted++;
    inFlight.add(details.requestId);
    lastActivityAt = Date.now();
  };

  const onDone = (details) => {
    inFlight.delete(details.requestId);
    lastActivityAt = Date.now();
  };

  browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter);
  browser.webRequest.onCompleted.addListener(onDone, filter);
  browser.webRequest.onErrorOccurred.addListener(onDone, filter);

  return {
    get totalStarted() {
      return totalStarted;
    },
    get inFlightCount() {
      return inFlight.size;
    },
    get lastActivityAt() {
      return lastActivityAt;
    },
    detach() {
      if (detached) return;
      detached = true;
      browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
      browser.webRequest.onCompleted.removeListener(onDone);
      browser.webRequest.onErrorOccurred.removeListener(onDone);
    }
  };
}

export async function waitForApiIdle(tracker, minWaitMs, maxWaitMs, signal) {
  const start = Date.now();
  const quietWindowMs = 450;

  while (true) {
    throwIfAborted(signal);
    const now = Date.now();
    const elapsed = now - start;

    if (elapsed >= maxWaitMs) return;

    if (elapsed >= minWaitMs && tracker.inFlightCount === 0) {
      if (tracker.totalStarted === 0 || now - tracker.lastActivityAt >= quietWindowMs) {
        return;
      }
    }

    await sleep(120, signal);
  }
}
