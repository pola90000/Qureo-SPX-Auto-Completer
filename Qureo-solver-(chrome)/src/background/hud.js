export async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ text: String(text), tabId });
    if (color) {
      await chrome.action.setBadgeBackgroundColor({ color, tabId });
    }
  } catch {
    // Tab might be closed or mid-navigation
  }
}

export async function renderHud(tabId, hudPayload) {
  try {
    const [fastRes] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [hudPayload],
      func: (data) => {
        if (typeof globalThis.__qureoHudUpdate === "function") {
          globalThis.__qureoHudUpdate(data);
          return true;
        }
        return false;
      }
    });

    if (fastRes?.result === true) return;

    await chrome.scripting.executeScript({
      target: { tabId },
      args: [hudPayload],
      func: mountAndBindHud
    });
  } catch {
    // Ignore when page is mid-navigation or privileged
  }
}

function mountAndBindHud(initialData) {
  const HOST_ID = "qureo-auto-hud-host";

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host?.shadowRoot) return host;
    if (host) host.remove();

    host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        width: 316px;
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 12px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(8px);
        overflow: hidden;
        font-size: 13px;
        line-height: 1.4;
      }
      .card.hidden { display: none; }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: rgba(30, 41, 59, 0.85);
        border-bottom: 1px solid rgba(148, 163, 184, 0.16);
      }
      .title-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 12.5px;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #38bdf8;
        flex-shrink: 0;
      }
      .dot.running {
        background: #38bdf8;
        animation: pulse 1.2s infinite ease-in-out;
      }
      .dot.completed { background: #10b981; }
      .dot.error { background: #ef4444; }
      .dot.stopped { background: #f59e0b; }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(0.85); }
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .badge {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.18);
        color: #7dd3fc;
      }
      .icon-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 2px 5px;
        border-radius: 4px;
      }
      .icon-btn:hover {
        background: rgba(148, 163, 184, 0.18);
        color: #ffffff;
      }
      .body { padding: 11px 12px; }
      .msg {
        color: #e2e8f0;
        margin-bottom: 10px;
        word-break: break-word;
      }
      .progress-track {
        height: 6px;
        width: 100%;
        background: rgba(148, 163, 184, 0.2);
        border-radius: 999px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #4f46e5, #06b6d4);
        transition: width 0.2s ease;
      }
      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11.5px;
        color: #94a3b8;
      }
      .btn-row { display: flex; gap: 6px; }
      .btn {
        border: none;
        border-radius: 6px;
        padding: 4px 9px;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn-stop {
        background: rgba(239, 68, 68, 0.2);
        color: #fca5a5;
        border: 1px solid rgba(239, 68, 68, 0.4);
      }
      .btn-stop:hover { background: rgba(239, 68, 68, 0.35); color: #fff; }
      .btn-panel {
        background: rgba(148, 163, 184, 0.16);
        color: #e2e8f0;
      }
      .btn-panel:hover { background: rgba(148, 163, 184, 0.28); }
      .mini-pill {
        display: none;
        align-items: center;
        gap: 8px;
        background: rgba(15, 23, 42, 0.95);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
      }
      .mini-pill.visible { display: inline-flex; }
    `;

    const card = document.createElement("div");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "title-wrap";
    const dot = document.createElement("span");
    dot.className = "dot";
    const titleText = document.createElement("span");
    titleText.className = "hud-title";
    titleText.textContent = "Auto Completer";
    titleWrap.append(dot, titleText);

    const headerActions = document.createElement("div");
    headerActions.className = "header-actions";
    const phaseBadge = document.createElement("span");
    phaseBadge.className = "badge";
    const minBtn = document.createElement("button");
    minBtn.className = "icon-btn";
    minBtn.title = "Minimize";
    minBtn.textContent = "−";
    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn";
    closeBtn.title = "Hide HUD";
    closeBtn.textContent = "×";
    headerActions.append(phaseBadge, minBtn, closeBtn);
    header.append(titleWrap, headerActions);

    const body = document.createElement("div");
    body.className = "body";
    const msgEl = document.createElement("div");
    msgEl.className = "msg";
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    track.appendChild(fill);

    const footer = document.createElement("div");
    footer.className = "footer";
    const metaEl = document.createElement("span");
    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";
    const panelBtn = document.createElement("button");
    panelBtn.className = "btn btn-panel";
    panelBtn.textContent = "Panel";
    const stopBtn = document.createElement("button");
    stopBtn.className = "btn btn-stop";
    stopBtn.textContent = "Stop";
    btnRow.append(panelBtn, stopBtn);
    footer.append(metaEl, btnRow);

    body.append(msgEl, track, footer);
    card.append(header, body);

    const miniPill = document.createElement("button");
    miniPill.className = "mini-pill";
    const miniDot = document.createElement("span");
    miniDot.className = "dot";
    const miniText = document.createElement("span");
    miniPill.append(miniDot, miniText);

    minBtn.addEventListener("click", () => {
      sessionStorage.setItem("qureo_hud_min", "1");
      card.classList.add("hidden");
      miniPill.classList.add("visible");
    });

    miniPill.addEventListener("click", () => {
      sessionStorage.removeItem("qureo_hud_min");
      miniPill.classList.remove("visible");
      card.classList.remove("hidden");
    });

    closeBtn.addEventListener("click", () => {
      host.remove();
    });

    stopBtn.addEventListener("click", () => {
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
      chrome.runtime.sendMessage({ type: "STOP_RUN_FROM_TAB" }).catch(() => {});
    });

    panelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_SETTINGS_TAB" }).catch(() => {});
    });

    shadow.append(style, card, miniPill);
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  globalThis.__qureoHudUpdate = (data) => {
    const host = ensureHost();
    const shadow = host.shadowRoot;
    const card = shadow.querySelector(".card");
    const miniPill = shadow.querySelector(".mini-pill");
    const dot = card.querySelector(".dot");
    const titleEl = card.querySelector(".hud-title");
    const miniDot = miniPill.querySelector(".dot");
    const badge = shadow.querySelector(".badge");
    const msgEl = shadow.querySelector(".msg");
    const fill = shadow.querySelector(".progress-fill");
    const metaEl = shadow.querySelector(".footer span");
    const stopBtn = shadow.querySelector(".btn-stop");
    const miniText = miniPill.querySelectorAll("span")[1];

    titleEl.textContent = data.title || "Auto Completer";

    const statusClass = ["running", "completed", "error", "stopped"].includes(data.status)
      ? data.status
      : "running";
    dot.className = `dot ${statusClass}`;
    miniDot.className = `dot ${statusClass}`;

    badge.textContent = data.phase || data.status || "run";
    msgEl.textContent = data.message || "";

    const pct =
      data.total > 0
        ? Math.min(100, Math.round((data.current / data.total) * 100))
        : data.status === "completed"
          ? 100
          : 15;
    fill.style.width = `${pct}%`;

    const parts = [];
    if (data.idLabel) parts.push(data.idLabel);
    if (data.total > 0) parts.push(`${data.current}/${data.total}`);
    if (data.doneBadge > 0) parts.push(`Done: ${data.doneBadge}`);
    metaEl.textContent = parts.join(" • ") || "Active";
    miniText.textContent = `${data.title || "Auto"} • ${parts.join(" ") || data.status}`;

    const isRunning = data.status === "running" || data.status === "stopping";
    stopBtn.style.display = isRunning ? "inline-block" : "none";
    stopBtn.disabled = data.status === "stopping";
    stopBtn.textContent = data.status === "stopping" ? "Stopping..." : "Stop";

    if (sessionStorage.getItem("qureo_hud_min") === "1") {
      card.classList.add("hidden");
      miniPill.classList.add("visible");
    } else {
      card.classList.remove("hidden");
      miniPill.classList.remove("visible");
    }
  };

  globalThis.__qureoHudUpdate(initialData);
}
