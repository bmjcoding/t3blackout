// node --test test/*.test.mjs: the app installs and builds only the build it chose (lib/expect.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { expectedBuild, isExpectedBuild, unexpectedBuildMessage } from "../lib/expect.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const R = "c".repeat(40);

test("no expectation accepts any build, as the hourly updater and launch need", () => {
  assert.equal(expectedBuild({}), null);
  assert.equal(isExpectedBuild({ sha: A, blackout: R }, null), true);
});

test("an expected commit must be a full SHA", () => {
  assert.deepEqual(expectedBuild({ "expect-sha": A }), { sha: A, blackout: null });
  assert.deepEqual(expectedBuild({ "expect-sha": A, "expect-blackout": R }), { sha: A, blackout: R });
  for (const opts of [{ "expect-sha": "v0.1.6-nightly.20261030.3917" }, { "expect-sha": A.slice(0, 10) }, { "expect-blackout": R }, { "expect-sha": A, "expect-blackout": "main" }]) {
    assert.throws(() => expectedBuild(opts));
  }
});

test("a moved release or a different staged build is refused", () => {
  const expected = expectedBuild({ "expect-sha": A, "expect-blackout": R });
  assert.equal(isExpectedBuild({ sha: A, blackout: R }, expected), true);
  assert.equal(isExpectedBuild({ sha: B, blackout: R }, expected), false, "the hourly updater staged another release");
  assert.equal(isExpectedBuild({ sha: A, blackout: B }, expected), false, "the same release rebuilt with other rules");
  assert.equal(isExpectedBuild(null, expected), false);
  assert.equal(isExpectedBuild({ sha: A, blackout: B }, expectedBuild({ "expect-sha": A })), true, "a download names only the commit");
  assert.match(unexpectedBuildMessage("the staged build", { version: "0.1.7", sha: B, blackout: R }, expected), /0\.1\.7 \(bbbbbbbbbb, rules cccccccccc\), not the aaaaaaaaaa \(rules cccccccccc\)/);
});

test("the app's updater passes what it chose to the CLI", () => {
  const updater = fs.readFileSync(new URL("../lib/files/BlackoutUpdater.ts", import.meta.url), "utf8");
  assert.match(updater, /"--expect-sha",\n\s+target\.sha,/, "download names the checked commit");
  assert.doesNotMatch(updater, /"--ref", target\.ref/, "download never names the mutable tag");
  assert.match(updater, /\["--expect-sha", build\.sha, \.\.\.\(build\.blackout \? \["--expect-blackout", build\.blackout\] : \[\]\)\]/);
  const cli = fs.readFileSync(new URL("../bin/t3blackout", import.meta.url), "utf8");
  assert.match(cli, /"expect-sha": \{ type: "string" \}/);
  assert.match(cli, /applyPending\(expectedBuild\(opts\)\)/);
  assert.match(cli, /emit\(\{ type: "staged", ref, sha, version, blackout \}\)/);
});

test("HOST4-01: a build staged with other strip rules isn't installed", async () => {
  const { staleRulesProblem } = await import("../lib/expect.mjs");
  const R1 = "1".repeat(40);
  const R2 = "2".repeat(40);
  assert.equal(staleRulesProblem({ sha: "a", blackout: R2 }, R2), null);
  assert.match(staleRulesProblem({ sha: "a", blackout: R1 }, R2), /made with T3 Blackout 111111111111, not this checkout's 222222222222/);
  assert.match(staleRulesProblem({ sha: "a" }, R2), /\(unknown\)/);
  // No checkout identity (not a git clone): nothing to compare against.
  assert.equal(staleRulesProblem({ sha: "a", blackout: R1 }, null), null);
});
