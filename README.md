# Qureo & SPX Auto Completer

A browser extension (available for both **Chrome** and **Firefox**) that automates lectures, chapters, reviews, and tests on **Qureo** (`*.qureo.education`) and **SPX Learning Square** (`*.spx-learning-square.com`) with live progress tracking, an in-page floating HUD, and configurable controls.

---

## Features

- **Qureo Automation**
  - **Full Chapter & Test**: Sequentially completes all lectures in a chapter, then extracts and submits verified answers for the review or comprehension test.
  - **Single Lecture or Lectures Only**: Finish just the current lecture or all lectures in a chapter without taking the test.
  - **Solve Test Only**: Extracts answers and submits a fresh 100% attempt on review or comprehension tests.
  - **Smart Skip**: Skips already-completed lectures and only initializes unopened lectures in a background tab when needed.
  - **Auto-Advance & Chapter Chaining**: Optionally move to the next chapter (`N+1` or next unit) and chain multiple chapters automatically.
- **SPX Learning Square Automation**
  - **Complete All**: Sequentially completes unlocked chapters, reviews, and tests in a subject curriculum, then unlocks subject achievements.
  - **Chapters & Reviews Only (Skip Tests)**: Completes chapters and reviews while leaving tests untouched.
  - **Chapters Only / Solve Tests Only**: Run targeted phases on the current subject.
- **Live Progress & Controls**
  - **Popup Dashboard**: Shows current page context, Chapter/Subject jump & run, progress bar, stats, activity log (with Copy/Clear), and settings.
  - **In-Page Floating HUD**: Displays live status, progress, and a Stop/Panel button directly on the page (minimizable).
  - **One-Click Toolbar Mode & Shortcut**: Toggle one-click execution from the toolbar icon or press `Alt+Shift+Q` to start/stop automation.

---

## Project Structure

```text
Qureo-solver/
├── chrome_version/     # Manifest V3 extension for Google Chrome / Chromium
└── firefox_version/    # Manifest V3 extension for Mozilla Firefox (112.0+)
```

---

## Installation

### Google Chrome / Chromium (`chrome_version`)

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `chrome_version/` folder.
4. Pin the extension to your toolbar if desired.

### Mozilla Firefox (`firefox_version`)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on...**.
3. Select `firefox_version/manifest.json`.

---

## Usage

1. Log in to `qureo.education` or `spx-learning-square.com` and open a Chapter, Lecture, Review/Test page (Qureo) or a Subject curriculum page (SPX).
2. Click the extension icon to open the control panel (or press `Alt+Shift+Q` to start/stop immediately).
3. Grant site access if prompted, choose an automation mode, and monitor progress in the popup or the floating in-page HUD.
4. You can also enter a Chapter # or Subject # in the **Go / Go & Run** bar to jump directly to a target.

---

## Settings

- **Auto-advance to next chapter (Qureo)**: Automatically navigates to the next chapter after solving a test.
- **Chain multiple chapters (Qureo)**: Continues full automation across consecutive chapters (up to **Max chapters per chain**, `0` = until end of unit).
- **Smart skip opened/done lectures (Qureo)**: Skips completed lectures and only opens a background tab when a lecture returns `404`.
- **Focus tab briefly on 404 retry (Qureo)**: Temporarily focuses background-throttled lecture tabs if initialization stalls.
- **Show in-page floating HUD**: Toggles the floating overlay on supported pages.
- **One-click toolbar mode**: Clicking the toolbar icon starts/stops automation immediately instead of opening the popup.
- **Timing controls**: Configure **Lecture init wait (ms)**, **Tab settle delay (ms)**, and **API request delay (ms)**.
