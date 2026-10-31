// Every registry, advisory and provenance request the evaluator and the update
// make goes through here, so deadlines and retries are one policy. A deadline
// covers the response body as well as the headers: a server that trickles bytes
// can't hold the hourly evaluation, or a machine's update lock, for hours.
// Transport failures, timeouts and 408/425/429/5xx are retried with backoff and
// jitter, honoring Retry-After within the overall deadline; anything else fails.

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** The body, read under the request's signal (aborting it ends the read), refusing more than `maxBytes`. */
async function readBody(response, maxBytes, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(`response of ${declared} bytes is over the ${maxBytes}-byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const abort = () => reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpError(`response is over the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return Buffer.concat(chunks);
}

const transient = (error) => error instanceof HttpError ? error.retryable : !(error instanceof SyntaxError);

/**
 * fetch with a per-attempt deadline (headers and body), an overall deadline across
 * attempts, and bounded retries. `as`: "json" (default), "text" or "bytes".
 * `notFound: "null"` returns null for a 404 instead of failing; use it only where
 * absence is a real answer (a package npm doesn't have), never for data a check needs.
 */
export async function request(url, {
  method = "GET",
  headers = {},
  body,
  as = "json",
  notFound = "throw",
  timeoutMs = 60_000,
  deadlineMs = 5 * 60_000,
  attempts = 4,
  maxBytes = 256 << 20,
  backoffMs = 1000,
  label = url,
} = {}) {
  const started = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) break;
    let wait = backoffMs * 2 ** (attempt - 1) * (1 + Math.random() / 2);
    try {
      const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining));
      const response = await fetch(url, { method, headers, body, signal });
      if (response.ok) {
        const bytes = await readBody(response, maxBytes, signal);
        if (as === "bytes") return bytes;
        const text = bytes.toString("utf8");
        return as === "text" ? text : JSON.parse(text);
      }
      await response.body?.cancel().catch(() => {});
      if (response.status === 404 && notFound === "null") return null;
      const retryable = RETRY_STATUS.has(response.status);
      last = new HttpError(`${label} answered ${response.status}`, { status: response.status, retryable });
      if (!retryable) throw last;
      const asked = retryAfterMs(response.headers.get("retry-after"));
      if (asked !== null) wait = asked + Math.random() * 250;
    } catch (error) {
      if (!transient(error)) throw error;
      if (!(error instanceof HttpError)) last = new HttpError(`${label}: ${error.cause?.code ?? error.name}: ${error.message}`, { retryable: true });
    }
    if (attempt === attempts) break;
    if (Date.now() - started + wait >= deadlineMs) {
      throw new HttpError(`${last.message}; giving up, a retry wouldn't fit in ${Math.round(deadlineMs / 1000)}s`, { status: last.status });
    }
    await sleep(wait);
  }
  throw last ?? new HttpError(`${label}: no answer within ${Math.round(deadlineMs / 1000)}s`);
}
