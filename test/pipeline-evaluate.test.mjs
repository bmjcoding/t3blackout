// node --test test/*.test.mjs: the evaluator (lib/evaluate.mjs) against fakes for
// the mirror, the build and the network: candidate order, per-candidate
// approvals and failures, one strip check per candidate, the resolved lockfiles
// it hands the commit and alert jobs, and the alert job's inventory.
import { test } from "node:test";
import assert from "node:assert/strict";

import { lockEntry } from "../lib/device-tools.mjs";
import { advisoryReport, evaluateChannel, releaseCandidates } from "../lib/evaluate.mjs";
import { OVERRIDES, RESOLVED, UPSTREAM, npmMeta } from "./pipeline-fixtures.mjs";

const sha = (c) => c.repeat(40);
const PINNED = "v0.1.6-nightly.20261030.3917";
const NEWEST = "v0.1.7-nightly.20261031.4001";
const OLDER = "v0.1.7-nightly.20261031.4000";
const SHAS = { [PINNED]: sha("0"), [NEWEST]: sha("a"), [OLDER]: sha("b"), "v0.1.5-nightly.20261029.3877": sha("c"), "v0.1.7-nightly.badformat": sha("d"), "v0.1.6": sha("e") };
const TOOLS = (version) => JSON.stringify({ "agent-device": version });
/** A stand-in for a device tool's reviewed package-lock.json, as pin.json keeps it. */
const LOCK = (tool) => lockEntry(`${JSON.stringify({ lockfileVersion: 3, tool })}\n`);
const PIN = {
  version: 1,
  channels: { nightly: { ref: PINNED, sha: sha("0"), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } },
  deviceTools: ["agent-device@0.21.31"],
  deviceToolLocks: { "agent-device@0.21.31": LOCK("agent-device@0.21.31") },
};
const clean = { ok: true, added: 0, young: [], waived: [], unknown: [] };

/** A fake io: every release has the fixture lockfile; `files[sha]` overrides per file. */
function fakeIo({ files = {}, checks = {}, gate = async () => clean, builds = {}, reviews = {} } = {}) {
  const calls = { checkRules: [], resolveLock: [], build: [], reviews: [], advisories: [], proposed: [] };
  let checked = null;
  const io = {
    show: (at, file) => (files[at] && file in files[at] ? files[at][file] : file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS("0.21.31")),
    revParse: (ref) => SHAS[ref] ?? sha("f"),
    tags: () => Object.keys(SHAS),
    knownDeviceTools: () => new Set(["agent-device@0.21.25"]),
    reviewAddedDeviceTools: async (previous, next, known) => {
      const reviewed = new Set([...known, ...previous]);
      const added = [...new Set(next)].filter((tool) => !reviewed.has(tool));
      calls.reviews.push(added);
      return added.map((tool) => ({ tool, lock: LOCK(tool), ...(reviews[tool] ?? { ok: true, reasons: [] }) }));
    },
    proposeToolLock: async (tool) => {
      calls.proposed.push(tool);
      return LOCK(tool);
    },
    dependencyAgeGate: (base, lock, opts) => gate(base, lock, opts),
    openAdvisories: async (packages) => {
      calls.advisories.push(packages);
      return [];
    },
    makeFastLane: () => async () => null,
    checkRules: (ref, at, opts) => {
      calls.checkRules.push({ ref, sha: at, approvals: opts.approvals });
      checked = at;
      return checks[at] ?? { ok: true, skipped: [] };
    },
    resolveLock: () => {
      calls.resolveLock.push(checked);
      return UPSTREAM;
    },
    build: async (ref, at, opts) => {
      calls.build.push({ ref, sha: at, approvals: opts.approvals });
      if (builds[at] instanceof Error) throw builds[at];
      return builds[at] ?? { skipped: [] };
    },
    log: () => {},
  };
  return { io, calls };
}

test("candidates: canonical tags on the channel, newer than the pin, newest release first (PIPE-13, SUPPLY-17)", () => {
  const tags = ["v0.1.7-nightly.20261031.4000", "v0.1.7-nightly.badformat", "v0.1.6-nightly.20261030.3917", "v0.1.10-nightly.20261101.1", "v0.1.7-nightly.20261031.4001", "v0.1.8", "v00.1.9-nightly.20261101.2", "v0.1.7-preview.20261031.1"];
  assert.deepEqual(releaseCandidates(tags, "nightly", PINNED), ["v0.1.10-nightly.20261101.1", "v0.1.7-nightly.20261031.4001", "v0.1.7-nightly.20261031.4000"]);
  assert.deepEqual(releaseCandidates(tags, "nightly", PINNED, 1), ["v0.1.10-nightly.20261101.1"]);
  assert.deepEqual(releaseCandidates(tags, "stable", null), ["v0.1.8"]);
});

test("a held candidate's device tool approval doesn't carry over: the one pinned approves its own (SUPPLY-12)", async () => {
  const files = { [sha("a")]: { "apps/server/src/device/deviceToolVersions.json": TOOLS("0.21.40") }, [sha("b")]: { "apps/server/src/device/deviceToolVersions.json": TOOLS("0.21.40") } };
  const { io, calls } = fakeIo({ files, checks: { [sha("a")]: { ok: false, message: "1 strict rule(s) no longer match upstream. Nothing was installed." } } });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.deepEqual(result.pin.deviceTools, ["agent-device@0.21.31", "agent-device@0.21.40"]);
  assert.deepEqual(calls.reviews, [["agent-device@0.21.40"], ["agent-device@0.21.40"]], "reviewed again for the second candidate");
  assert.deepEqual(
    calls.checkRules.map(({ sha: at, approvals }) => [at[0], approvals]),
    [["0", []], ["a", ["agent-device@0.21.40"]], ["b", ["agent-device@0.21.40"]]],
    "one strip check for the pinned release and one per candidate, each with only its own approvals (SUPPLY-23)",
  );
  assert.match(result.report, /Passed over v0\.1\.7-nightly\.20261031\.4001:\n- 1 strict rule/);
  assert.deepEqual([...result.resolved.keys()], [sha("0"), sha("b")], "resolved lockfiles for the pinned release and the new pin");
});

test("a candidate that fails to evaluate is held, the next is still evaluated, and the report is written (PIPE-13)", async () => {
  const gate = async (base, lock, opts) => {
    if (opts?.waive !== undefined && lock === "broken") throw new Error("npm registry answered 500 for left-pad");
    return clean;
  };
  const { io } = fakeIo({ files: { [sha("a")]: { "pnpm-lock.yaml": "broken" } }, gate });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.match(result.report, /Passed over v0\.1\.7-nightly\.20261031\.4001:\n- couldn't be evaluated: npm registry answered 500/);
});

test("every candidate held: exit 3, the pin stays, each reason reported", async () => {
  const young = async (base, lock, opts) => (opts?.waive !== undefined ? { ...clean, ok: false, young: [{ pkg: "fresh@1.0.0", publishedAt: "2026-10-30T00:00:00Z" }] } : clean);
  const { io } = fakeIo({ gate: young });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(result.exitCode, 3);
  assert.equal(result.pin, null);
  assert.match(result.report, /## v0\.1\.7-nightly\.20261031\.4001\n- dependency fresh@1\.0\.0 published/);
  assert.match(result.report, /## v0\.1\.7-nightly\.20261031\.4000\n/);
  assert.deepEqual([...result.resolved.keys()], [sha("0")], "the pinned release's lockfile still goes to the alert job");
});

test("nothing newer: exit 0, no pin, the pinned release resolved for the alert job", async () => {
  const { io, calls } = fakeIo();
  io.tags = () => [PINNED, "v0.1.5-nightly.20261029.3877"];
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.deepEqual([result.exitCode, result.pin], [0, null]);
  assert.match(result.report, /Already on the newest release/);
  assert.deepEqual(calls.resolveLock, [sha("0")]);
});

test("with --build: built once per passing candidate, what it left out pinned; a build failure holds it", async () => {
  const { io, calls } = fakeIo({ builds: { [sha("a")]: new Error("the app doesn't typecheck against upstream (1 error(s)).\n  - apps/web/x.ts(1): TS2322") , [sha("b")]: { skipped: ["names"] } } });
  const result = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, io);
  assert.equal(result.pin.channels.nightly.ref, OLDER);
  assert.deepEqual(result.pin.channels.nightly.leftOut, ["names"]);
  assert.deepEqual(calls.build.map(({ sha: at }) => at[0]), ["a", "b"]);
  assert.equal(calls.checkRules.length, 3);
  assert.match(result.report, /built and smoke-tested/);
});

test("the pinned release can't be resolved: candidates are still evaluated, the fast lane built from git alone (SUPPLY2-01)", async () => {
  const { io } = fakeIo({ checks: { [sha("0")]: { ok: false, message: "1 strict rule(s) no longer match upstream." } } });
  let lanes = 0;
  io.makeFastLane = () => {
    lanes++;
    return async () => null;
  };
  const result = await evaluateChannel({ channel: "nightly", pin: PIN }, io);
  assert.equal(lanes, 1, "the fast lane never needed the evaluate job's own resolution");
  assert.doesNotMatch(result.report, /no security fix skips the age gate/);
  assert.equal(result.pin.channels.nightly.ref, NEWEST);
  assert.ok(!result.resolved.has(sha("0")));
});

test("the alert inventory is the resolved graph plus the release's own device tools (PIPE-05, PIPE-06, SUPPLY-13)", async () => {
  const pin = { ...PIN, deviceTools: ["agent-device@0.21.20", "agent-device@0.21.31"] };
  const seen = [];
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS("0.21.31")),
    resolvedLock: (at) => (at === sha("0") ? RESOLVED : null),
    // Device tool closures and the staged install: test/pipeline-r2-inventory.test.mjs.
    toolPackages: (tool) => [tool],
    stageRecord: () => null,
    npmMeta,
    openAdvisories: async (packages) => {
      seen.push(packages);
      return [{ id: "GHSA-x", severity: "HIGH", packages: [{ pkg: "newdep@3.0.0", fixed: [] }] }];
    },
  };
  const report = await advisoryReport({ pin, channel: "nightly", overrides: OVERRIDES, now: () => new Date("2026-10-30T20:00:00Z") }, io);
  const gaps = [`the staged production install: the evaluate job left no stage record for ${sha("0").slice(0, 10)}`];
  assert.deepEqual(report, { checkedAt: "2026-10-30T20:00:00.000Z", channel: "nightly", release: PINNED, sha: sha("0"), packages: seen[0].length, gaps, open: [{ id: "GHSA-x", severity: "HIGH", packages: [{ pkg: "newdep@3.0.0", fixed: [] }] }] });
  assert.ok(seen[0].includes("newdep@3.0.0") && !seen[0].includes("only-via-vuln@1.0.0"));
  assert.ok(seen[0].includes("agent-device@0.21.31") && !seen[0].includes("agent-device@0.21.20"), "an old approval isn't installed");
  // No resolved lockfile (a failed evaluation): still checked, upstream's lockfile standing in, with a gap (PIPE3-03).
  const fallback = await advisoryReport({ pin: { ...pin, channels: { nightly: { ...pin.channels.nightly, sha: sha("9") } } }, channel: "nightly", overrides: OVERRIDES }, io);
  assert.match(fallback.gaps[0], /left no resolved lockfile for 9999999999; upstream's lockfile with the overrides applied stands in/);
  await assert.rejects(advisoryReport({ pin, channel: "stable", overrides: OVERRIDES }, io), /no stable pin/);
});
