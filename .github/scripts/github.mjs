// A small GitHub REST client for the alert job: every list is read to its last
// page, and rate limits (429, or a 403 that says so) and server errors are
// retried after Retry-After or the rate-limit reset, within bounds, so a busy
// hour delays a notification instead of losing it. Creating an issue or a
// comment isn't idempotent: after a failure that may have landed anyway (a lost
// response, a 5xx) it's retried only once the caller's `landed` check (its
// marker, reconcile.mjs) finds it isn't there, and never blindly. Injectable
// fetch and sleep for tests (test/pipeline-issues.test.mjs).

import { retryAfterMs } from "../../lib/http.mjs";

const PER_PAGE = 100;
const MAX_PAGES = 100;

/** How long GitHub asks to wait before retrying `response`, in ms, or null. */
function askedWait(response, now) {
  const after = retryAfterMs(response.headers.get("retry-after"), now());
  if (after !== null) return after;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) return Math.max(0, reset * 1000 - now());
  return null;
}

export function githubClient({
  token,
  repo,
  api = "https://api.github.com",
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  attempts = 5,
  maxWaitMs = 5 * 60_000,
  timeoutMs = 30_000,
  dryRun = false,
  log = console.log,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("GH_REPO must be owner/name");
  if (!token && !dryRun) throw new Error("GH_TOKEN is not set");

  /**
   * One request, retried within bounds. `create`: it makes something (not
   * idempotent); after a failure that may have gone through (no response, a 5xx)
   * `landed()` is asked before it's repeated, and what it finds is the answer.
   * Without `landed`, such a request isn't repeated.
   */
  async function call(method, path, body, { create = false, landed = null } = {}) {
    if (dryRun && method !== "GET") {
      log(`[dry run] ${method} ${path}${body?.title ? ` ${body.title}` : ""}${body?.state ? ` -> ${body.state}` : ""}`);
      return method === "POST" && path.endsWith("/issues") ? { number: 0, title: body.title, body: body.body } : null;
    }
    // A creation that may have gone through is repeated only once `landed` (asked after the wait, so it shows) finds nothing.
    const mayRepeat = (why) => {
      if (create && !landed) throw new Error(`GitHub ${method} ${path}: ${why}; not retried, since it may have gone through`);
    };
    const alreadyThere = async () => (create ? ((await landed()) ?? null) : null);
    for (let attempt = 1; ; attempt++) {
      let response;
      let wait = 1000 * 2 ** (attempt - 1);
      try {
        response = await fetch(`${api}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= attempts) throw new Error(`GitHub ${method} ${path}: ${error.message}`);
        mayRepeat(error.message);
        await sleep(wait);
        const found = await alreadyThere();
        if (found) return found;
        continue;
      }
      if (response.ok) return response.status === 204 ? null : response.json();
      const text = (await response.text().catch(() => "")).slice(0, 300);
      const limited = response.status === 429 || (response.status === 403 && (askedWait(response, now) !== null || /rate limit/i.test(text)));
      if (!(limited || response.status >= 500) || attempt >= attempts) {
        const error = new Error(`GitHub ${method} ${path} answered ${response.status}: ${text}`);
        error.status = response.status;
        throw error;
      }
      wait = askedWait(response, now) ?? wait;
      if (wait > maxWaitMs) throw new Error(`GitHub ${method} ${path} is rate limited for ${Math.round(wait / 1000)}s; try again later`);
      // A rate-limited request wasn't served; a server error may have been.
      if (!limited) mayRepeat(`answered ${response.status}`);
      await sleep(wait);
      const found = limited ? null : await alreadyThere();
      if (found) return found;
    }
  }

  async function all(path) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitHub GET ${path} didn't answer a list`);
      items.push(...batch);
      if (batch.length < PER_PAGE) return items;
    }
    throw new Error(`GitHub GET ${path} has more than ${MAX_PAGES} pages`);
  }

  const base = `/repos/${repo}`;
  return {
    /** Every open issue (not pull requests), all pages. */
    openIssues: async () => (await all(`${base}/issues?state=open`)).filter((issue) => !issue.pull_request),
    comments: (number) => all(`${base}/issues/${number}/comments`),
    /** `landed()`: the issue, if an attempt that seemed to fail created it after all. */
    createIssue: (fields, { landed } = {}) => call("POST", `${base}/issues`, fields, { create: true, landed }),
    updateIssue: (number, fields) => call("PATCH", `${base}/issues/${number}`, fields),
    /** `landed()`: the comment, if an attempt that seemed to fail posted it after all. */
    comment: (number, body, { landed } = {}) => call("POST", `${base}/issues/${number}/comments`, { body }, { create: true, landed }),
    async ensureLabel(name, color, description) {
      try {
        await call("POST", `${base}/labels`, { name, color, description });
      } catch (error) {
        if (error.status !== 422) throw error; // 422: it exists already
      }
    },
  };
}
