import { parsePageContext } from "../../shared/constants.js";
import {
  extractApiError,
  mapWithConcurrency,
  safeParseJson,
  sleep,
  throwIfAborted
} from "../../shared/async.js";
import { apiFetchWithRetry } from "../network.js";
import { navigateAndWait, reloadAndWait } from "../tabs.js";

const JSON_GET_HEADERS = { Accept: "application/json, text/plain, */*" };
const JSON_POST_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json"
};

export async function executeSpxWorkflow(run, initialContext, options) {
  const { tabId, signal, settings, state, log, publish, setBadge, finishSuccess, handleError } = run;
  const origin = initialContext.origin;
  const expectedHost = new URL(origin).hostname;

  try {
    log("info", `Started SPX ${state.mode.toUpperCase()} automation on ${origin}.`);
    await setBadge("SPX", "#3b82f6");

    if (options.subjectIdOverride) {
      const targetUrl = `${origin}/subjects/${options.subjectIdOverride}/curriculum`;
      state.phase = "navigating";
      state.message = `Navigating to Subject ${options.subjectIdOverride}...`;
      log("info", state.message);
      await publish();
      await navigateAndWait(tabId, targetUrl, 25000, signal, expectedHost);
      await sleep(settings.tabSettleDelayMs, signal);
    }

    const currentTab = await browser.tabs.get(tabId);
    const ctx = parsePageContext(currentTab.url);
    const subjectId = options.subjectIdOverride || ctx.subjectId;

    if (!subjectId) {
      throw new Error(
        "Could not detect a Subject ID in the URL. Open a /subjects/{id}/curriculum page or enter a Subject # in the popup."
      );
    }

    state.subjectId = subjectId;
    state.chapterId = subjectId;
    state.phase = "curriculum";
    state.message = `Fetching Subject ${subjectId} curriculum...`;
    await publish();

    const processedKeys = new Set();
    let curriculum = await fetchSpxCurriculum(run, origin, subjectId);

    const initialEstimate = countRemainingEligibleSpxItems(curriculum, state.mode, processedKeys);
    state.total = initialEstimate;

    if (initialEstimate === 0) {
      const readyTests = collectUnlockedSpxTests(curriculum);
      if (state.mode === "spx_no_tests" && readyTests.length > 0) {
        const names = readyTests.map((t) => `"${t.title}"`).join(", ");
        await finishSuccess(
          `All unlocked chapters & reviews are done. ${readyTests.length} test(s) ready: ${names}.`
        );
      } else if (state.mode === "spx_tests") {
        await finishSuccess(`No unlocked tests remaining in Subject ${subjectId}.`);
      } else {
        await finishSuccess(`All accessible items in Subject ${subjectId} are already completed!`);
      }
      return;
    }

    log("info", `Subject ${subjectId}: Found ${initialEstimate} accessible item(s) to process.`);
    await publish();

    while (!signal.aborted) {
      throwIfAborted(signal);

      const nextItem = pickNextSpxItem(curriculum, state.mode, processedKeys);
      if (!nextItem) break;

      const key = `${nextItem.item_type}:${nextItem.id}`;
      processedKeys.add(key);

      const doneSoFar =
        state.stats.lecturesCompleted +
        state.stats.questionsSubmitted +
        state.stats.chaptersCompleted;
      const remainingEstimate = countRemainingEligibleSpxItems(curriculum, state.mode, processedKeys);
      state.total = Math.max(state.total, doneSoFar + remainingEstimate + 1);
      state.current = doneSoFar + 1;

      const labelMap = { chapter: "Chapter", review: "Review", test: "Test" };
      const phaseMap = { chapter: "chapters", review: "reviews", test: "tests" };
      state.phase = phaseMap[nextItem.item_type] || "running";
      state.message = `Processing ${labelMap[nextItem.item_type]} #${nextItem.id}: ${nextItem.title} (${state.current}/${state.total})...`;
      await setBadge(`${state.current}/${state.total}`, "#3b82f6");
      await publish();

      if (nextItem.item_type === "chapter") {
        await completeSpxChapter(run, origin, nextItem);
      } else if (nextItem.item_type === "review") {
        await completeSpxReview(run, origin, nextItem);
      } else if (nextItem.item_type === "test") {
        await completeSpxTest(run, origin, nextItem);
      }

      await publish();
      if (settings.apiDelayMs > 0) {
        await sleep(settings.apiDelayMs, signal);
      }

      curriculum = await fetchSpxCurriculum(run, origin, subjectId);
    }

    const unlockUrl = `${origin}/api/v1/subjects/${subjectId}/achievements/unlock`;
    const unlockRes = await apiFetchWithRetry(
      run,
      unlockUrl,
      {
        method: "POST",
        headers: JSON_POST_HEADERS,
        body: JSON.stringify({})
      },
      { maxRetries: 0 }
    ).catch(() => null);

    if (unlockRes?.ok) {
      const unlockJson = await safeParseJson(unlockRes);
      const unlockedList = unlockJson?.data?.unlocked;
      if (Array.isArray(unlockedList) && unlockedList.length > 0) {
        log("success", `Unlocked ${unlockedList.length} achievement(s)!`);
      }
    }

    state.phase = "reloading";
    state.message = "Refreshing curriculum page...";
    await publish();
    await reloadAndWait(tabId, 20000, signal, expectedHost);
    await sleep(settings.tabSettleDelayMs, signal);

    const summary = `Done! Chapters: ${state.stats.lecturesCompleted}, Reviews: ${state.stats.questionsSubmitted}, Tests: ${state.stats.chaptersCompleted}.`;
    if (state.mode === "spx_no_tests") {
      const readyTests = collectUnlockedSpxTests(curriculum);
      if (readyTests.length > 0) {
        const testNames = readyTests.map((t) => `"${t.title}"`).join(", ");
        await finishSuccess(`${summary} Test(s) unlocked: ${testNames}.`);
        return;
      }
    }
    await finishSuccess(summary);
  } catch (err) {
    await handleError(err);
  }
}

async function completeSpxChapter(run, origin, item) {
  const { signal, settings, state, log, publish } = run;

  const blocksUrl = `${origin}/api/v1/chapters/${item.id}/blocks`;
  const blocksRes = await apiFetchWithRetry(run, blocksUrl, {
    method: "GET",
    headers: JSON_GET_HEADERS
  });
  const blocksJson = await safeParseJson(blocksRes);
  if (!blocksRes.ok || !blocksJson || blocksJson.success === false) {
    throw new Error(
      `Failed loading Chapter #${item.id} blocks: ${extractApiError(blocksJson, blocksRes.status)}`
    );
  }

  const clearedIds = new Set(
    Array.isArray(blocksJson?.data?.chapter?.cleared_block_ids)
      ? blocksJson.data.chapter.cleared_block_ids
      : []
  );

  const allBlocks = Array.isArray(blocksJson?.data?.blocks) ? blocksJson.data.blocks : [];
  const pendingQuestions = allBlocks.filter(
    (b) =>
      !clearedIds.has(b.id) &&
      (b.type === "question" || (b.question && Array.isArray(b.options) && b.options.length > 0))
  );

  if (pendingQuestions.length > 0) {
    log("info", `Chapter #${item.id}: Answering ${pendingQuestions.length} question block(s)...`);
    await publish();

    const answerUrl = `${origin}/api/v1/chapters/${item.id}/answer`;

    for (let qIdx = 0; qIdx < pendingQuestions.length; qIdx++) {
      throwIfAborted(signal);
      const block = pendingQuestions[qIdx];
      state.message = `Chapter #${item.id}: Answering question ${qIdx + 1}/${pendingQuestions.length}...`;
      await publish();

      const options = Array.isArray(block.options) ? block.options : [];
      if (options.length === 0) {
        const qType = block.question?.type || block.type || "unknown";
        throw new Error(
          `Chapter #${item.id} question block #${block.id} (type: "${qType}") has no MCQ options and cannot be auto-solved yet.`
        );
      }

      let solved = false;
      for (let optIdx = 0; optIdx < options.length; optIdx++) {
        throwIfAborted(signal);
        const opt = options[optIdx];

        const ansRes = await apiFetchWithRetry(run, answerUrl, {
          method: "POST",
          headers: JSON_POST_HEADERS,
          body: JSON.stringify({
            block_id: block.id,
            selected_option_id: opt.id,
            hint_used: 0
          })
        });

        const ansJson = await safeParseJson(ansRes);
        if (!ansRes.ok || !ansJson || ansJson.success === false) {
          throw new Error(
            `Chapter #${item.id} answer failed on block #${block.id}: ${extractApiError(ansJson, ansRes.status)}`
          );
        }

        if (ansJson?.data?.is_correct === true) {
          solved = true;
          break;
        }

        if (optIdx < options.length - 1 && settings.apiDelayMs > 0) {
          await sleep(settings.apiDelayMs, signal);
        }
      }

      if (!solved) {
        throw new Error(
          `Could not find the correct option for Chapter #${item.id} question block #${block.id}.`
        );
      }

      if (settings.apiDelayMs > 0) {
        await sleep(settings.apiDelayMs, signal);
      }
    }
  }

  const completeUrl = `${origin}/api/v1/chapters/${item.id}/complete`;
  const completeRes = await apiFetchWithRetry(run, completeUrl, {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify({})
  });

  const resJson = await safeParseJson(completeRes);
  if (!completeRes.ok || !resJson || resJson.success === false) {
    throw new Error(
      `Failed completing Chapter #${item.id} ("${item.title}"): ${extractApiError(resJson, completeRes.status)}`
    );
  }

  const stars = resJson?.data?.star_score;
  state.stats.lecturesCompleted++;
  log(
    "success",
    `Chapter #${item.id} ("${item.title}") completed${typeof stars === "number" ? ` (Stars: ${stars})` : ""}.`
  );
}

async function completeSpxReview(run, origin, item) {
  const { state, log } = run;

  const itemsUrl = `${origin}/api/v1/reviews/${item.id}/items`;
  const itemsRes = await apiFetchWithRetry(run, itemsUrl, {
    method: "GET",
    headers: JSON_GET_HEADERS
  });
  const itemsJson = await safeParseJson(itemsRes);
  if (!itemsRes.ok || !itemsJson || itemsJson.success === false) {
    throw new Error(
      `Failed loading Review #${item.id} items: ${extractApiError(itemsJson, itemsRes.status)}`
    );
  }

  const completeUrl = `${origin}/api/v1/reviews/${item.id}/complete`;
  const completeRes = await apiFetchWithRetry(run, completeUrl, {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify({})
  });

  const resJson = await safeParseJson(completeRes);
  if (!completeRes.ok || !resJson || resJson.success === false) {
    throw new Error(
      `Failed completing Review #${item.id} ("${item.title}"): ${extractApiError(resJson, completeRes.status)}`
    );
  }

  state.stats.questionsSubmitted++;
  log("success", `Review #${item.id} ("${item.title}") completed.`);
}

async function completeSpxTest(run, origin, item) {
  const { signal, settings, state, log, publish } = run;
  const testId = item.id;
  const startUrl = `${origin}/api/v1/tests/${testId}/start`;
  const submitUrl = `${origin}/api/v1/tests/${testId}/submit`;

  state.message = `Test #${testId} (${item.title}): Starting extraction pass...`;
  await publish();

  const startRes1 = await apiFetchWithRetry(run, startUrl, {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify({})
  });
  const startJson1 = await safeParseJson(startRes1);
  if (!startRes1.ok || !startJson1 || startJson1.success === false) {
    throw new Error(
      `Failed starting Test #${testId}: ${extractApiError(startJson1, startRes1.status)}`
    );
  }

  const startData1 = startJson1?.data || {};
  const tqList1 = [...(startData1.test_questions || [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  if (tqList1.length === 0) {
    throw new Error(`Test #${testId} returned no questions.`);
  }

  const existingRespMap = new Map();
  for (const qr of startData1.question_responses || []) {
    existingRespMap.set(qr.test_question_id, qr);
  }

  let answerByQuestionId = extractSpxTestAnswerMap(startData1);

  if (answerByQuestionId.size < tqList1.length) {
    const toAnswer = [];
    for (const tq of tqList1) {
      const qId = tq.question_id;
      const qObj = startData1.questions?.[String(qId)];
      const opts = startData1.options?.[String(qId)];

      if (!Array.isArray(opts) || opts.length === 0) {
        const qType = qObj?.type || "unknown";
        throw new Error(
          `Test #${testId} question #${qId} (type: "${qType}") has no MCQ options and cannot be auto-solved yet.`
        );
      }

      const prevQr = existingRespMap.get(tq.id);
      if (prevQr?.status === "answered" && prevQr.selected_option_id != null) {
        continue;
      }
      toAnswer.push({ tq, qId, optionId: opts[0].id });
    }

    let extractedCount = 0;
    await mapWithConcurrency(
      toAnswer,
      settings.concurrency,
      async ({ tq, qId, optionId }) => {
        throwIfAborted(signal);
        const ansUrl = `${origin}/api/v1/tests/${testId}/questions/${tq.id}/answer`;
        const ansRes = await apiFetchWithRetry(run, ansUrl, {
          method: "PUT",
          headers: JSON_POST_HEADERS,
          body: JSON.stringify({ selected_option_id: optionId })
        });
        const ansJson = await safeParseJson(ansRes);
        if (!ansRes.ok || !ansJson || ansJson.success === false) {
          throw new Error(
            `Test #${testId} answer failed on Q#${qId}: ${extractApiError(ansJson, ansRes.status)}`
          );
        }

        extractedCount++;
        state.message = `Test #${testId}: Extracting answers (${extractedCount}/${toAnswer.length})...`;
        await publish();

        if (settings.apiDelayMs > 0) {
          await sleep(settings.apiDelayMs, signal);
        }
      },
      signal
    );

    const submitRes1 = await apiFetchWithRetry(run, submitUrl, {
      method: "POST",
      headers: JSON_POST_HEADERS,
      body: JSON.stringify({})
    });
    const submitJson1 = await safeParseJson(submitRes1);
    if (!submitRes1.ok || !submitJson1 || submitJson1.success === false) {
      throw new Error(
        `Test #${testId} dummy submit failed: ${extractApiError(submitJson1, submitRes1.status)}`
      );
    }

    const submitData1 = submitJson1?.data || {};
    answerByQuestionId = extractSpxTestAnswerMap(submitData1);

    if (answerByQuestionId.size === 0) {
      throw new Error(`Test #${testId}: Could not extract any correct options from submit result.`);
    }

    if (submitData1.response?.total_score === 100 && submitData1.response?.passed === true) {
      state.stats.chaptersCompleted++;
      log("success", `Test #${testId} ("${item.title}") passed with 100%!`);
      return;
    }

    log(
      "info",
      `Test #${testId}: Extracted ${answerByQuestionId.size}/${tqList1.length} answers (Pass 1: ${submitData1.response?.total_score ?? "?"}%). Retaking for 100%...`
    );
    if (settings.apiDelayMs > 0) {
      await sleep(settings.apiDelayMs, signal);
    }
  }

  // PASS 2: Start fresh attempt and submit 100% verified answers concurrently
  const startRes2 = await apiFetchWithRetry(run, startUrl, {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify({})
  });
  const startJson2 = await safeParseJson(startRes2);
  if (!startRes2.ok || !startJson2 || startJson2.success === false) {
    throw new Error(
      `Failed starting retake for Test #${testId}: ${extractApiError(startJson2, startRes2.status)}`
    );
  }

  const startData2 = startJson2?.data || {};
  const tqList2 = [...(startData2.test_questions || [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );

  let submittedCount = 0;
  await mapWithConcurrency(
    tqList2,
    settings.concurrency,
    async (tq) => {
      throwIfAborted(signal);
      const correctOptionId = answerByQuestionId.get(String(tq.question_id));
      if (correctOptionId === undefined || correctOptionId === null) {
        throw new Error(`Test #${testId}: Missing extracted answer for question #${tq.question_id}.`);
      }

      const ansUrl = `${origin}/api/v1/tests/${testId}/questions/${tq.id}/answer`;
      const ansRes = await apiFetchWithRetry(run, ansUrl, {
        method: "PUT",
        headers: JSON_POST_HEADERS,
        body: JSON.stringify({ selected_option_id: correctOptionId })
      });
      const ansJson = await safeParseJson(ansRes);
      if (!ansRes.ok || !ansJson || ansJson.success === false) {
        throw new Error(
          `Test #${testId} submission failed on Q#${tq.question_id}: ${extractApiError(ansJson, ansRes.status)}`
        );
      }

      submittedCount++;
      state.message = `Test #${testId}: Submitting verified answer ${submittedCount}/${tqList2.length}...`;
      await publish();

      if (settings.apiDelayMs > 0) {
        await sleep(settings.apiDelayMs, signal);
      }
    },
    signal
  );

  const submitRes2 = await apiFetchWithRetry(run, submitUrl, {
    method: "POST",
    headers: JSON_POST_HEADERS,
    body: JSON.stringify({})
  });
  const submitJson2 = await safeParseJson(submitRes2);
  if (!submitRes2.ok || !submitJson2 || submitJson2.success === false) {
    throw new Error(
      `Test #${testId} final submit failed: ${extractApiError(submitJson2, submitRes2.status)}`
    );
  }

  const finalResp = submitJson2?.data?.response || {};
  const finalScore = finalResp.total_score;
  const passed = finalResp.passed;

  if (passed === false) {
    throw new Error(`Test #${testId} ("${item.title}") did not pass (score: ${finalScore ?? "?"}%).`);
  }

  state.stats.chaptersCompleted++;
  log("success", `Test #${testId} ("${item.title}") completed! Score: ${finalScore ?? 100}% (Passed).`);
}

export function extractSpxTestAnswerMap(data) {
  const map = new Map();
  const optionsByQ = data?.options;
  if (!optionsByQ || typeof optionsByQ !== "object") return map;

  for (const [qId, optList] of Object.entries(optionsByQ)) {
    if (!Array.isArray(optList)) continue;
    const correctOpt = optList.find((o) => o.is_correct === true);
    if (correctOpt?.id !== undefined && correctOpt?.id !== null) {
      map.set(String(qId), correctOpt.id);
    }
  }
  return map;
}

async function fetchSpxCurriculum(run, origin, subjectId) {
  const url = `${origin}/api/v1/subjects/${subjectId}/curriculum`;
  const res = await apiFetchWithRetry(run, url, {
    method: "GET",
    headers: JSON_GET_HEADERS
  });
  const json = await safeParseJson(res);
  if (!res.ok || !json?.success || !Array.isArray(json?.data)) {
    throw new Error(
      `Failed to fetch Subject ${subjectId} curriculum: ${extractApiError(json, res.status)}`
    );
  }
  return json.data;
}

export function isSpxItemEligibleForMode(itemType, mode) {
  if (mode === "lectures") return itemType === "chapter";
  if (mode === "review") return itemType === "review";
  if (mode === "spx_tests") return itemType === "test";
  if (mode === "spx_no_tests") return itemType === "chapter" || itemType === "review";
  return itemType === "chapter" || itemType === "review" || itemType === "test";
}

export function getSpxUnitSections(unit) {
  if (Array.isArray(unit.sections) && unit.sections.length > 0) {
    return unit.sections;
  }
  if (Array.isArray(unit.items)) {
    return [{ id: 0, items: unit.items }];
  }
  return [];
}

export function pickNextSpxItem(units, mode, processedKeys) {
  let fallback = null;

  for (const unit of units) {
    if (unit.is_accessible === false) continue;
    for (const section of getSpxUnitSections(unit)) {
      for (const item of section.items || []) {
        if (item.is_completed) continue;
        if (!item.is_unlocked) continue;
        if (!isSpxItemEligibleForMode(item.item_type, mode)) continue;
        const key = `${item.item_type}:${item.id}`;
        if (processedKeys.has(key)) continue;

        if (item.is_current) return item;
        if (!fallback) fallback = item;
      }
    }
  }

  return fallback;
}

export function countRemainingEligibleSpxItems(units, mode, processedKeys) {
  let count = 0;

  for (const unit of units) {
    if (unit.is_accessible === false) continue;
    for (const section of getSpxUnitSections(unit)) {
      const items = section.items || [];
      if (mode === "full") {
        for (const item of items) {
          if (item.is_completed) continue;
          const key = `${item.item_type}:${item.id}`;
          if (processedKeys.has(key)) continue;
          if (isSpxItemEligibleForMode(item.item_type, mode)) count++;
        }
      } else if (mode === "spx_tests") {
        for (const item of items) {
          if (item.item_type === "test" && item.is_unlocked && !item.is_completed) {
            const key = `test:${item.id}`;
            if (!processedKeys.has(key)) count++;
          }
        }
      } else {
        const hasUnlockedIncomplete = items.some(
          (it) => it.is_unlocked && !it.is_completed && !processedKeys.has(`${it.item_type}:${it.id}`)
        );
        if (!hasUnlockedIncomplete) continue;
        for (const item of items) {
          if (item.item_type === "test") {
            if (!item.is_completed) break;
            continue;
          }
          if (item.is_completed) continue;
          if (processedKeys.has(`${item.item_type}:${item.id}`)) continue;
          if (isSpxItemEligibleForMode(item.item_type, mode)) count++;
        }
      }
    }
  }

  return count;
}

export function collectUnlockedSpxTests(units) {
  const tests = [];
  for (const unit of units) {
    if (unit.is_accessible === false) continue;
    for (const section of getSpxUnitSections(unit)) {
      for (const item of section.items || []) {
        if (item.item_type === "test" && item.is_unlocked && !item.is_completed) {
          tests.push(item);
        }
      }
    }
  }
  return tests;
}
