export const QUREO_ORIGIN_PATTERN = "*://*.qureo.education/*";
export const SPX_ORIGIN_PATTERN = "*://*.spx-learning-square.com/*";
export const ALL_ORIGIN_PATTERNS = [QUREO_ORIGIN_PATTERN, SPX_ORIGIN_PATTERN];

export const DEFAULT_SETTINGS = Object.freeze({
  autoAdvance: true,
  autoChain: false,
  maxChainChapters: 5,
  smartSkipCompleted: true,
  lectureLoadWaitMs: 2500,
  focusOn404: true,
  tabSettleDelayMs: 800,
  apiDelayMs: 150,
  requestTimeoutMs: 15000,
  maxRetries: 2,
  showHud: true,
  oneClickMode: false
});

export function clampInt(val, min, max) {
  const num = Number.parseInt(val, 10);
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

export function normalizeSettings(partial = {}, base = DEFAULT_SETTINGS) {
  const merged = { ...DEFAULT_SETTINGS, ...base, ...partial };
  return {
    autoAdvance: Boolean(merged.autoAdvance),
    autoChain: Boolean(merged.autoChain),
    maxChainChapters: clampInt(merged.maxChainChapters, 0, 100),
    smartSkipCompleted: Boolean(merged.smartSkipCompleted),
    lectureLoadWaitMs: clampInt(merged.lectureLoadWaitMs, 500, 20000),
    focusOn404: Boolean(merged.focusOn404),
    tabSettleDelayMs: clampInt(merged.tabSettleDelayMs, 200, 15000),
    apiDelayMs: clampInt(merged.apiDelayMs, 0, 10000),
    requestTimeoutMs: clampInt(merged.requestTimeoutMs, 3000, 60000),
    maxRetries: clampInt(merged.maxRetries, 0, 5),
    showHud: Boolean(merged.showHud),
    oneClickMode: Boolean(merged.oneClickMode)
  };
}

export function isQureoUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (parsed.hostname === "qureo.education" || parsed.hostname.endsWith(".qureo.education"))
    );
  } catch {
    return false;
  }
}

export function isSpxUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      (parsed.hostname === "spx-learning-square.com" ||
        parsed.hostname.endsWith(".spx-learning-square.com"))
    );
  } catch {
    return false;
  }
}

export function isSupportedUrl(url) {
  return isQureoUrl(url) || isSpxUrl(url);
}

export function getSiteHostPattern(site) {
  return site === "spx" ? SPX_ORIGIN_PATTERN : QUREO_ORIGIN_PATTERN;
}

export function parsePageContext(url) {
  if (isQureoUrl(url)) {
    const parsed = new URL(url);
    const { pathname } = parsed;
    const chapterMatch = pathname.match(/\/chapter\/(\d+)/);
    const lectureMatch = pathname.match(/\/lecture\/(\d+)/);
    const isReviewPage = /\/review(\/|$)/.test(pathname);
    const isTestPath = /\/test(\/|$)/.test(pathname);

    let pageType = "other_qureo";
    if (isReviewPage) pageType = "review";
    else if (isTestPath) pageType = "test";
    else if (lectureMatch) pageType = "lecture";
    else if (chapterMatch) pageType = "chapter";

    return {
      site: "qureo",
      isSupported: true,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname,
      chapterId: chapterMatch ? chapterMatch[1] : null,
      lectureId: lectureMatch ? lectureMatch[1] : null,
      subjectId: null,
      isReviewPage,
      isTestView: isReviewPage || isTestPath,
      pageType
    };
  }

  if (isSpxUrl(url)) {
    const parsed = new URL(url);
    const { pathname } = parsed;
    const subjectMatch = pathname.match(/\/subjects\/(\d+)/);

    return {
      site: "spx",
      isSupported: true,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname,
      chapterId: null,
      lectureId: null,
      subjectId: subjectMatch ? subjectMatch[1] : null,
      isReviewPage: false,
      isTestView: false,
      pageType: subjectMatch ? "spx_subject" : "other_spx"
    };
  }

  return {
    site: null,
    isSupported: false,
    origin: null,
    hostname: null,
    pathname: "",
    chapterId: null,
    lectureId: null,
    subjectId: null,
    isReviewPage: false,
    isTestView: false,
    pageType: "unsupported"
  };
}
