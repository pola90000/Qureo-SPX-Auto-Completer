import {
  ALL_ORIGIN_PATTERNS,
  QUREO_ORIGIN_PATTERN,
  SPX_ORIGIN_PATTERN
} from "./src/shared/constants.js";

let targetTab = null;
let currentContext = null;
let currentRunState = null;
let elapsedTimer = null;
let renderedLogsSnapshot = [];

const el = {
  permissionBanner: document.getElementById("permissionBanner"),
  grantPermissionBtn: document.getElementById("grantPermissionBtn"),
  contextDot: document.getElementById("contextDot"),
  contextTitle: document.getElementById("contextTitle"),
  contextSubtitle: document.getElementById("contextSubtitle"),
  chapterJumpInput: document.getElementById("chapterJumpInput"),
  chapterJumpBtn: document.getElementById("chapterJumpBtn"),
  chapterJumpRunBtn: document.getElementById("chapterJumpRunBtn"),
  lectureChoiceBanner: document.getElementById("lectureChoiceBanner"),
  runFullBtn: document.getElementById("runFullBtn"),
  runFullChapterBtn: document.getElementById("runFullChapterBtn"),
  runLecturesBtn: document.getElementById("runLecturesBtn"),
  runReviewBtn: document.getElementById("runReviewBtn"),
  stopBtn: document.getElementById("stopBtn"),
  progressCard: document.getElementById("progressCard"),
  statusBadge: document.getElementById("statusBadge"),
  phaseText: document.getElementById("phaseText"),
  elapsedText: document.getElementById("elapsedText"),
  progressMessage: document.getElementById("progressMessage"),
  progressBarFill: document.getElementById("progressBarFill"),
  progressCountText: document.getElementById("progressCountText"),
  statLectures: document.getElementById("statLectures"),
  statSkipped: document.getElementById("statSkipped"),
  statAnswers: document.getElementById("statAnswers"),
  statChapters: document.getElementById("statChapters"),
  statLbl1: document.getElementById("statLbl1"),
  statLbl2: document.getElementById("statLbl2"),
  statLbl3: document.getElementById("statLbl3"),
  statLbl4: document.getElementById("statLbl4"),
  tabLogBtn: document.getElementById("tabLogBtn"),
  tabSettingsBtn: document.getElementById("tabSettingsBtn"),
  logPanel: document.getElementById("logPanel"),
  settingsPanel: document.getElementById("settingsPanel"),
  logContainer: document.getElementById("logContainer"),
  copyLogBtn: document.getElementById("copyLogBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  optAutoAdvance: document.getElementById("optAutoAdvance"),
  optAutoChain: document.getElementById("optAutoChain"),
  optMaxChainChapters: document.getElementById("optMaxChainChapters"),
  optSmartSkip: document.getElementById("optSmartSkip"),
  optFocusOn404: document.getElementById("optFocusOn404"),
  optShowHud: document.getElementById("optShowHud"),
  optOneClickMode: document.getElementById("optOneClickMode"),
  optLectureLoadWait: document.getElementById("optLectureLoadWait"),
  optTabSettleDelay: document.getElementById("optTabSettleDelay"),
  optApiDelay: document.getElementById("optApiDelay"),
  optConcurrency: document.getElementById("optConcurrency"),
  resetSettingsBtn: document.getElementById("resetSettingsBtn")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  targetTab = await resolveTargetTab();
  await refreshAll();
}

async function resolveTargetTab() {
  const params = new URLSearchParams(window.location.search);
  const paramTabId = Number(params.get("tabId"));
  if (Number.isInteger(paramTabId) && paramTabId > 0) {
    try {
      return await browser.tabs.get(paramTabId);
    } catch {
      // Fallback below
    }
  }

  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const extPrefix = browser.runtime.getURL("");
  if (activeTab && !activeTab.url?.startsWith(extPrefix)) {
    return activeTab;
  }

  const supportedTabs = await browser.tabs.query({ url: ALL_ORIGIN_PATTERNS });
  return supportedTabs[0] || activeTab || null;
}

async function refreshAll() {
  const resp = await browser.runtime.sendMessage({
    type: "GET_TAB_STATUS",
    tabId: targetTab?.id || null
  });

  currentContext = resp.context;
  renderPermissions(resp.hasHostPermission);
  renderContext(resp.context, resp.runState);
  renderSettings(resp.settings);
  renderRunState(resp.runState);
}

function bindEvents() {
  el.grantPermissionBtn.addEventListener("click", async () => {
    const granted = await browser.permissions.request({ origins: ALL_ORIGIN_PATTERNS });
    renderPermissions(granted);
    await refreshAll();
  });

  el.runFullBtn.addEventListener("click", () => startAutomation("full", false));

  el.runFullChapterBtn.addEventListener("click", () => {
    if (currentContext?.site === "spx") {
      startAutomation("spx_no_tests", false);
    } else {
      startAutomation("full", true);
    }
  });

  el.runLecturesBtn.addEventListener("click", () => startAutomation("lectures", false));

  el.runReviewBtn.addEventListener("click", () => {
    if (currentContext?.site === "spx") {
      startAutomation("spx_tests", false);
    } else {
      startAutomation("review", false);
    }
  });

  el.stopBtn.addEventListener("click", async () => {
    if (!targetTab?.id) return;
    el.stopBtn.disabled = true;
    await browser.runtime.sendMessage({ type: "STOP_RUN", tabId: targetTab.id });
  });

  const navigateTarget = async () => {
    const targetId = el.chapterJumpInput.value.trim();
    if (!targetId || !currentContext?.origin || !targetTab?.id) return;
    await browser.runtime.sendMessage({
      type: "NAVIGATE_TO_TARGET",
      tabId: targetTab.id,
      origin: currentContext.origin,
      site: currentContext.site,
      targetId
    });
    setTimeout(refreshAll, 500);
  };

  el.chapterJumpBtn.addEventListener("click", navigateTarget);

  el.chapterJumpRunBtn.addEventListener("click", async () => {
    const targetId = el.chapterJumpInput.value.trim();
    if (!targetId) return;
    await startAutomation("full", false, targetId);
  });

  el.chapterJumpInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const targetId = el.chapterJumpInput.value.trim();
    if (!targetId) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      await startAutomation("full", false, targetId);
    } else {
      await navigateTarget();
    }
  });

  el.tabLogBtn.addEventListener("click", () => switchTab("log"));
  el.tabSettingsBtn.addEventListener("click", () => switchTab("settings"));

  el.copyLogBtn.addEventListener("click", async () => {
    const logs = currentRunState?.logs || [];
    const text = logs.map((l) => `[${l.time}] [${l.level.toUpperCase()}] ${l.text}`).join("\n");
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => {});
    el.copyLogBtn.textContent = "Copied!";
    setTimeout(() => {
      el.copyLogBtn.textContent = "Copy";
    }, 1200);
  });

  el.clearLogBtn.addEventListener("click", async () => {
    if (!targetTab?.id) return;
    await browser.runtime.sendMessage({ type: "CLEAR_LOG", tabId: targetTab.id });
  });

  const settingInputs = [
    el.optAutoAdvance,
    el.optAutoChain,
    el.optMaxChainChapters,
    el.optSmartSkip,
    el.optFocusOn404,
    el.optShowHud,
    el.optOneClickMode,
    el.optLectureLoadWait,
    el.optTabSettleDelay,
    el.optApiDelay,
    el.optConcurrency
  ];

  settingInputs.forEach((input) => {
    input.addEventListener("change", saveCurrentSettings);
  });

  el.resetSettingsBtn.addEventListener("click", async () => {
    const resp = await browser.runtime.sendMessage({ type: "RESET_SETTINGS" });
    if (resp?.settings) renderSettings(resp.settings);
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "RUN_STATE_UPDATED" && msg.tabId === targetTab?.id) {
      const prev = currentRunState;
      const next = msg.state;
      const contextChanged =
        !prev ||
        prev.status !== next?.status ||
        prev.chapterId !== next?.chapterId ||
        prev.subjectId !== next?.subjectId;

      renderRunState(next);

      if (contextChanged) {
        browser.runtime
          .sendMessage({ type: "GET_TAB_STATUS", tabId: targetTab.id })
          .then((resp) => {
            if (resp?.context) {
              currentContext = resp.context;
              renderContext(resp.context, next);
            }
          })
          .catch(() => {});
      }
    }
  });
}

async function startAutomation(mode, fullChapterFromLecture, idOverride = null) {
  if (!targetTab?.id) return;

  const requiredOrigins = currentContext?.site
    ? [currentContext.site === "spx" ? SPX_ORIGIN_PATTERN : QUREO_ORIGIN_PATTERN]
    : ALL_ORIGIN_PATTERNS;

  const hasPerm = await browser.permissions.contains({ origins: requiredOrigins });
  if (!hasPerm) {
    const granted = await browser.permissions.request({ origins: ALL_ORIGIN_PATTERNS });
    renderPermissions(granted);
    if (!granted) return;
  }

  const msg = {
    type: "START_RUN",
    tabId: targetTab.id,
    mode,
    fullChapterFromLecture
  };

  if (idOverride) {
    if (currentContext?.site === "spx") msg.subjectIdOverride = idOverride;
    else msg.chapterIdOverride = idOverride;
  }

  const res = await browser.runtime.sendMessage(msg);

  if (!res?.ok && res?.error) {
    el.progressCard.classList.remove("hidden");
    el.statusBadge.className = "pill error";
    el.statusBadge.textContent = "Error";
    el.progressMessage.textContent = res.error;
  }
}

function renderPermissions(hasPerm) {
  el.permissionBanner.classList.toggle("hidden", Boolean(hasPerm));
}

function renderContext(ctx, runState) {
  const isRunning = runState?.status === "running" || runState?.status === "stopping";
  const isSpx = ctx?.site === "spx" || runState?.site === "spx";

  if (isSpx) {
    el.statLbl1.textContent = "Chapters";
    el.statLbl2.textContent = "Skipped";
    el.statLbl3.textContent = "Reviews";
    el.statLbl4.textContent = "Tests";
  } else {
    el.statLbl1.textContent = "Lectures";
    el.statLbl2.textContent = "Skipped";
    el.statLbl3.textContent = "Answers";
    el.statLbl4.textContent = "Chapters";
  }

  if (!ctx?.isSupported) {
    el.contextDot.className = "status-dot inactive";
    el.contextTitle.textContent = "Unsupported Page";
    el.contextSubtitle.textContent = "Open qureo.education or spx-learning-square.com";
    el.chapterJumpInput.placeholder = "Chapter / Subject #";
    setActionButtonsEnabled(false, isRunning, ctx);
    el.chapterJumpInput.disabled = true;
    el.chapterJumpBtn.disabled = true;
    el.chapterJumpRunBtn.disabled = true;
    return;
  }

  el.contextDot.className = isRunning ? "status-dot running" : "status-dot ready";
  el.chapterJumpInput.disabled = isRunning;
  el.chapterJumpBtn.disabled = isRunning;
  el.chapterJumpRunBtn.disabled = isRunning;

  if (ctx.site === "spx") {
    el.lectureChoiceBanner.classList.add("hidden");
    el.runFullChapterBtn.classList.remove("hidden");
    el.runFullChapterBtn.textContent = "Chapters & Reviews Only (Skip Tests)";
    el.runLecturesBtn.textContent = "Chapters Only";
    el.runReviewBtn.textContent = "Solve Tests Only";
    el.chapterJumpInput.placeholder = ctx.subjectId ? `Subject: ${ctx.subjectId}` : "Subject #";

    if (ctx.subjectId) {
      el.contextTitle.textContent = `SPX • Subject ${ctx.subjectId}`;
      el.contextSubtitle.textContent = `${ctx.hostname} • Chapters, reviews & tests`;
      el.runFullBtn.textContent = `Complete All (Chapters, Reviews & Tests) • Subj. ${ctx.subjectId}`;
    } else {
      el.contextTitle.textContent = `SPX • ${ctx.hostname}`;
      el.contextSubtitle.textContent = "Open a Subject curriculum or enter Subject # below";
      el.runFullBtn.textContent = "Complete All (Chapters, Reviews & Tests)";
    }
  } else {
    el.runLecturesBtn.textContent = "Lectures Only";
    el.runReviewBtn.textContent = "Solve Test Only";
    el.chapterJumpInput.placeholder = ctx.chapterId ? `Current: ${ctx.chapterId}` : "Chapter #";

    if (ctx.pageType === "lecture") {
      el.contextTitle.textContent = `Chapter ${ctx.chapterId} • Lecture ${ctx.lectureId}`;
      el.contextSubtitle.textContent = ctx.hostname;
      el.runFullBtn.textContent = `Finish Lecture ${ctx.lectureId} & Review`;
      el.runFullChapterBtn.textContent = "Complete Full Chapter & Review";
      el.runFullChapterBtn.classList.remove("hidden");
      el.lectureChoiceBanner.classList.remove("hidden");
    } else if (ctx.isTestView) {
      el.contextTitle.textContent = `Chapter ${ctx.chapterId} • ${ctx.pageType === "test" ? "Comprehension Test" : "Review Test"}`;
      el.contextSubtitle.textContent = ctx.hostname;
      el.runFullBtn.textContent =
        ctx.pageType === "test" ? "Solve Comprehension Test" : "Solve Review Test";
      el.runFullChapterBtn.classList.add("hidden");
      el.lectureChoiceBanner.classList.add("hidden");
    } else if (ctx.pageType === "chapter") {
      el.contextTitle.textContent = `Chapter ${ctx.chapterId}`;
      el.contextSubtitle.textContent = `${ctx.hostname} • Ready for full automation`;
      el.runFullBtn.textContent = `Complete Chapter ${ctx.chapterId} + Test`;
      el.runFullChapterBtn.classList.add("hidden");
      el.lectureChoiceBanner.classList.add("hidden");
    } else {
      el.contextTitle.textContent = ctx.hostname;
      el.contextSubtitle.textContent = "Open a chapter or enter a Chapter # below";
      el.runFullBtn.textContent = "Run Full Automation";
      el.runFullChapterBtn.classList.add("hidden");
      el.lectureChoiceBanner.classList.add("hidden");
    }
  }

  setActionButtonsEnabled(true, isRunning, ctx);
}

function setActionButtonsEnabled(isSupported, isRunning, ctx) {
  if (ctx?.site === "spx") {
    const hasSubject = Boolean(ctx.subjectId);
    el.runFullBtn.disabled = !isSupported || isRunning || !hasSubject;
    el.runFullChapterBtn.disabled = !isSupported || isRunning || !hasSubject;
    el.runLecturesBtn.disabled = !isSupported || isRunning || !hasSubject;
    el.runReviewBtn.disabled = !isSupported || isRunning || !hasSubject;
  } else {
    const hasChapter = Boolean(ctx?.chapterId);
    el.runFullBtn.disabled = !isSupported || isRunning || !hasChapter;
    el.runFullChapterBtn.disabled = !isSupported || isRunning || !hasChapter;
    el.runLecturesBtn.disabled = !isSupported || isRunning || !hasChapter || Boolean(ctx?.isTestView);
    el.runReviewBtn.disabled = !isSupported || isRunning || !hasChapter;
  }

  el.stopBtn.classList.toggle("hidden", !isRunning);
  el.stopBtn.disabled = currentRunState?.status === "stopping";
  el.stopBtn.textContent =
    currentRunState?.status === "stopping" ? "Stopping..." : "Stop Automation";
}

function renderRunState(state) {
  currentRunState = state;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  if (!state) {
    el.progressCard.classList.add("hidden");
    renderLogs([]);
    return;
  }

  el.progressCard.classList.remove("hidden");

  const status = state.status || "idle";
  const badgeClass = ["running", "completed", "error", "stopped"].includes(status)
    ? status
    : "running";
  el.statusBadge.className = `pill ${badgeClass}`;
  el.statusBadge.textContent = status;

  const prefix =
    state.site === "spx"
      ? state.subjectId
        ? `Subj.${state.subjectId}`
        : "SPX"
      : state.chapterId
        ? `Ch.${state.chapterId}`
        : "";
  el.phaseText.textContent = prefix ? `${prefix} • ${state.phase || ""}` : state.phase || "";
  el.progressMessage.textContent = state.message || "";

  const total = state.total || 0;
  const current = state.current || 0;
  const pct =
    total > 0
      ? Math.min(100, Math.round((current / total) * 100))
      : status === "completed"
        ? 100
        : 10;
  el.progressBarFill.style.width = `${pct}%`;
  el.progressCountText.textContent = total > 0 ? `${current}/${total}` : "—";

  const stats = state.stats || {};
  el.statLectures.textContent = stats.lecturesCompleted ?? 0;
  el.statSkipped.textContent = stats.lecturesSkipped ?? 0;
  el.statAnswers.textContent = stats.questionsSubmitted ?? 0;
  el.statChapters.textContent = stats.chaptersCompleted ?? 0;

  const updateElapsed = () => {
    const end =
      status === "running" || status === "stopping" ? Date.now() : state.updatedAt || Date.now();
    const secs = Math.max(0, Math.floor((end - (state.startedAt || end)) / 1000));
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    el.elapsedText.textContent = `${mm}:${ss}`;
  };
  updateElapsed();
  if (status === "running" || status === "stopping") {
    elapsedTimer = setInterval(updateElapsed, 1000);
  }

  renderLogs(state.logs || []);
  if (currentContext) {
    renderContext(currentContext, state);
  }
}

function createLogRow(entry) {
  const row = document.createElement("div");
  row.className = "log-line";

  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  timeSpan.textContent = `[${entry.time}]`;

  const msgSpan = document.createElement("span");
  const lvl = ["info", "success", "warn", "error"].includes(entry.level) ? entry.level : "info";
  msgSpan.className = `log-${lvl}`;
  msgSpan.textContent = entry.text;

  row.append(timeSpan, msgSpan);
  return row;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    renderedLogsSnapshot = [];
    el.logContainer.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No activity yet.";
    el.logContainer.appendChild(empty);
    return;
  }

  // Fast incremental append if previous entries are an exact prefix of new logs
  const prevLen = renderedLogsSnapshot.length;
  let isPrefix = prevLen > 0 && logs.length >= prevLen;
  if (isPrefix) {
    for (let i = 0; i < prevLen; i++) {
      if (
        renderedLogsSnapshot[i].time !== logs[i].time ||
        renderedLogsSnapshot[i].text !== logs[i].text
      ) {
        isPrefix = false;
        break;
      }
    }
  }

  if (isPrefix) {
    if (logs.length === prevLen) return;
    const frag = document.createDocumentFragment();
    for (let i = prevLen; i < logs.length; i++) {
      frag.appendChild(createLogRow(logs[i]));
    }
    el.logContainer.appendChild(frag);
  } else {
    const frag = document.createDocumentFragment();
    for (const entry of logs) {
      frag.appendChild(createLogRow(entry));
    }
    el.logContainer.replaceChildren(frag);
  }

  renderedLogsSnapshot = logs.map((l) => ({ time: l.time, text: l.text }));
  el.logContainer.scrollTop = el.logContainer.scrollHeight;
}

function renderSettings(settings) {
  if (!settings) return;
  el.optAutoAdvance.checked = Boolean(settings.autoAdvance);
  el.optAutoChain.checked = Boolean(settings.autoChain);
  el.optMaxChainChapters.value = settings.maxChainChapters ?? 5;
  el.optSmartSkip.checked = Boolean(settings.smartSkipCompleted);
  el.optFocusOn404.checked = Boolean(settings.focusOn404);
  el.optShowHud.checked = Boolean(settings.showHud);
  el.optOneClickMode.checked = Boolean(settings.oneClickMode);
  el.optLectureLoadWait.value = settings.lectureLoadWaitMs ?? 2500;
  el.optTabSettleDelay.value = settings.tabSettleDelayMs ?? 800;
  el.optApiDelay.value = settings.apiDelayMs ?? 150;
  el.optConcurrency.value = settings.concurrency ?? 1;
  el.optMaxChainChapters.disabled = !el.optAutoAdvance.checked || !el.optAutoChain.checked;
}

async function saveCurrentSettings() {
  el.optMaxChainChapters.disabled = !el.optAutoAdvance.checked || !el.optAutoChain.checked;
  const payload = {
    autoAdvance: el.optAutoAdvance.checked,
    autoChain: el.optAutoChain.checked,
    maxChainChapters: Number(el.optMaxChainChapters.value),
    smartSkipCompleted: el.optSmartSkip.checked,
    focusOn404: el.optFocusOn404.checked,
    showHud: el.optShowHud.checked,
    oneClickMode: el.optOneClickMode.checked,
    lectureLoadWaitMs: Number(el.optLectureLoadWait.value),
    tabSettleDelayMs: Number(el.optTabSettleDelay.value),
    apiDelayMs: Number(el.optApiDelay.value),
    concurrency: Number(el.optConcurrency.value)
  };
  const resp = await browser.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: payload });
  if (resp?.settings) renderSettings(resp.settings);
}

function switchTab(tabName) {
  const isLog = tabName === "log";
  el.tabLogBtn.classList.toggle("active", isLog);
  el.tabSettingsBtn.classList.toggle("active", !isLog);
  el.logPanel.classList.toggle("hidden", !isLog);
  el.settingsPanel.classList.toggle("hidden", isLog);
}