export function createAbortError(reason) {
  const err = new Error(reason instanceof Error ? reason.message : String(reason || "Aborted"));
  err.name = "AbortError";
  return err;
}

export function isAbortError(err) {
  return err?.name === "AbortError";
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

export function sleep(ms, signal) {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLinkedAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason || new Error("Aborted"));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

export async function safeParseJson(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractApiError(resJson, status) {
  if (!resJson || typeof resJson !== "object") return `HTTP ${status}`;
  if (typeof resJson.message === "string" && resJson.message) return resJson.message;
  if (typeof resJson.error === "string" && resJson.error) return resJson.error;
  if (resJson.error && typeof resJson.error === "object") {
    return resJson.error.message || resJson.error.code || JSON.stringify(resJson.error);
  }
  return `HTTP ${status}`;
}
