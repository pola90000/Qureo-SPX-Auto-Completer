import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/constants.js";

const STORAGE_FLUSH_INTERVAL_MS = 250;
const pendingWrites = new Map(); // tabId -> { timer, snapshot }

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored.settings || {}, DEFAULT_SETTINGS);
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = normalizeSettings(partial, current);
  await chrome.storage.local.set({ settings: next });
  await syncActionPopupMode(next.oneClickMode);
  return next;
}

export async function resetSettings() {
  const next = { ...DEFAULT_SETTINGS };
  await chrome.storage.local.set({ settings: next });
  await syncActionPopupMode(next.oneClickMode);
  return next;
}

export async function syncActionPopupMode(oneClickMode) {
  try {
    await chrome.action.setPopup({ popup: oneClickMode ? "" : "popup.html" });
  } catch (err) {
    console.warn("Could not update action popup mode:", err);
  }
}

export async function saveRunState(tabId, snapshot, immediate = false) {
  const existing = pendingWrites.get(tabId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  if (immediate) {
    pendingWrites.delete(tabId);
    await chrome.storage.local.set({ [`runState_${tabId}`]: snapshot }).catch(() => {});
    return;
  }

  const timer = setTimeout(() => {
    const entry = pendingWrites.get(tabId);
    pendingWrites.delete(tabId);
    if (entry?.snapshot) {
      chrome.storage.local.set({ [`runState_${tabId}`]: entry.snapshot }).catch(() => {});
    }
  }, STORAGE_FLUSH_INTERVAL_MS);

  pendingWrites.set(tabId, { timer, snapshot });
}

export async function removeRunState(tabId) {
  const existing = pendingWrites.get(tabId);
  if (existing?.timer) clearTimeout(existing.timer);
  pendingWrites.delete(tabId);
  await chrome.storage.local.remove(`runState_${tabId}`).catch(() => {});
}

export async function loadRunState(tabId, isTabRunning) {
  if (!tabId) return null;
  const key = `runState_${tabId}`;
  const stored = await chrome.storage.local.get(key);
  const runState = stored[key] || null;
  if (!runState) return null;

  if (!isTabRunning && (runState.status === "running" || runState.status === "stopping")) {
    const reconciled = {
      ...runState,
      status: "stopped",
      phase: "stopped",
      message: "Interrupted (extension reloaded or browser restarted).",
      updatedAt: Date.now()
    };
    await chrome.storage.local.set({ [key]: reconciled }).catch(() => {});
    return reconciled;
  }

  return runState;
}

export async function cleanupStaleRunStates() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("runState_"));
    if (keys.length === 0) return;

    const tabs = await chrome.tabs.query({});
    const openTabIds = new Set(tabs.map((t) => t.id));
    const toRemove = [];

    for (const key of keys) {
      const id = Number(key.slice("runState_".length));
      if (!openTabIds.has(id)) {
        toRemove.push(key);
      }
    }

    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
  } catch {
    // Ignore cleanup errors
  }
}
