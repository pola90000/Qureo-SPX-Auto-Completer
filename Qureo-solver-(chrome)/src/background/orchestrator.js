import { parsePageContext } from "../shared/constants.js";
import { isAbortError } from "../shared/async.js";
import { renderHud, setBadge } from "./hud.js";
import { releaseWebRequestListener, retainWebRequestListener } from "./network.js";
import { getSettings, loadRunState, saveRunState } from "./storage.js";
import { executeQureoWorkflow } from "./workflows/qureo.js";
import { executeSpxWorkflow } from "./workflows/spx.js";

const activeRuns = new Map();
const HUD_MIN_INTERVAL_MS = 100;

export function hasActiveRun(tabId) {
  return activeRuns.has(tabId);
}

export function getActiveRunState(tabId) {
  return activeRuns.get(tabId)?.state || null;
}

export function broadcastState(tabId, state) {
  chrome.runtime.sendMessage({ type: "RUN_STATE_UPDATED", tabId, state }).catch(() => {});
}

function appendLog(run, level, text) {
  const entry = {
    time: new Date().toLocaleTimeString([], { hour12: false }),
    level,
    text
  };
  run.state.logs.push(entry);
  if (run.state.logs.length > 60) {
    run.state.logs = run.state.logs.slice(-60);
  }
}

async function publishRunState(run, immediate = false) {
  const { tabId, state, settings } = run;
  state.updatedAt = Date.now();
  const isTerminal =
    state.status === "completed" || state.status === "error" || state.status === "stopped";
  const snapshot = { ...state, stats: { ...state.stats }, logs: [...state.logs] };

  await saveRunState(tabId, snapshot, immediate || isTerminal);
  broadcastState(tabId, snapshot);

  if (settings.showHud) {
    const now = Date.now();
    if (!immediate && !isTerminal && now - run.lastHudAt < HUD_MIN_INTERVAL_MS) {
      return;
    }
    run.lastHudAt = now;

    const hudTitle = state.site === "spx" ? "SPX Auto" : "Qureo Auto";
    const idLabel =
      state.site === "spx"
        ? state.subjectId
          ? `Subj.${state.subjectId}`
          : ""
        : state.chapterId
          ? `Ch.${state.chapterId}`
          : "";

    await renderHud(tabId, {
      title: hudTitle,
      status: snapshot.status,
      phase: snapshot.phase,
      idLabel,
      message: snapshot.message,
      current: snapshot.current,
      total: snapshot.total,
      doneBadge:
        state.site === "spx"
          ? snapshot.stats.lecturesCompleted +
            snapshot.stats.questionsSubmitted +
            snapshot.stats.chaptersCompleted
          : snapshot.stats.chaptersCompleted
    });
  }
}

export async function startRun(tabId, options = {}) {
  if (activeRuns.has(tabId)) {
    return { ok: false, error: "Automation is already running on this tab." };
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const context = parsePageContext(tab?.url || "");
  if (!tab || !context.isSupported) {
    return { ok: false, error: "Please open a qureo.education or spx-learning-square.com page first." };
  }

  const settings = await getSettings();
  const controller = new AbortController();

  const state = {
    status: "running",
    site: context.site,
    mode: options.mode || "full",
    phase: "init",
    origin: context.origin,
    chapterId: options.chapterIdOverride || context.chapterId || null,
    subjectId: options.subjectIdOverride || context.subjectId || null,
    message: "Initializing automation...",
    current: 0,
    total: 0,
    stats: {
      lecturesCompleted: 0,
      lecturesSkipped: 0,
      lecturesFailed: 0,
      questionsExtracted: 0,
      questionsSubmitted: 0,
      chaptersCompleted: 0
    },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    logs: []
  };

  const run = {
    tabId,
    controller,
    signal: controller.signal,
    settings,
    state,
    lastHudAt: 0,
    spawnedTabIds: new Set(),
    log: (level, text) => appendLog(run, level, text),
    publish: (immediate = false) => publishRunState(run, immediate),
    setBadge: (text, color) => setBadge(tabId, text, color),
    finishSuccess: async (summaryMessage) => {
      state.status = "completed";
      state.phase = "completed";
      state.message = summaryMessage;
      appendLog(run, "success", summaryMessage);
      await setBadge(tabId, "OK", "#10b981");
      await publishRunState(run, true);
    },
    handleError: async (err) => {
      if (isAbortError(err) || controller.signal.aborted) {
        state.status = "stopped";
        state.phase = "stopped";
        state.message = err?.message || "Stopped by user.";
        await setBadge(tabId, "", "#64748b");
        await publishRunState(run, true);
        return;
      }

      state.status = "error";
      state.phase = "error";
      state.message = err?.message || "Unexpected automation error.";
      appendLog(run, "error", state.message);
      await setBadge(tabId, "ERR", "#ef4444");
      await publishRunState(run, true);
    }
  };

  activeRuns.set(tabId, run);
  retainWebRequestListener();

  const runner =
    context.site === "spx"
      ? executeSpxWorkflow(run, context, options)
      : executeQureoWorkflow(run, context, options);

  runner
    .catch((err) => {
      if (!isAbortError(err)) {
        console.error("Unhandled workflow error:", err);
      }
    })
    .finally(() => {
      activeRuns.delete(tabId);
      releaseWebRequestListener();
      for (const spawnedId of run.spawnedTabIds) {
        chrome.tabs.remove(spawnedId).catch(() => {});
      }
      run.spawnedTabIds.clear();
    });

  return { ok: true };
}

export function stopRun(tabId, reason = "Stopped by user.") {
  const run = activeRuns.get(tabId);
  if (!run) return;
  if (!run.controller.signal.aborted) {
    run.state.status = "stopping";
    run.state.message = reason;
    appendLog(run, "warn", reason);
    run.controller.abort(new Error(reason));
  }
}

export async function clearRunLogs(tabId) {
  if (!tabId) return false;
  const active = activeRuns.get(tabId);
  if (active) {
    active.state.logs = [];
    await publishRunState(active, true);
    return true;
  }

  const stored = await loadRunState(tabId, false);
  if (stored) {
    stored.logs = [];
    await saveRunState(tabId, stored, true);
    broadcastState(tabId, stored);
  }
  return true;
}
