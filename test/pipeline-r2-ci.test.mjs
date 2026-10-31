// node --test test/*.test.mjs: round-2 pipeline fixes to CI's own scripts and
// the alert job's GitHub side: action pins read from parsed YAML (PIPE2-10),
// entry points found by canonical path (APP2-10), pinned channels built when
// pin.json changes (PIPE2-06), held-issue closure on trusted signals only
// (PIPE2-07), creations retried only after looking for them (PIPE2-08), and
// Retry-After as an HTTP date (PIPE2-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { channelsToBuild } from "../.github/scripts/build-channels.mjs";
import { checkFiles, usesValues } from "../.github/scripts/check-action-pins.mjs";
import { githubClient } from "../.github/scripts/github.mjs";
import { isMain } from "../.github/scripts/is-main.mjs";
import { BOT, markerOf, reconcileAdvisories, reconcileHeld } from "../.github/scripts/reconcile.mjs";
import { newerReleases } from "../lib/evaluate.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const quiet = { log: () => {} };

// ------------------------------------------------------- action pins -------

test("a `uses` in a flow mapping or under a quoted key is checked; one inside a script isn't (PIPE2-10)", () => {
  const workflow = [
    "on: push",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - { uses: actions/checkout@v4 }",
    '      - "uses": actions/setup-node@v4',
    `      - 'uses': "actions/cache@${SHA}"`,
    "      - run: |",
    "          echo uses: not-an-action",
    "          uses: also-not",
    "      - name: folded",
    "        run: >-",
    "          uses: nothing",
    "  b:",
    "    uses: org/repo/.github/workflows/reusable.yml@main",
  ].join("\n");
  assert.deepEqual(usesValues(workflow), [
    { line: 6, value: "actions/checkout@v4" },
    { line: 7, value: "actions/setup-node@v4" },
    { line: 8, value: `actions/cache@${SHA}` },
    { line: 16, value: "org/repo/.github/workflows/reusable.yml@main" },
  ]);
  const problems = checkFiles(["w.yml"], () => workflow);
  assert.deepEqual(problems, [
    "w.yml:6: actions/checkout@v4: not pinned to a full commit SHA",
    "w.yml:7: actions/setup-node@v4: not pinned to a full commit SHA",
    "w.yml:16: org/repo/.github/workflows/reusable.yml@main: not pinned to a full commit SHA",
  ]);
  // A `uses` that isn't a string can't be pinned.
  assert.match(checkFiles(["w.yml"], () => "jobs:\n  a:\n    steps:\n      - uses: { x: 1 }\n")[0], /\(a mapping\): not pinned/);
});

test("YAML the checker can't read fails the check instead of hiding a `uses` (PIPE2-10)", () => {
  const anchored = ["x: &step", "  uses: actions/checkout@v4", "jobs:", "  a:", "    steps:", "      - *step"].join("\n");
  assert.match(checkFiles(["w.yml"], () => anchored)[0], /^w\.yml: can't read it as YAML, so its actions can't be checked: .*anchors/);
});

test("the repo's own workflows parse, and every action in them is pinned", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
  assert.ok(files.length >= 3);
  assert.deepEqual(checkFiles(files), []);
  for (const file of files) assert.ok(usesValues(fs.readFileSync(file, "utf8")).length > 0, file);
});

test("block scalars read as YAML 1.2 does, and only where asked for: lockfiles stay strict", () => {
  const read = (text) => parseYaml(text, { blockScalars: true })[0];
  assert.deepEqual(read("a: |\n  x\n  y\n\nb: 1\n"), { a: "x\ny\n", b: 1 });
  assert.deepEqual(read("a: >\n  x\n  y\n\n  z\n   more\n  w\n"), { a: "x y\nz\n more\nw\n" });
  assert.deepEqual(read("a: |-\n  x\n\n"), { a: "x" });
  assert.deepEqual(read("a: |+\n  x\n\n\nb: 2\n"), { a: "x\n\n\n", b: 2 });
  assert.deepEqual(read("- |\n  one\n  # not a comment\n- two\n"), ["one\n# not a comment\n", "two"]);
  assert.deepEqual(read("a: |\nb: 1\n"), { a: "", b: 1 });
  assert.deepEqual(read("a:\n  - run: |\n      x\n      \ttabbed\n    name: n\n"), { a: [{ run: "x\n\ttabbed\n", name: "n" }] });
  assert.throws(() => read("a: |2\n  x\n"), /indentation indicators/);
  assert.throws(() => read("a: 1\n\tb: 2\n"), /tabs can't indent YAML/);
  assert.throws(() => parseYaml("a: |\n  x\n"), /block scalars aren't supported/);
  assert.throws(() => parseYaml("a: 1\n\tb: 2\n"), /tabs can't indent YAML/);
});

// ------------------------------------------------------- entry points ------

test("CI scripts run when invoked through a symlinked path, as /tmp is on macOS (APP2-10)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-is-main-"));
  try {
    const link = path.join(dir, "scripts");
    fs.symlinkSync(path.join(ROOT, ".github", "scripts"), link);
    // Without its checkout argument it must complain, not exit 0 having done nothing.
    const stripped = spawnSync(process.execPath, [path.join(link, "stripped-tests.mjs")], { encoding: "utf8" });
    assert.equal(stripped.status, 2, stripped.stderr);
    assert.match(stripped.stderr, /usage: stripped-tests\.mjs/);
    fs.writeFileSync(path.join(dir, "bad.yml"), "jobs:\n  a:\n    steps:\n      - { uses: actions/checkout@v4 }\n");
    const pins = spawnSync(process.execPath, [path.join(link, "check-action-pins.mjs"), path.join(dir, "bad.yml")], { encoding: "utf8" });
    assert.equal(pins.status, 1);
    assert.match(pins.stderr, /actions\/checkout@v4: not pinned/);
    const runner = spawnSync(process.execPath, [path.join(link, "render-runner.mjs")], { encoding: "utf8" });
    assert.notEqual(runner.status, 0, "no arguments is an error, not a silent no-op");
    // Imported, it's not the entry point.
    assert.equal(isMain(pathToFileURL(path.join(ROOT, ".github", "scripts", "stripped-tests.mjs")).href, [process.execPath, path.join(link, "check-action-pins.mjs")]), false);
    assert.equal(isMain(pathToFileURL(path.join(ROOT, ".github", "scripts", "stripped-tests.mjs")).href, [process.execPath]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- build.yml -----

test("a pin-only change builds the channels it moved; anything else builds every pinned channel (PIPE2-06)", () => {
  const entry = (ref) => ({ ref, sha: "a".repeat(40), evaluatedAt: "2026-10-30T00:00:00Z", leftOut: [] });
  const before = { version: 1, channels: { nightly: entry("v0.1.6-nightly.20261030.3917"), stable: entry("v0.1.6") }, deviceTools: [] };
  const nightlyMoved = { ...before, channels: { ...before.channels, nightly: entry("v0.1.7-nightly.20261031.4001") } };
  assert.deepEqual(channelsToBuild({ pin: nightlyMoved, basePin: before, changedFiles: ["pin.json"] }), ["nightly"]);
  assert.deepEqual(channelsToBuild({ pin: nightlyMoved, basePin: before, changedFiles: ["pin.json", "lib/rules.mjs"] }), ["nightly", "stable"]);
  assert.deepEqual(channelsToBuild({ pin: { ...before, deviceTools: ["x@1.0.0"] }, basePin: before, changedFiles: ["pin.json"] }), ["nightly", "stable"], "device tools are every channel's");
  assert.deepEqual(channelsToBuild({ pin: before, basePin: null, changedFiles: null }), ["nightly", "stable"], "no base: everything");
  const added = { ...before, channels: { ...before.channels, preview: entry("v0.1.7-preview.20261031.1") } };
  assert.deepEqual(channelsToBuild({ pin: added, basePin: before, changedFiles: ["pin.json"] }), ["preview"]);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
  const on = parseYaml(workflow, { blockScalars: true })[0].on;
  for (const trigger of ["push", "pull_request"]) assert.ok(on[trigger].paths.includes("pin.json"), trigger);
});

// --------------------------------------------------------- held issue ------

function fakeGitHub(issues = []) {
  let next = 100;
  const bot = { login: BOT, type: "Bot" };
  const state = issues.map((issue) => ({ state: "open", user: bot, comments: [], ...issue }));
  return {
    state,
    open: () => state.filter((issue) => issue.state === "open"),
    gh: {
      openIssues: async () => state.filter((issue) => issue.state === "open").map((issue) => structuredClone(issue)),
      comments: async (number) => structuredClone(state.find((issue) => issue.number === number).comments),
      createIssue: async ({ title, body }) => state.push({ number: next++, title, body, state: "open", user: bot, comments: [] }),
      updateIssue: async (number, fields) => Object.assign(state.find((issue) => issue.number === number), fields),
      comment: async (number, body) => state.find((issue) => issue.number === number).comments.push({ user: bot, body }),
      ensureLabel: async () => {},
    },
  };
}

const PINNED = "v0.1.6-nightly.20261030.3917";
const NEWER = "v0.1.7-nightly.20261031.4001";

test("the evaluate job's exit code alone never closes the held issue (PIPE2-07)", async () => {
  const github = fakeGitHub();
  const held = { channel: "nightly", exit: "3", published: "", pinned: PINNED, newer: [NEWER], report: "held: typecheck" };
  await reconcileHeld(held, github.gh, quiet);
  assert.equal(github.open().length, 1);
  assert.match(github.open()[0].body, /each Mac re-checks any pin itself/i);
  // A compromised evaluate job: exit 0 with main's own pin, so nothing was signed or pushed.
  await reconcileHeld({ ...held, exit: "0" }, github.gh, quiet);
  assert.equal(github.open().length, 1, "still held: newer releases exist and nothing was published");
  // What upstream has couldn't be read: nothing closes either.
  await reconcileHeld({ ...held, exit: "0", newer: null }, github.gh, quiet);
  assert.equal(github.open().length, 1);
  // The commit job's output names a pin main doesn't have (main moved since): not a publication.
  await reconcileHeld({ ...held, exit: "0", published: NEWER }, github.gh, quiet);
  assert.equal(github.open().length, 1);
  // A pin the commit job pushed and main now has: closed.
  await reconcileHeld({ ...held, exit: "0", published: NEWER, pinned: NEWER }, github.gh, quiet);
  assert.equal(github.open().length, 0);
  assert.match(github.state[0].comments.at(-1).body, /is pinned; releases aren't held anymore/);
});

test("with nothing newer upstream than main's pin, nothing can be held: closed, or never opened (PIPE2-07)", async () => {
  const github = fakeGitHub();
  await reconcileHeld({ channel: "nightly", exit: "3", published: "", pinned: PINNED, newer: [NEWER], report: "x" }, github.gh, quiet);
  await reconcileHeld({ channel: "nightly", exit: "0", published: "", pinned: PINNED, newer: [], report: "" }, github.gh, quiet);
  assert.equal(github.open().length, 0);
  assert.match(github.state[0].comments.at(-1).body, /is upstream's newest nightly release/);
  // A forged exit 3 can't open it when upstream has nothing newer.
  await reconcileHeld({ channel: "nightly", exit: "3", published: "", pinned: PINNED, newer: [], report: "forged" }, github.gh, quiet);
  assert.equal(github.open().length, 0);
  // A failed evaluation still fails the step.
  await assert.rejects(reconcileHeld({ channel: "nightly", exit: "1", published: "", pinned: PINNED, newer: [NEWER], report: "" }, github.gh, quiet), /evaluate job failed/);
});

test("newer releases are every release tag on the channel past the pin, however many", () => {
  const tags = Array.from({ length: 8 }, (_, i) => `v0.1.7-nightly.20261031.${4000 + i}`);
  assert.equal(newerReleases([...tags, PINNED, "v0.1.7", "v0.1.7-nightly.bad"], "nightly", PINNED).length, 8);
  assert.deepEqual(newerReleases([PINNED], "nightly", PINNED), []);
});

// -------------------------------------------------------- GitHub client ----

/** A fake GitHub REST server: `routes(method, url, body, n)`, n counting each method+path. */
function fakeFetch(routes) {
  const counts = new Map();
  return async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const answer = await routes(init.method ?? "GET", u, init.body ? JSON.parse(init.body) : null, counts.get(key));
    if (answer instanceof Error) throw answer;
    const { status = 200, body = null, headers = {} } = answer;
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
  };
}

test("a comment whose response was lost is looked for by its marker before it's posted again (PIPE2-08)", async () => {
  for (const failure of [() => new TypeError("fetch failed: socket hang up"), () => ({ status: 502, body: { message: "Bad Gateway" } })]) {
    const comments = [];
    const fetch = fakeFetch((method, url, body, n) => {
      if (method === "GET" && url.pathname.endsWith("/issues")) return { body: [] };
      if (method === "GET" && url.pathname.endsWith("/comments")) return { body: comments };
      if (method === "POST" && url.pathname.endsWith("/comments")) {
        comments.push({ user: { login: BOT, type: "Bot" }, body: body.body });
        return n === 1 ? failure() : { status: 201, body: {} };
      }
      return { status: 201, body: { number: 1 } };
    });
    const gh = githubClient({ token: "t", repo: "o/r", fetch, sleep: async () => {} });
    const marker = markerOf({ kind: "notify", ids: ["GHSA-1"] });
    const landed = async () => (await gh.comments(7)).find((c) => c.body.endsWith(marker)) ?? null;
    await gh.comment(7, `hello\n\n${marker}`, { landed });
    assert.equal(comments.length, 1, "posted once");
  }
});

test("an issue whose creation seemed to fail isn't opened twice, and a creation with no way to check isn't repeated (PIPE2-08)", async () => {
  const issues = [];
  const fetch = fakeFetch((method, url, body, n) => {
    if (method === "GET" && url.pathname.endsWith("/issues")) return { body: issues };
    if (method === "GET") return { body: [] };
    if (method === "POST" && url.pathname.endsWith("/issues")) {
      issues.push({ number: 10 + issues.length, title: body.title, body: body.body, state: "open", user: { login: BOT, type: "Bot" } });
      return n === 1 ? { status: 500, body: { message: "Server Error" } } : { status: 201, body: issues.at(-1) };
    }
    return { status: 201, body: {} };
  });
  const gh = githubClient({ token: "t", repo: "o/r", fetch, sleep: async () => {} });
  const report = { checkedAt: "x", channel: "nightly", release: PINNED, sha: "0".repeat(40), packages: 1, gaps: [], open: [{ id: "GHSA-1", aliases: [], summary: "s", severity: "HIGH", packages: [{ pkg: "a@1.0.0", fixed: [] }] }] };
  await reconcileAdvisories(report, gh, quiet);
  assert.equal(issues.length, 1);
  const blind = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch(() => ({ status: 502, body: {} })), sleep: async () => assert.fail("no retry") });
  await assert.rejects(blind.comment(1, "x"), /not retried, since it may have gone through/);
  await assert.rejects(blind.createIssue({ title: "t", body: "b" }), /not retried/);
  // A rate-limited creation wasn't served: it's retried without looking.
  let posts = 0;
  const limited = githubClient({
    token: "t",
    repo: "o/r",
    fetch: fakeFetch((method) => (method === "POST" && ++posts === 1 ? { status: 429, headers: { "retry-after": "1" } } : { status: 201, body: {} })),
    sleep: async () => {},
  });
  await limited.comment(1, "x");
  assert.equal(posts, 2);
  // Updates are idempotent and retried as before.
  let patches = 0;
  const flaky = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch((method) => (method === "PATCH" && ++patches === 1 ? { status: 503 } : { status: 200, body: {} })), sleep: async () => {} });
  await flaky.updateIssue(1, { state: "closed" });
  assert.equal(patches, 2);
});

test("Retry-After as an HTTP date is waited out, not cut to the backoff (PIPE2-09)", async () => {
  const now = Date.parse("Fri, 30 Oct 2026 20:00:00 GMT");
  const waits = [];
  let calls = 0;
  const fetch = fakeFetch(() => (++calls === 1 ? { status: 429, headers: { "retry-after": "Fri, 30 Oct 2026 20:02:00 GMT" } } : { status: 201, body: {} }));
  const gh = githubClient({ token: "t", repo: "o/r", fetch, sleep: async (ms) => waits.push(ms), now: () => now });
  await gh.comment(1, "x");
  assert.deepEqual(waits, [120_000]);
  const far = githubClient({ token: "t", repo: "o/r", fetch: fakeFetch(() => ({ status: 429, headers: { "retry-after": "Fri, 30 Oct 2026 21:00:00 GMT" } })), sleep: async () => {}, now: () => now });
  await assert.rejects(far.comment(1, "x"), /rate limited for 3600s/);
});
