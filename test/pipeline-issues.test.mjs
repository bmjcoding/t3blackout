// node --test test/*.test.mjs: the alert job's GitHub issues
// (.github/scripts/reconcile.mjs, github.mjs) against a fake GitHub: ownership
// and channel scope, every affected package, any advisory namespace, delivery
// before the marker moves, pagination, held-issue identity, inert text.
import { test } from "node:test";
import assert from "node:assert/strict";

import { githubClient } from "../.github/scripts/github.mjs";
import { BOT, code, codeBlock, markerOf, readMarker, reconcileAdvisories, reconcileHeld } from "../.github/scripts/reconcile.mjs";

const bot = { login: BOT, type: "Bot" };
const human = { login: "someone", type: "User" };
const quiet = { log: () => {} };

/** An in-memory GitHub; `failComments` makes that many comment posts fail first. */
function fakeGitHub(issues = [], { failComments = 0, failUpdates = 0 } = {}) {
  let next = 100;
  const state = { issues: issues.map((issue) => ({ state: "open", user: bot, labels: [], comments: [], ...issue })), created: 0 };
  const find = (number) => state.issues.find((issue) => issue.number === number);
  const gh = {
    openIssues: async () => state.issues.filter((issue) => issue.state === "open").map(({ comments, ...issue }) => structuredClone(issue)),
    comments: async (number) => structuredClone(find(number).comments),
    createIssue: async ({ title, body, labels = [] }) => {
      state.created++;
      const issue = { number: next++, title, body, labels: labels.map((name) => ({ name })), state: "open", user: bot, comments: [] };
      state.issues.push(issue);
      return issue;
    },
    updateIssue: async (number, fields) => {
      if (failUpdates-- > 0) throw new Error("GitHub PATCH answered 502");
      Object.assign(find(number), fields);
    },
    comment: async (number, body) => {
      if (failComments-- > 0) throw new Error("GitHub POST answered 429: rate limited; try again later");
      find(number).comments.push({ user: bot, body });
    },
    ensureLabel: async () => {},
  };
  return { gh, state, find, open: () => state.issues.filter((issue) => issue.state === "open") };
}

const advisory = (id, pkgs, severity = "HIGH", summary = `${id} summary`) => ({
  id,
  aliases: [],
  summary,
  severity,
  url: "https://attacker.example/ignored",
  packages: pkgs.map((pkg) => ({ pkg, fixed: ["9.9.9"] })),
});
const report = (open, channel = "nightly", release = "v0.1.6-nightly.20261030.3917", gaps = []) => ({ checkedAt: "2026-10-30T20:00:00Z", channel, release, sha: "0".repeat(40), packages: 100, gaps, open });

test("one issue per channel and affected package, for every package an advisory names (PIPE-14)", async () => {
  const github = fakeGitHub();
  await reconcileAdvisories(report([advisory("GHSA-aaaa", ["alpha@1.0.0", "beta@2.0.0", "alpha@1.1.0"])]), github.gh, quiet);
  assert.deepEqual(github.open().map((issue) => issue.title).sort(), ["[security] alpha (nightly)", "[security] beta (nightly)"]);
  for (const issue of github.open()) assert.deepEqual(readMarker(issue.body).ids, ["GHSA-aaaa"]);
});

test("only the automation's own issues for this channel are touched (PIPE-08)", async () => {
  const github = fakeGitHub([
    { number: 1, title: "[security] undici", user: human, body: "please look", labels: [{ name: "security" }] },
    { number: 2, title: "[security] undici (stable)", body: `x\n\n${markerOf({ kind: "package", channel: "stable", package: "undici", ids: ["GHSA-s"], notified: ["GHSA-s"] })}` },
    { number: 3, title: "[security] Moderate and low advisories (stable)", body: `x\n\n${markerOf({ kind: "rolling", channel: "stable", ids: ["GHSA-m"] })}` },
    { number: 4, title: "[security] zod (nightly)", user: human, body: `copied\n\n${markerOf({ kind: "package", channel: "nightly", package: "zod", ids: [], notified: [] })}` },
  ]);
  await reconcileAdvisories(report([]), github.gh, quiet);
  assert.deepEqual(github.open().map((issue) => issue.number), [1, 2, 3, 4]);
  assert.ok(github.state.issues.every((issue) => issue.comments.length === 0));
});

test("an advisory is announced once, whatever its id namespace (PIPE-15)", async () => {
  const github = fakeGitHub();
  const first = report([advisory("GHSA-aaaa", ["alpha@1.0.0"])]);
  await reconcileAdvisories(first, github.gh, quiet);
  const added = report([advisory("GHSA-aaaa", ["alpha@1.0.0"]), advisory("MAL-2026-12345", ["alpha@1.0.0"], "CRITICAL")]);
  for (let run = 0; run < 3; run++) await reconcileAdvisories(added, github.gh, quiet);
  const [issue] = github.open();
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].body, /MAL-2026-12345/);
  assert.deepEqual(readMarker(issue.body).notified, ["GHSA-aaaa", "MAL-2026-12345"]);
});

test("a notification that fails isn't recorded as sent, and a retry doesn't send it twice (PIPE-11)", async () => {
  const github = fakeGitHub([], { failComments: 1 });
  await reconcileAdvisories(report([advisory("GHSA-aaaa", ["alpha@1.0.0"])]), github.gh, quiet);
  const next = report([advisory("GHSA-aaaa", ["alpha@1.0.0"]), advisory("GHSA-bbbb", ["alpha@1.0.0"])]);
  await assert.rejects(reconcileAdvisories(next, github.gh, quiet), /429/);
  const [issue] = github.open();
  assert.deepEqual(readMarker(issue.body).notified, ["GHSA-aaaa"], "still owed");
  // The comment goes out, but recording it fails: the next run must not post it again.
  const flaky = fakeGitHub([issue], { failUpdates: 1 });
  await assert.rejects(reconcileAdvisories(next, flaky.gh, quiet), /502/);
  await reconcileAdvisories(next, flaky.gh, quiet);
  const [after] = flaky.open();
  assert.equal(after.comments.length, 1);
  assert.deepEqual(readMarker(after.body).notified, ["GHSA-aaaa", "GHSA-bbbb"]);
});

test("issues close once main's pin is clear of them, saying which advisories went", async () => {
  const github = fakeGitHub();
  await reconcileAdvisories(report([advisory("GHSA-aaaa", ["alpha@1.0.0"]), advisory("GHSA-low", ["gamma@1.0.0"], "LOW")]), github.gh, quiet);
  await reconcileAdvisories(report([], "nightly", "v0.1.7-nightly.20261031.4001"), github.gh, quiet);
  assert.equal(github.open().length, 0);
  const alpha = github.state.issues.find((issue) => issue.title.startsWith("[security] alpha"));
  assert.match(alpha.comments.at(-1).body, /^Fixed: `v0\.1\.7-nightly\.20261031\.4001` no longer has GHSA-aaaa\./);
  assert.equal(alpha.state_reason, "completed");
});

test("issues opened before the marker are adopted, not duplicated", async () => {
  const github = fakeGitHub([
    { number: 10, title: "[security] zod", labels: [{ name: "security" }], body: "- **HIGH** [GHSA-mrhx-c7xc-m3w5](https://osv.dev/vulnerability/GHSA-mrhx-c7xc-m3w5): zod" },
    { number: 12, title: "[security] Moderate and low advisories (nightly)", labels: [{ name: "security" }], body: "old" },
  ]);
  await reconcileAdvisories(report([advisory("GHSA-mrhx-c7xc-m3w5", ["zod@4.6.5"]), advisory("GHSA-low", ["gamma@1.0.0"], "MODERATE")]), github.gh, quiet);
  assert.equal(github.state.created, 0);
  assert.equal(github.find(10).title, "[security] zod (nightly)");
  assert.equal(github.find(10).comments.length, 0, "already announced in the old body");
  assert.equal(readMarker(github.find(12).body).kind, "rolling");
});

test("outside text is inert: no mentions, links, HTML or line breaks reach the issue (PIPE-18)", async () => {
  const github = fakeGitHub();
  const evil = "Fix\n\n@repo-owner [Install this fix](https://evil.example/x) <img src=x> `code` " + "x".repeat(5000);
  await reconcileAdvisories(report([advisory("GHSA-aaaa", ["alpha@1.0.0"], "HIGH", evil), advisory("bad id](https://evil.example)", ["alpha@1.0.0"])]), github.gh, quiet);
  const [issue] = github.open();
  // Outside code spans and the hidden marker (an HTML comment, never rendered).
  const outsideCode = issue.body.replace(/(`+)[^`][\s\S]*?\1/g, "").replace(/<!-- t3blackout \{[^\n]*\} -->$/, "");
  assert.doesNotMatch(outsideCode, /@repo-owner|evil\.example|<img/);
  assert.match(issue.body, /\[GHSA-aaaa\]\(https:\/\/osv\.dev\/vulnerability\/GHSA-aaaa\)/, "links are ours, built from the id");
  assert.ok(issue.body.length < 10_000);
  assert.equal(code("a\nb``c", 100), "```a b``c```");
  assert.equal(code("`x`"), "`` `x` ``");
  assert.match(codeBlock("```\n@someone\n````"), /^`````text\n```\n@someone\n````\n`````$/);
  const many = report(Array.from({ length: 400 }, (_, i) => advisory(`GHSA-${i}`, ["alpha@1.0.0"], "LOW", "y".repeat(300))));
  await reconcileAdvisories(many, github.gh, quiet);
  const rolling = github.open().find((issue) => readMarker(issue.body)?.kind === "rolling");
  assert.ok(rolling.body.length <= 60_000 && /…and \d+ more/.test(rolling.body));
  assert.equal(readMarker(rolling.body).ids.length, 400);
});

test("a malformed report is refused before anything changes", async () => {
  const github = fakeGitHub();
  await assert.rejects(reconcileAdvisories({ channel: "nightly", release: "x", gaps: [], open: [{ id: "A", severity: "HIGH", packages: [{ pkg: "noversion", fixed: [] }] }] }, github.gh, quiet), /malformed advisory/);
  await assert.rejects(reconcileAdvisories({ channel: "evil", release: "x", open: [] }, github.gh, quiet), /not an advisory report/);
  assert.equal(github.state.created, 0);
});

test("the held issue is the automation's own for the channel; a lookalike or a duplicate isn't (PIPE-17)", async () => {
  const github = fakeGitHub([{ number: 5, title: "Upstream nightly releases held", user: human, body: "I made this" }]);
  const held = { channel: "nightly", exit: "3", published: "", pinned: "v0.1.6-nightly.20261030.3917", newer: ["v0.1.7-nightly.20261031.4001"], report: "# Upstream evaluation\n- device tool x: @repo-owner" };
  await reconcileHeld(held, github.gh, quiet);
  const ours = github.open().find((issue) => issue.user === bot);
  assert.ok(ours && ours.number !== 5);
  assert.match(ours.body, /```text\n# Upstream evaluation\n- device tool x: @repo-owner\n```/, "the report is a code block");
  assert.equal(github.find(5).body, "I made this");
  // A second copy (say, from a race) is closed as a duplicate of the first.
  github.state.issues.push({ number: 300, title: "Upstream nightly releases held", user: bot, state: "open", labels: [], comments: [], body: ours.body });
  await reconcileHeld({ ...held, report: "changed" }, github.gh, quiet);
  assert.equal(github.find(300).state, "closed");
  assert.match(github.find(ours.number).body, /changed/);
  // Published (the commit job pushed what main now pins): closed. Not published: stays open.
  await reconcileHeld({ ...held, exit: "0", published: "" }, github.gh, quiet);
  assert.equal(github.find(ours.number).state, "open");
  await reconcileHeld({ ...held, exit: "0", published: "v0.1.7-nightly.20261031.4001", pinned: "v0.1.7-nightly.20261031.4001", newer: [] }, github.gh, quiet);
  assert.equal(github.find(ours.number).state, "closed");
  assert.equal(github.find(5).state, "open");
  await assert.rejects(reconcileHeld({ ...held, exit: "1" }, github.gh, quiet), /evaluate job failed/);
});

/** A fake fetch answering GitHub's REST paths from `routes(method, url, body)`. */
const fakeFetch = (routes) => async (url, init = {}) => {
  const answer = await routes(init.method ?? "GET", new URL(url), init.body ? JSON.parse(init.body) : null);
  const { status = 200, body = null, headers = {} } = answer;
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
};

test("the client reads every page, so nothing past 300 issues is missed (PIPE-16)", async () => {
  const issues = Array.from({ length: 301 }, (_, i) => ({ number: i + 1, title: `[security] p${i} (nightly)`, user: bot, labels: [], body: `x\n\n${markerOf({ kind: "package", channel: "nightly", package: `p${i}`, ids: ["GHSA-1"], notified: ["GHSA-1"] })}` }));
  let created = 0;
  const fetch = fakeFetch((method, url) => {
    if (method === "GET" && url.pathname.endsWith("/issues")) {
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("per_page"));
      return { body: issues.slice((page - 1) * size, page * size) };
    }
    if (method === "POST" && url.pathname.endsWith("/issues")) created++;
    return { status: 201, body: {} };
  });
  const gh = githubClient({ token: "t", repo: "o/r", fetch, sleep: async () => {} });
  assert.equal((await gh.openIssues()).length, 301);
  const open = issues.map((issue, i) => advisory("GHSA-1", [`p${i}@1.0.0`]));
  await reconcileAdvisories(report(open), gh, quiet);
  assert.equal(created, 0);
});

test("the client waits out rate limits as GitHub asks, and gives up on other errors", async () => {
  const waits = [];
  let calls = 0;
  const limited = fakeFetch(() => {
    calls++;
    if (calls === 1) return { status: 429, headers: { "retry-after": "7" }, body: { message: "slow down" } };
    if (calls === 2) return { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" }, body: { message: "API rate limit exceeded" } };
    return { status: 201, body: { id: 1 } };
  });
  const gh = githubClient({ token: "t", repo: "o/r", fetch: limited, sleep: async (ms) => waits.push(ms), now: () => 995_000 });
  await gh.comment(1, "hi");
  assert.deepEqual(waits, [7000, 5000]);
  const denied = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch(() => ({ status: 404, body: { message: "Not Found" } })), sleep: async () => assert.fail("no retry") });
  await assert.rejects(denied.comment(1, "hi"), /answered 404/);
  const forever = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch(() => ({ status: 429, headers: { "retry-after": "3600" } })), sleep: async () => {} });
  await assert.rejects(forever.comment(1, "hi"), /rate limited for 3600s/);
  const label = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch(() => ({ status: 422, body: { message: "already_exists" } })), sleep: async () => {} });
  await label.ensureLabel("security", "B60205", "x");
});
