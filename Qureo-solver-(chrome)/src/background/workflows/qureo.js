import { parsePageContext } from "../../shared/constants.js";
import { safeParseJson, sleep, throwIfAborted } from "../../shared/async.js";
import { apiFetchWithRetry } from "../network.js";
import {
  attachTabApiTracker,
  navigateAndWait,
  reloadAndWait,
  waitForApiIdle,
  waitForTabLoad
} from "../tabs.js";

export async function executeQureoWorkflow(run, initialContext, options) {
  const { tabId, signal, settings, state, log, publish, setBadge, finishSuccess, handleError } = run;
  const origin = initialContext.origin;
  const expectedHost = new URL(origin).hostname;

  try {
    log("info", `Started Qureo ${state.mode.toUpperCase()} automation on ${origin}.`);
    await setBadge("...", "#3b82f6");

    if (options.chapterIdOverride) {
      const targetUrl = `${origin}/chapter/${options.chapterIdOverride}`;
      state.phase = "navigating";
      state.message = `Navigating to Chapter ${options.chapterIdOverride}...`;
      log("info", state.message);
      await publish();
      await navigateAndWait(tabId, targetUrl, 25000, signal, expectedHost);
      await sleep(settings.tabSettleDelayMs, signal);
    }

    let currentTab = await chrome.tabs.get(tabId);
    let ctx = parsePageContext(currentTab.url);

    if (!ctx.chapterId) {
      throw new Error(
        "Could not detect a Chapter ID in the current URL. Open a chapter, lecture, or review/test page—or enter a Chapter ID in the popup."
      );
    }

    if (ctx.pageType === "lecture" && !options.fullChapterFromLecture && state.mode !== "review") {
      state.chapterId = ctx.chapterId;
      state.phase = "lectures";
      state.current = 0;
      state.total = 1;
      state.message = `Completing Lecture ${ctx.lectureId} (Chapter ${ctx.chapterId})...`;
      await setBadge("LEC", "#3b82f6");
      await publish();

      const res = await processLecture(run, ctx.origin, currentTab.url, ctx.lectureId);
      if (res === "success") state.stats.lecturesCompleted++;
      else if (res === "already_done") state.stats.lecturesSkipped++;
      else {
        state.stats.lecturesFailed++;
        throw new Error(`Failed to complete lecture ${ctx.lectureId}.`);
      }

      state.current = 1;
      await publish();

      if (state.mode === "lectures") {
        await finishSuccess(`Lecture ${ctx.lectureId} processed.`);
        return;
      }

      const chapterMeta = await fetchChapterMeta(run, origin, ctx.chapterId).catch(() => null);
      const testSlug = await resolveTestPagePath(tabId, ctx.chapterId, chapterMeta);
      const testUrl = `${origin}/chapter/${ctx.chapterId}/${testSlug}`;
      state.phase = "navigating";
      state.message = `Moving to Chapter ${ctx.chapterId} test...`;
      log("info", state.message);
      await publish();
      await navigateAndWait(tabId, testUrl, 25000, signal, expectedHost);
      await sleep(settings.tabSettleDelayMs, signal);

      const reviewRes = await runReviewTestPhase(run, origin, ctx.chapterId, chapterMeta);
      state.stats.chaptersCompleted++;

      if (!settings.autoAdvance) {
        await reloadAndWait(tabId, 20000, signal, expectedHost);
        await finishSuccess(
          `Test complete (${reviewRes.submitted}/${reviewRes.total} answers submitted).`
        );
        return;
      }

      const nextInfo = await resolveNextChapter(run, origin, ctx.chapterId, chapterMeta);
      if (!nextInfo.exists) {
        await finishSuccess(
          `Chapter ${ctx.chapterId} complete! No next chapter found—course complete!`
        );
        return;
      }

      state.phase = "advancing";
      state.message = `Navigating to Chapter ${nextInfo.nextChapterId}...`;
      log("info", state.message);
      await publish();
      await navigateAndWait(
        tabId,
        `${origin}/chapter/${nextInfo.nextChapterId}`,
        25000,
        signal,
        expectedHost
      );
      await sleep(settings.tabSettleDelayMs, signal);

      if (
        !settings.autoChain ||
        (settings.maxChainChapters > 0 && state.stats.chaptersCompleted >= settings.maxChainChapters)
      ) {
        await finishSuccess(
          `Completed Chapter ${ctx.chapterId} and moved to Chapter ${nextInfo.nextChapterId}.`
        );
        return;
      }
    }

    while (!signal.aborted) {
      throwIfAborted(signal);
      currentTab = await chrome.tabs.get(tabId);
      ctx = parsePageContext(currentTab.url);

      const chapterId = ctx.chapterId;
      if (!chapterId) {
        throw new Error("Lost Chapter ID during workflow.");
      }

      state.chapterId = chapterId;
      let chapterMeta = null;

      if (state.mode !== "review" && !ctx.isTestView) {
        chapterMeta = await runChapterLecturesPhase(run, origin, chapterId);

        if (state.mode === "lectures") {
          if (chapterMeta.__noLectures) {
            throw new Error(`No lectures found in Chapter ${chapterId}.`);
          }
          await finishSuccess(
            `Chapter ${chapterId} lectures done! Completed: ${state.stats.lecturesCompleted}, Skipped: ${state.stats.lecturesSkipped}.`
          );
          return;
        }

        const testSlug = await resolveTestPagePath(tabId, chapterId, chapterMeta);
        const testUrl = `${origin}/chapter/${chapterId}/${testSlug}`;
        state.phase = "navigating";
        state.message = `Navigating to Chapter ${chapterId} ${testSlug}...`;
        log("info", state.message);
        await publish();
        await navigateAndWait(tabId, testUrl, 25000, signal, expectedHost);
        await sleep(settings.tabSettleDelayMs, signal);
      } else if (!ctx.isTestView) {
        chapterMeta = await fetchChapterMeta(run, origin, chapterId).catch(() => null);
        const testSlug = await resolveTestPagePath(tabId, chapterId, chapterMeta);
        const testUrl = `${origin}/chapter/${chapterId}/${testSlug}`;
        state.phase = "navigating";
        state.message = `Opening Chapter ${chapterId} ${testSlug}...`;
        log("info", state.message);
        await publish();
        await navigateAndWait(tabId, testUrl, 25000, signal, expectedHost);
        await sleep(settings.tabSettleDelayMs, signal);
      }

      const reviewResult = await runReviewTestPhase(run, origin, chapterId, chapterMeta);
      state.stats.chaptersCompleted++;

      if (!settings.autoAdvance) {
        await reloadAndWait(tabId, 20000, signal, expectedHost);
        await finishSuccess(
          `Chapter ${chapterId} completed (${reviewResult.submitted}/${reviewResult.total} answers submitted).`
        );
        return;
      }

      const nextInfo = await resolveNextChapter(run, origin, chapterId, chapterMeta);
      if (!nextInfo.exists) {
        await finishSuccess(
          `Chapter ${chapterId} completed! Chapter ${nextInfo.nextChapterId} does not exist—end of unit/course.`
        );
        return;
      }

      state.phase = "advancing";
      state.message = `Moving to Chapter ${nextInfo.nextChapterId}...`;
      log("info", state.message);
      await publish();
      await navigateAndWait(
        tabId,
        `${origin}/chapter/${nextInfo.nextChapterId}`,
        25000,
        signal,
        expectedHost
      );
      await sleep(settings.tabSettleDelayMs, signal);

      const canContinueChain =
        state.mode === "full" &&
        settings.autoChain &&
        (settings.maxChainChapters === 0 || state.stats.chaptersCompleted < settings.maxChainChapters);

      if (!canContinueChain) {
        await finishSuccess(
          `Chapter ${chapterId} complete! Ready on Chapter ${nextInfo.nextChapterId}.`
        );
        return;
      }

      log(
        "info",
        `Chaining to Chapter ${nextInfo.nextChapterId} (${state.stats.chaptersCompleted}${settings.maxChainChapters > 0 ? `/${settings.maxChainChapters}` : ""} done)...`
      );
    }
  } catch (err) {
    await handleError(err);
  }
}

export async function fetchChapterMeta(run, origin, chapterId) {
  const chapterApiUrl = `${origin}/api/study/chapters/${chapterId}`;
  const apiResponse = await apiFetchWithRetry(run, chapterApiUrl, {
    method: "GET",
    headers: { Accept: "application/json, */*" }
  });

  if (!apiResponse.ok) {
    throw new Error(`Failed to fetch Chapter ${chapterId} (HTTP ${apiResponse.status}).`);
  }
  return await safeParseJson(apiResponse);
}

async function runChapterLecturesPhase(run, origin, chapterId) {
  const { signal, settings, state, log, publish, setBadge } = run;
  state.phase = "lectures";
  state.current = 0;
  state.total = 0;
  state.message = `Fetching Chapter ${chapterId} lectures...`;
  await setBadge("LEC", "#3b82f6");
  await publish();

  const apiData = await fetchChapterMeta(run, origin, chapterId);
  const lectures = Array.isArray(apiData?.lectures) ? apiData.lectures : [];

  if (lectures.length === 0) {
    log("info", `Chapter ${chapterId} has no lectures; proceeding to test.`);
    return { ...(apiData || {}), __noLectures: true };
  }

  state.total = lectures.length;
  log("info", `Chapter ${chapterId}: Found ${lectures.length} lecture(s).`);
  await publish();

  const pending = [];
  let doneCount = 0;

  for (const lecture of lectures) {
    if (settings.smartSkipCompleted && isLectureAlreadyCompleted(lecture)) {
      doneCount++;
      state.stats.lecturesSkipped++;
      state.current = doneCount;
      state.message = `Skipped Lecture ${lecture.id} (${doneCount}/${lectures.length}) — already completed.`;
      log("info", state.message);
    } else {
      pending.push(lecture);
    }
  }

  if (doneCount > 0) {
    await setBadge(`${doneCount}/${lectures.length}`, "#3b82f6");
    await publish();
  }

  if (pending.length === 0) {
    return apiData;
  }

  for (const lecture of pending) {
    throwIfAborted(signal);
    const lectureId = lecture.id;
    const lectureUrl = `${origin}/chapter/${chapterId}/lecture/${lectureId}`;

    const result = await processLecture(run, origin, lectureUrl, lectureId);
    doneCount++;
    state.current = doneCount;
    await setBadge(`${doneCount}/${lectures.length}`, "#3b82f6");

    if (result === "success") {
      state.stats.lecturesCompleted++;
      state.message = `Lecture ${lectureId} completed (${doneCount}/${lectures.length}).`;
      log("success", state.message);
    } else if (result === "already_done") {
      state.stats.lecturesSkipped++;
      state.message = `Lecture ${lectureId} was already completed (${doneCount}/${lectures.length}).`;
      log("info", state.message);
    } else {
      state.stats.lecturesFailed++;
      throw new Error(`Failed to complete Lecture ${lectureId}.`);
    }

    await publish();
    if (settings.apiDelayMs > 0) {
      await sleep(settings.apiDelayMs, signal);
    }
  }

  return apiData;
}

export async function processLecture(run, origin, lectureUrl, lectureId) {
  const { tabId, signal, settings, log, publish, spawnedTabIds } = run;
  const completeUrl = `${origin}/api/study/students/lectures/${lectureId}/complete`;

  if (settings.smartSkipCompleted) {
    const quickRes = await apiFetchWithRetry(run, completeUrl, {
      method: "PUT",
      headers: { Accept: "*/*", "Content-Type": "application/json" }
    });

    if (quickRes.ok) return "success";
    if (quickRes.status === 400) return "already_done";
    if (quickRes.status !== 404) {
      const bodyPreview = (await quickRes.text().catch(() => "")).slice(0, 120);
      log(
        "error",
        `Lecture ${lectureId} PUT returned HTTP ${quickRes.status}${bodyPreview ? `: ${bodyPreview}` : ""}`
      );
      return "failed";
    }
  }

  throwIfAborted(signal);
  const parentTab = await chrome.tabs.get(tabId);
    const expectedHost = new URL(origin).hostname;
    const minWaitAfterLoadMs = Math.max(500, settings.lectureLoadWaitMs ?? 2500);

    let ghostTab = null;
    let apiTracker = null;
    let activatedTab = false;

    try {
      run.state.message = `Initializing Lecture ${lectureId} in background tab...`;
      await publish();

      ghostTab = await chrome.tabs.create({
        url: lectureUrl,
        active: false,
        windowId: parentTab.windowId
      });

      if (ghostTab?.id) {
        spawnedTabIds?.add(ghostTab.id);
      }
      throwIfAborted(signal);

      apiTracker = attachTabApiTracker(ghostTab.id);
      await waitForTabLoad(ghostTab.id, 25000, signal, expectedHost, true);
      await waitForApiIdle(apiTracker, minWaitAfterLoadMs, 10000, signal);

      const max404Retries = 4;
      for (let attempt = 0; attempt <= max404Retries; attempt++) {
        throwIfAborted(signal);

        const response = await apiFetchWithRetry(
          run,
          completeUrl,
          {
            method: "PUT",
            headers: { Accept: "*/*", "Content-Type": "application/json" }
          },
          { refererOverride: lectureUrl }
        );

        if (response.ok) return "success";
        if (response.status === 400) return "already_done";

        if (response.status === 404 && attempt < max404Retries) {
          log(
            "warn",
            `Lecture ${lectureId} waiting for SPA init (HTTP 404, API calls seen: ${apiTracker.totalStarted}). Retry ${attempt + 1}/${max404Retries}...`
          );
          await publish();

          if (attempt === 1 && settings.focusOn404) {
            activatedTab = true;
            await chrome.tabs.update(ghostTab.id, { active: true }).catch(() => {});
            await waitForApiIdle(apiTracker, 1500, 5000, signal);
            await chrome.tabs.update(parentTab.id, { active: true }).catch(() => {});
            activatedTab = false;
          } else {
            await waitForApiIdle(apiTracker, 1000, 4000, signal);
          }
          continue;
        }

        const bodyPreview = (await response.text().catch(() => "")).slice(0, 120);
        log(
          "error",
          `Lecture ${lectureId} PUT returned HTTP ${response.status} (API calls seen: ${apiTracker.totalStarted})${bodyPreview ? `: ${bodyPreview}` : ""}`
        );
        return "failed";
      }

      return "failed";
    } finally {
      if (apiTracker) apiTracker.detach();
      if (activatedTab) {
        await chrome.tabs.update(parentTab.id, { active: true }).catch(() => {});
      }
      if (ghostTab?.id) {
        spawnedTabIds?.delete(ghostTab.id);
        await chrome.tabs.remove(ghostTab.id).catch(() => {});
      }
    }
}

export function isLectureAlreadyCompleted(lecture) {
  if (!lecture || typeof lecture !== "object") return false;
  if (lecture.is_completed === true || lecture.completed === true || lecture.is_done === true) {
    return true;
  }
  if (
    typeof lecture.status === "string" &&
    ["completed", "done", "finished", "cleared"].includes(lecture.status.toLowerCase())
  ) {
    return true;
  }
  if (lecture.student_lecture?.is_completed === true || lecture.student_lecture?.completed === true) {
    return true;
  }
  return false;
}

export async function runReviewTestPhase(run, origin, chapterId, chapterMeta = null) {
  const { tabId, signal, settings, state, log, publish, setBadge } = run;
  const expectedHost = new URL(origin).hostname;

  if (!chapterMeta) {
    chapterMeta = await fetchChapterMeta(run, origin, chapterId).catch(() => null);
  }

  const testType = chapterMeta?.test_type ?? chapterMeta?.chapter?.test_type ?? null;
  let endpointKind = testType && testType !== "review" ? "test-questions" : "review-questions";

  const initTestUrl = `${origin}/api/study/students/chapters/${chapterId}/test`;
  const getQuestionsUrl = `${origin}/api/study/chapters/${chapterId}/test`;
  const testResultUrl = `${origin}/api/study/students/chapters/${chapterId}/test/result`;

  state.phase = "extracting";
  state.current = 0;
  state.total = 0;
  state.message = `Fetching Chapter ${chapterId} test questions...`;
  await setBadge("TST", "#8b5cf6");
  await publish();

  const getRes = await apiFetchWithRetry(run, getQuestionsUrl, {
    method: "GET",
    headers: { Accept: "application/json, */*" }
  });
  if (!getRes.ok) {
    throw new Error(`Failed to fetch test questions (HTTP ${getRes.status}).`);
  }

  const rawTest = await safeParseJson(getRes);
  const questionsList = Array.isArray(rawTest)
    ? rawTest
    : Array.isArray(rawTest?.questions)
      ? rawTest.questions
      : [];

  if (questionsList.length === 0) {
    throw new Error(`No test questions returned for Chapter ${chapterId}.`);
  }

  state.total = questionsList.length;
  const correctMap = new Map();

  if (endpointKind === "test-questions") {
    const existingResult = await fetchTestResultMap(run, testResultUrl);
    if (existingResult && hasAnswersForAllQuestions(questionsList, existingResult.answerMap)) {
      for (const [k, v] of existingResult.answerMap.entries()) {
        correctMap.set(k, v);
      }
      state.stats.questionsExtracted += correctMap.size;
      log(
        "info",
        `Found existing test result key (${correctMap.size}/${questionsList.length} answers); skipping dummy attempt.`
      );
    }
  }

  if (correctMap.size === 0) {
    log(
      "info",
      `Chapter ${chapterId} (${endpointKind}): Extracting answers for ${questionsList.length} question(s)...`
    );
    await publish();

    const initRes = await apiFetchWithRetry(run, initTestUrl, {
      method: "PUT",
      headers: { Accept: "*/*", "Content-Type": "application/json" }
    });
    if (!initRes.ok) {
      const errBody = (await initRes.text().catch(() => "")).slice(0, 140);
      throw new Error(
        `Test initialization failed (HTTP ${initRes.status})${errBody ? `: ${errBody}` : "."}`
      );
    }
    await sleep(settings.apiDelayMs, signal);

    let supportedCount = 0;
    let extractedProgress = 0;

    const extractOne = async (item, index, allowEndpointProbe) => {
      throwIfAborted(signal);
      const qId = item?.question?.id;
      const type = item?.question?.type;

      if (!qId || !type) {
        log("warn", `Question #${index + 1} missing id/type; skipped.`);
        extractedProgress++;
        state.current = extractedProgress;
        await publish();
        return;
      }

      let payload = buildDummyPayload(item, type);
      if (!payload) {
        log("warn", `Q#${qId} (${type}) could not construct dummy payload; skipped.`);
        extractedProgress++;
        state.current = extractedProgress;
        await publish();
        return;
      }
      supportedCount++;

      let putUrl = `${origin}/api/study/students/${endpointKind}/${qId}/answer/${type}`;
      let putRes = await apiFetchWithRetry(run, putUrl, {
        method: "PUT",
        headers: { Accept: "*/*", "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (putRes.status === 404 && allowEndpointProbe) {
        const altKind = endpointKind === "review-questions" ? "test-questions" : "review-questions";
        const altUrl = `${origin}/api/study/students/${altKind}/${qId}/answer/${type}`;
        const altRes = await apiFetchWithRetry(run, altUrl, {
          method: "PUT",
          headers: { Accept: "*/*", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (altRes.ok || altRes.status === 422) {
          endpointKind = altKind;
          putUrl = altUrl;
          putRes = altRes;
          log("info", `Detected comprehension endpoint (${endpointKind}) automatically.`);
        }
      }

      if (putRes.status === 422 && type === "description" && payload.answer_code !== "dummy") {
        log("warn", `Q#${qId} rejected starter code (HTTP 422); retrying with fallback value...`);
        payload = { answer_code: "dummy" };
        putRes = await apiFetchWithRetry(run, putUrl, {
          method: "PUT",
          headers: { Accept: "*/*", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      }

      if (!putRes.ok) {
        const errBody = (await putRes.text().catch(() => "")).slice(0, 160);
        throw new Error(
          `Extraction failed on Q#${qId} (HTTP ${putRes.status})${errBody ? `: ${errBody}` : "."}`
        );
      }

      const resJson = await safeParseJson(putRes);
      const inlineAns = extractInlineAnswer(resJson, type);
      if (inlineAns !== null) {
        correctMap.set(String(qId), { id: qId, type, val: inlineAns });
        state.stats.questionsExtracted++;
      }

      extractedProgress++;
      state.current = extractedProgress;
      state.message = `Extracting answer ${extractedProgress}/${questionsList.length}...`;
      await setBadge(`${extractedProgress}/${questionsList.length}`, "#8b5cf6");
      await publish();

      if (settings.apiDelayMs > 0) {
        await sleep(settings.apiDelayMs, signal);
      }
    };

    for (let i = 0; i < questionsList.length; i++) {
      await extractOne(questionsList[i], i, i === 0);
    }

    if (correctMap.size < supportedCount) {
      state.message = "Fetching comprehension test result key...";
      await publish();

      const fetched = await fetchTestResultMap(run, testResultUrl);
      if (fetched) {
        for (const [key, ans] of fetched.answerMap.entries()) {
          if (!correctMap.has(key)) {
            correctMap.set(key, ans);
            state.stats.questionsExtracted++;
          }
        }
      }
    }
  }

  const correctData = [];
  for (const item of questionsList) {
    const qId = item?.question?.id;
    if (!qId) continue;
    const found = correctMap.get(String(qId));
    if (found) correctData.push(found);
  }

  if (correctData.length === 0) {
    throw new Error("Could not extract any correct answers from the test API.");
  }

  log("success", `Extracted ${correctData.length}/${questionsList.length} answers. Resetting test...`);

  state.phase = "reloading";
  state.message = "Refreshing test page to reset attempt...";
  await publish();

  await reloadAndWait(tabId, 20000, signal, expectedHost);
  await sleep(settings.tabSettleDelayMs, signal);

  state.phase = "submitting";
  state.current = 0;
  state.total = correctData.length;
  state.message = `Starting fresh attempt & submitting ${correctData.length} verified answers...`;
  await publish();

  const reinitRes = await apiFetchWithRetry(run, initTestUrl, {
    method: "PUT",
    headers: { Accept: "*/*", "Content-Type": "application/json" }
  });
  if (!reinitRes.ok) {
    const errBody = (await reinitRes.text().catch(() => "")).slice(0, 140);
    throw new Error(
      `Test re-initialization failed (HTTP ${reinitRes.status})${errBody ? `: ${errBody}` : "."}`
    );
  }
  await sleep(settings.apiDelayMs, signal);

  let verifiedCorrectCount = 0;
  let submittedProgress = 0;

  for (const q of correctData) {
    throwIfAborted(signal);
    const putUrl = `${origin}/api/study/students/${endpointKind}/${q.id}/answer/${q.type}`;
    const payload = q.type === "description" ? { answer_code: q.val } : { choice_id: q.val };

    const subRes = await apiFetchWithRetry(run, putUrl, {
      method: "PUT",
      headers: { Accept: "*/*", "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!subRes.ok) {
      const errBody = (await subRes.text().catch(() => "")).slice(0, 160);
      throw new Error(
        `Submission failed on Q#${q.id} (HTTP ${subRes.status})${errBody ? `: ${errBody}` : "."}`
      );
    }

    const subJson = await safeParseJson(subRes);
    if (subJson?.result?.correct === true) {
      verifiedCorrectCount++;
    }
    state.stats.questionsSubmitted++;
    submittedProgress++;
    state.current = submittedProgress;
    state.message = `Submitting answer ${submittedProgress}/${correctData.length}...`;
    await setBadge(`${submittedProgress}/${correctData.length}`, "#10b981");
    await publish();

    if (settings.apiDelayMs > 0) {
      await sleep(settings.apiDelayMs, signal);
    }
  }

  let summaryNote = "";
  if (endpointKind === "test-questions") {
    const finalResult = await fetchTestResultMap(run, testResultUrl);
    if (finalResult?.rawResult) {
      const score = finalResult.rawResult.correct_count;
      const diamond = finalResult.rawResult.diamond;
      if (typeof score === "number") {
        summaryNote = ` (Score: ${score}/${questionsList.length}${typeof diamond === "number" ? `, Diamonds: ${diamond}` : ""})`;
      }
    }
  } else if (verifiedCorrectCount > 0) {
    summaryNote = ` (${verifiedCorrectCount} confirmed correct)`;
  }

  log("success", `Submitted ${correctData.length} answers${summaryNote}.`);
  return { total: questionsList.length, submitted: correctData.length, verified: verifiedCorrectCount };
}

export function buildDummyPayload(item, type) {
  if (type === "description") {
    const nonEmptyDesc = Array.isArray(item.descriptions)
      ? item.descriptions.find((d) => typeof d?.code === "string" && d.code.trim().length > 0)
      : null;
    return { answer_code: nonEmptyDesc ? nonEmptyDesc.code : "dummy" };
  }
  if (type === "choice") {
    const choiceId = item.choices?.[0]?.id;
    if (choiceId === undefined || choiceId === null) return null;
    return { choice_id: choiceId };
  }
  return null;
}

export function extractInlineAnswer(resJson, type) {
  if (!resJson?.result) return null;
  if (type === "description") {
    const ans = resJson.result.model_answer ?? resJson.result.answer_code;
    return ans !== undefined && ans !== null && String(ans).length > 0 ? ans : null;
  }
  if (type === "choice") {
    const correctObj = resJson.result.choices?.find((c) => c.correct === true);
    const id = correctObj?.choice?.id ?? correctObj?.id;
    return id !== undefined && id !== null ? id : null;
  }
  return null;
}

async function fetchTestResultMap(run, testResultUrl) {
  try {
    const res = await apiFetchWithRetry(
      run,
      testResultUrl,
      { method: "GET", headers: { Accept: "application/json, */*" } },
      { maxRetries: 1 }
    );
    if (!res.ok) return null;

    const json = await safeParseJson(res);
    const resultObj = json?.result ?? json;
    if (!resultObj || typeof resultObj !== "object") return null;

    const answerMap = new Map();

    if (Array.isArray(resultObj.choice_results)) {
      for (const cr of resultObj.choice_results) {
        const qId = cr?.question_id;
        if (!qId) continue;
        const correctObj = cr.choices?.find((c) => c.correct === true);
        const correctChoiceId =
          correctObj?.choice?.id ??
          correctObj?.id ??
          (cr.correct === true ? cr.choice_id : null);
        if (correctChoiceId !== undefined && correctChoiceId !== null) {
          answerMap.set(String(qId), { id: qId, type: "choice", val: correctChoiceId });
        }
      }
    }

    if (Array.isArray(resultObj.description_results)) {
      for (const dr of resultObj.description_results) {
        const qId = dr?.question_id;
        if (!qId) continue;
        const ans = dr.model_answer ?? (dr.correct === true ? dr.answer_code : null);
        if (ans !== undefined && ans !== null && String(ans).length > 0) {
          answerMap.set(String(qId), { id: qId, type: "description", val: ans });
        }
      }
    }

    return { answerMap, rawResult: resultObj };
  } catch {
    return null;
  }
}

export function hasAnswersForAllQuestions(questionsList, answerMap) {
  let supported = 0;
  for (const item of questionsList) {
    const qId = item?.question?.id;
    const type = item?.question?.type;
    if (!qId || (type !== "choice" && type !== "description")) continue;
    supported++;
    if (!answerMap.has(String(qId))) return false;
  }
  return supported > 0;
}

async function resolveTestPagePath(tabId, chapterId, chapterMeta) {
  const testType = chapterMeta?.test_type ?? chapterMeta?.chapter?.test_type;
  if (testType) {
    return testType !== "review" ? "test" : "review";
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [chapterId],
      func: (chId) => {
        const links = Array.from(document.querySelectorAll("a[href]")).map(
          (a) => a.getAttribute("href") || ""
        );
        if (links.some((href) => new RegExp(`/chapter/${chId}/test(/|\\?|$)`).test(href))) {
          return "test";
        }
        if (links.some((href) => new RegExp(`/chapter/${chId}/review(/|\\?|$)`).test(href))) {
          return "review";
        }
        return null;
      }
    });
    if (res?.result) return res.result;
  } catch {
    // Ignore DOM inspection errors
  }

  return "review";
}

export async function resolveNextChapter(run, origin, currentChapterId, chapterMeta) {
  const hintedNext = chapterMeta?.next_chapter_id ?? chapterMeta?.nextChapterId;
  const candidates = [];

  if (hintedNext !== undefined && hintedNext !== null) {
    candidates.push(String(hintedNext));
  }

  const numNext = String(parseInt(currentChapterId, 10) + 1);
  if (!candidates.includes(numNext)) {
    candidates.push(numNext);
  }

  const unitMatch = String(currentChapterId).match(/^(\d{3})(\d{3})$/);
  if (unitMatch) {
    const nextUnitFirst = `${parseInt(unitMatch[1], 10) + 1}001`;
    if (!candidates.includes(nextUnitFirst)) {
      candidates.push(nextUnitFirst);
    }
  }

  for (const candidate of candidates) {
    try {
      const res = await apiFetchWithRetry(
        run,
        `${origin}/api/study/chapters/${candidate}`,
        { method: "GET", headers: { Accept: "application/json, */*" } },
        { maxRetries: 0 }
      );
      if (res.ok) {
        return { nextChapterId: candidate, exists: true };
      }
    } catch {
      // Try next candidate
    }
  }

  return { nextChapterId: candidates[0], exists: false };
}
