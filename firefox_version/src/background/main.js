import {
  ALL_ORIGIN_PATTERNS,
  getSiteHostPattern,
  isSupportedUrl,
  parsePageContext
} from "../shared/constants.js";
import { renderHud } from "./hud.js";
import { initNetworkListeners, invalidateTabCache } from "./network.js";
import {
  clearRunLogs,
  getActiveRunState,
  hasActiveRun,
  startRun,
  stopRun
} from "./orchestrator.js";
import {
  cleanupStaleRunStates,
  getSettings,
  loadRunState,
  removeRunState,
  resetSettings,
  saveSettings,
  syncActionPopupMode
} from "./storage.js";

initNetworkListeners();

async function initializeExtension() {
  const settings = await getSettings();
  await syncActionPopupMode(settings.oneClickMode);
  await cleanupStaleRunStates();
}

browser.runtime.onInstalled.addListener(initializeExtension);
browser.runtime.onStartup.addListener(initializeExtension);
initializeExtension().catch(() => {});

async function ensureHostPermissionInteractive(origins = ALL_ORIGIN_PATTERNS) {
  const has = await browser.permissions.contains({ origins });
  if (has) return true;
  try {
    return await browser.permissions.request({ origins });
  } catch {
    return false;
  }
}

browser.action.onClicked.addListener(async (tab) => {
  const ctx = parsePageContext(tab?.url || "");
  const requiredOrigins = ctx.site ? [getSiteHostPattern(ctx.site)] : ALL_ORIGIN_PATTERNS;
  const hasPerm = await ensureHostPermissionInteractive(requiredOrigins);
  if (!hasPerm) return;

  if (!tab?.id || !ctx.isSupported) {
    await browser.tabs.create({
      url: browser.runtime.getURL(`popup.html${tab?.id ? `?tabId=${tab.id}` : ""}`)
    });
    return;
  }

  if (hasActiveRun(tab.id)) {
    stopRun(tab.id, "Stopped by user.");
    return;
  }

  if (ctx.site === "qureo") {
    if (ctx.isTestView) {
      startRun(tab.id, { mode: "review" }).catch(() => {});
    } else if (ctx.chapterId) {
      startRun(tab.id, { mode: "full" }).catch(() => {});
    } else {
      await browser.tabs.create({
        url: browser.runtime.getURL(`popup.html?tabId=${tab.id}`)
      });
    }
  } else if (ctx.site === "spx") {
    if (ctx.subjectId) {
      startRun(tab.id, { mode: "full" }).catch(() => {});
    } else {
      await browser.tabs.create({
        url: browser.runtime.getURL(`popup.html?tabId=${tab.id}`)
      });
    }
  }
});

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "run-full-automation") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (hasActiveRun(tab.id)) {
    stopRun(tab.id, "Stopped via keyboard shortcut.");
    return;
  }

  const ctx = parsePageContext(tab.url);
  if (!ctx.isSupported) return;

  const hasPerm = await browser.permissions.contains({ origins: [getSiteHostPattern(ctx.site)] });
  if (!hasPerm) {
    await renderHud(tab.id, {
      status: "error",
      phase: "Permission",
      message: "Site access permission is required. Click the extension icon to grant access.",
      current: 0,
      total: 0
    });
    return;
  }

  if (ctx.site === "qureo" && ctx.chapterId) {
    const mode = ctx.isTestView ? "review" : "full";
    startRun(tab.id, { mode }).catch(() => {});
  } else if (ctx.site === "spx" && ctx.subjectId) {
    startRun(tab.id, { mode: "full" }).catch(() => {});
  }
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  invalidateTabCache(tabId);
  if (hasActiveRun(tabId)) {
    stopRun(tabId, "Target tab was closed.");
  }
  await removeRunState(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    invalidateTabCache(tabId);
    if (hasActiveRun(tabId) && !isSupportedUrl(changeInfo.url)) {
      stopRun(tabId, "Navigated away from supported site.");
    }
  }
});

browser.runtime.onMessage.addListener((msg, sender) => {
  return (async () => {
    switch (msg?.type) {
      case "GET_TAB_STATUS": {
        const tabId = msg.tabId;
        const tab = tabId ? await browser.tabs.get(tabId).catch(() => null) : null;
        const context = tab?.url ? parsePageContext(tab.url) : parsePageContext("");
        const requiredOrigins = context.site
          ? [getSiteHostPattern(context.site)]
          : ALL_ORIGIN_PATTERNS;
        const hasHostPermission = await browser.permissions.contains({
          origins: requiredOrigins
        });
        const settings = await getSettings();
        const isRunning = hasActiveRun(tabId);
        const runState = isRunning
          ? getActiveRunState(tabId)
          : await loadRunState(tabId, false);
        return { context, hasHostPermission, runState, settings };
      }

      case "START_RUN": {
        const { tabId, mode, fullChapterFromLecture, chapterIdOverride, subjectIdOverride } = msg;
        if (!tabId) return { ok: false, error: "No target tab found." };
        const tab = await browser.tabs.get(tabId).catch(() => null);
        const context = parsePageContext(tab?.url || "");
        if (!context.isSupported) {
          return { ok: false, error: "Open a qureo.education or spx-learning-square.com page first." };
        }
        const hasHostPermission = await browser.permissions.contains({
          origins: [getSiteHostPattern(context.site)]
        });
        if (!hasHostPermission) {
          return { ok: false, error: `Missing host permission for ${context.hostname}.` };
        }
        return await startRun(tabId, {
          mode: mode || "full",
          fullChapterFromLecture: Boolean(fullChapterFromLecture),
          chapterIdOverride: chapterIdOverride ? String(chapterIdOverride) : null,
          subjectIdOverride: subjectIdOverride ? String(subjectIdOverride) : null
        });
      }

      case "STOP_RUN": {
        if (!msg.tabId) return { ok: false };
        stopRun(msg.tabId, "Stopped by user.");
        return { ok: true };
      }

      case "STOP_RUN_FROM_TAB": {
        const tabId = sender?.tab?.id;
        if (tabId) stopRun(tabId, "Stopped from in-page HUD.");
        return { ok: true };
      }

      case "OPEN_SETTINGS_TAB": {
        const tabId = sender?.tab?.id;
        await browser.tabs.create({
          url: browser.runtime.getURL(`popup.html${tabId ? `?tabId=${tabId}` : ""}`)
        });
        return { ok: true };
      }

      case "NAVIGATE_TO_TARGET":
      case "NAVIGATE_TO_CHAPTER": {
        const { tabId, origin, site, targetId, chapterId } = msg;
        const id = targetId || chapterId;
        if (!tabId || !origin || !id) return { ok: false, error: "Invalid navigation target." };
        const url =
          site === "spx" ? `${origin}/subjects/${id}/curriculum` : `${origin}/chapter/${id}`;
        await browser.tabs.update(tabId, { url });
        return { ok: true };
      }

      case "CLEAR_LOG": {
        await clearRunLogs(msg.tabId);
        return { ok: true };
      }

      case "SAVE_SETTINGS": {
        const settings = await saveSettings(msg.settings || {});
        return { ok: true, settings };
      }

      case "RESET_SETTINGS": {
        const settings = await resetSettings();
        return { ok: true, settings };
      }

      default:
        return { ok: false, error: "Unknown message type." };
    }
  })();
});
