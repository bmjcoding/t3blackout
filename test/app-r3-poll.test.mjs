// node --test test/*.test.mjs: `poll` never announces a build staged with rules other than this
// checkout's as built (APP3-03): the app installs whatever it was told is built, while `update`
// would rebuild it with the current rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vm from "node:vm";

import { pollOffer } from "../lib/expect.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const R1 = "1".repeat(40);
const R2 = "2".repeat(40);
const installed = { sha: B, ref: "v0.1.6", blackout: R1, installedAt: "2026-10-30T10:00:00.000Z" };
const staged = (sha, blackout) => ({ sha, ref: sha === A ? "v0.1.7" : "v0.1.6", version: sha === A ? "0.1.7" : "0.1.6", blackout, stagedAt: "2026-10-30T12:00:00.000Z" });
const newer = { ref: "v0.1.7", sha: A };
const same = { ref: "v0.1.6", sha: B };

test("a newer release staged with this checkout's rules is offered as built", () => {
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, R2), target: newer, rules: R2 }), { ref: "v0.1.7", sha: A, staged: true, from: "target" });
});

test("a newer release staged with older rules is offered to build again, not as built", () => {
  // The reviewer's case: A staged with R1, then the repo self-updated to R2.
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, R1), target: newer, rules: R2 }), { ref: "v0.1.7", sha: A, staged: false, from: "target" });
  assert.equal(pollOffer({ current: installed, pending: staged(A, R2), target: newer, rules: null }).staged, false, "no rules commit, nothing counts as built");
});

test("the installed release rebuilt with these rules waits for a restart; with older rules it's built again", () => {
  assert.deepEqual(pollOffer({ current: installed, pending: staged(B, R2), target: same, rules: R2 }), { ref: "v0.1.6", sha: B, staged: true, from: "pending" });
  assert.deepEqual(pollOffer({ current: { ...installed, blackout: "0".repeat(40) }, pending: staged(B, R1), target: same, rules: R2 }), {
    ref: "v0.1.6",
    sha: B,
    staged: false,
    from: "pending",
  });
});

test("a staged build of another release than update's is never offered", () => {
  // The newer release is held now (its rules fail), so update stays on what's installed.
  assert.equal(pollOffer({ current: installed, pending: staged(A, R2), target: same, rules: R2 }), null);
  assert.equal(pollOffer({ current: installed, pending: staged(A, R1), target: same, rules: R2 }), null);
});

test("nothing is offered for a build staged before the install, or when the installed one is the build update makes", () => {
  assert.equal(pollOffer({ current: { ...installed, installedAt: "2026-10-30T13:00:00.000Z" }, pending: staged(B, R2), target: same, rules: R2 }), null);
  assert.equal(pollOffer({ current: { ...installed, blackout: R2 }, pending: staged(B, R1), target: same, rules: R2 }), null);
  assert.equal(pollOffer({ current: installed, pending: null, target: same, rules: R2 }), null);
});

test("without a mirror the staged build still needs this checkout's rules", () => {
  assert.equal(pollOffer({ current: installed, pending: staged(A, R2), target: null, rules: R2 }).staged, true);
  assert.deepEqual(pollOffer({ current: installed, pending: staged(A, R1), target: null, rules: R2 }), { ref: "v0.1.7", sha: A, staged: false, from: "pending" });
});

/** cmdPoll from bin/t3blackout, run against stubbed records (the round-3 reviewer's probe). */
function runPoll({ pending, target, rules }) {
  const source = fs.readFileSync(new URL("../bin/t3blackout", import.meta.url), "utf8");
  const start = source.indexOf("async function cmdPoll(opts)");
  const end = source.indexOf("\nconst waitFor =", start);
  assert.ok(start !== -1 && end !== -1, "bin/t3blackout's cmdPoll moved; update this test");
  const events = [];
  const context = vm.createContext({
    CURRENT: "current",
    console: { log: () => {} },
    process: { env: {} },
    readJson: () => installed,
    readPending: () => pending,
    hasMirror: () => target !== null,
    chooseTarget: async () => ({ ...target, held: [], verdict: null }),
    pollOffer,
    blackoutCommit: () => rules,
    versionOf: (ref) => ref.replace(/^v/, ""),
    notesFor: () => [],
    heldLine: () => "held",
    emit: (event) => events.push(event),
  });
  return vm.runInContext(`${source.slice(start, end)}\ncmdPoll({ offline: true, json: true })`, context).then(() => events);
}

test("the CLI's poll announces the stale build as a download, which update rebuilds", async () => {
  const [stale] = await runPoll({ pending: staged(A, R1), target: newer, rules: R2 });
  assert.deepEqual(JSON.parse(JSON.stringify(stale)), { type: "poll", update: { ref: "v0.1.7", sha: A, version: "0.1.7", staged: false, blackout: null, releaseNotes: [] } });
  const [built] = await runPoll({ pending: staged(A, R2), target: newer, rules: R2 });
  assert.equal(built.update.staged, true);
  assert.equal(built.update.blackout, R2, "apply is told the rules it was built with");
  const [fallback] = await runPoll({ pending: staged(B, R1), target: same, rules: R2 });
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.update)), { ref: "v0.1.6", sha: B, version: "0.1.6", staged: false, blackout: null, releaseNotes: [] });
});
