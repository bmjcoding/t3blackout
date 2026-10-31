// node --test test/*.test.mjs: round-2 pipeline fixes to the advisory inventory
// (PIPE2-03, SUPPLY2-06, BUILD2-04): the alert job checks everything a build
// installs, WORK's resolved graph plus each device tool's frozen closure
// (pin.json deviceToolLocks) and the staged production install (stage records
// the evaluate job keeps, bound to commit, overrides and platform); what it
// can't cover is a gap that keeps issues open. Also the device tool lockfiles
// the evaluator proposes and the commit job checks. (Round 3 binds stage records
// to the build code and checks what they say: test/pipeline-r3-alerts.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileAdvisories } from "../.github/scripts/reconcile.mjs";
import { lockEntry } from "../lib/device-tools.mjs";
import { advisoryReport, evaluateChannel } from "../lib/evaluate.mjs";
import { alertInventory, checkStageRecord, readStageRecord, stagePlatform, stageRecord, toolClosurePackages } from "../lib/inventory.mjs";
import { verifyCandidate } from "../lib/pincheck.mjs";
import { OVERRIDES, RESOLVED, STAGE_LOCK, STAGE_SOURCES, UPSTREAM, npmMeta } from "./pipeline-fixtures.mjs";

const sha = (c) => c.repeat(40);
const PINNED = "v0.1.6-nightly.20261030.3917";
const NEWEST = "v0.1.7-nightly.20261031.4001";
const TOOL = "expo-device-hub@0.19.0";
const TOOLS = JSON.stringify({ "expo-device-hub": "0.19.0" });

/** A package-lock.json for `tool` alone, its closure `deps` (name@version), as npm writes it. */
function toolLock(tool, deps) {
  const entry = (pkg) => {
    const at = pkg.lastIndexOf("@");
    const name = pkg.slice(0, at);
    const version = pkg.slice(at + 1);
    return [`node_modules/${name}`, { version, resolved: `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`, integrity: `sha512-${name.length}` }];
  };
  const name = tool.slice(0, tool.lastIndexOf("@"));
  const root = { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [name]: tool.slice(tool.lastIndexOf("@") + 1) } };
  return `${JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": root, ...Object.fromEntries([tool, ...deps].map(entry)) } }, null, 2)}\n`;
}

const STAGE_ONLY = ["@electron-webauthn/types@1.4.0", "@bufbuild/protobuf@2.0.1", "@cursor/sdk@1.0.0", "electron-webauthn@1.3.1"];
/** This repo's build code, as stage records name it (lib/inventory.mjs blackoutDigest). */
const BLACKOUT = sha("b");
const CLOSURE = ["node-datachannel@0.32.3", "prebuild-install@7.1.3", "tar-fs@2.1.5"];
const PIN = {
  version: 1,
  channels: { nightly: { ref: PINNED, sha: sha("0"), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } },
  deviceTools: [TOOL],
  deviceToolLocks: { [TOOL]: lockEntry(toolLock(TOOL, CLOSURE)) },
};
const record = (overrides = {}) => JSON.stringify(stageRecord({ sha: sha("0"), locks: [STAGE_LOCK], blackout: BLACKOUT, builtAt: "2026-10-30T18:00:00.000Z", ...overrides }));
/** Upstream at any commit: its lockfile, its device tool pins and the packager's sources. */
const show = (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : (STAGE_SOURCES[file] ?? TOOLS));

test("a device tool's closure comes from pin.json's frozen lockfile, checked against its SHA-256", () => {
  assert.deepEqual(toolClosurePackages(TOOL, PIN), [TOOL, ...CLOSURE].sort());
  assert.throws(() => toolClosurePackages(TOOL, { ...PIN, deviceToolLocks: {} }), /no reviewed dependency lockfile/);
  const forged = { ...PIN, deviceToolLocks: { [TOOL]: { ...PIN.deviceToolLocks[TOOL], lock: toolLock(TOOL, []) } } };
  assert.throws(() => toolClosurePackages(TOOL, forged), /doesn't match its sha256/);
});

test("a stage record is used only for the commit, build code and platform it was made with", async () => {
  const read = readStageRecord(record(), { sha: sha("0"), blackout: BLACKOUT });
  assert.deepEqual(read.locks, [STAGE_LOCK]);
  assert.equal(read.platform, stagePlatform());
  const checked = await checkStageRecord(record(), { sha: sha("0"), show, workLock: RESOLVED, blackout: BLACKOUT, overrides: OVERRIDES }, { meta: npmMeta });
  for (const pkg of STAGE_ONLY) assert.ok(checked.packages.includes(pkg), pkg);
  assert.throws(() => readStageRecord(record(), { sha: sha("1"), blackout: BLACKOUT }), /for 0000000000, not 1111111111/);
  assert.throws(() => readStageRecord(record(), { sha: sha("0"), blackout: sha("c") }), /other Blackout build code/);
  assert.throws(() => readStageRecord(record({ platform: "darwin-arm64" }), { sha: sha("0"), blackout: BLACKOUT, platform: "linux-x64" }), /made on darwin-arm64, not linux-x64/);
  assert.throws(() => readStageRecord(record({ platform: "win32-x64" }), { sha: sha("0"), blackout: BLACKOUT }), /win32-x64, which Blackout doesn't build on/);
  await assert.rejects(checkStageRecord(record({ locks: ["lockfileVersion: '5.4'\n"] }), { sha: sha("0"), show, workLock: RESOLVED, blackout: BLACKOUT, overrides: OVERRIDES }, { meta: npmMeta }), /lockfile isn't what a build of 0000000000 stages: .*isn't supported/);
  assert.throws(() => readStageRecord(JSON.stringify({ ...JSON.parse(record()), v: 1 }), { sha: sha("0"), blackout: BLACKOUT }), /version 1 isn't 2/);
  assert.throws(() => stageRecord({ sha: sha("0"), locks: [] }), /no staged lockfiles/);
});

const base = { sha: sha("0"), show, resolvedLock: RESOLVED, overrides: OVERRIDES, blackout: BLACKOUT };
const net = { meta: npmMeta };

test("the alert inventory covers the staged install and every device tool's closure (PIPE2-03, SUPPLY2-06, BUILD2-04)", async () => {
  const full = await alertInventory({ ...base, toolPackages: (tool) => toolClosurePackages(tool, PIN), stage: record() }, net);
  for (const pkg of [...STAGE_ONLY, ...CLOSURE, TOOL, "newdep@3.0.0"]) assert.ok(full.packages.includes(pkg), pkg);
  assert.ok(!full.packages.includes("only-via-vuln@1.0.0"), "what the override replaced isn't installed");
  assert.deepEqual(full.gaps, []);
  // What can't be had is said, not silently dropped.
  const partial = await alertInventory({ ...base, toolPackages: (tool) => toolClosurePackages(tool, { ...PIN, deviceToolLocks: {} }), stage: null }, net);
  assert.ok(partial.packages.includes(TOOL) && !partial.packages.includes("node-datachannel@0.32.3"));
  assert.equal(partial.gaps.length, 2);
  assert.match(partial.gaps[0], /expo-device-hub@0\.19\.0's dependencies: pin\.json has no reviewed dependency lockfile/);
  assert.match(partial.gaps[1], /no stage record for 0000000000/);
  const stale = await alertInventory({ ...base, toolPackages: () => [TOOL], stage: record(), blackout: sha("c") }, net);
  assert.ok(!stale.packages.includes(STAGE_ONLY[0]));
  assert.match(stale.gaps[0], /other Blackout build code/);
});

test("advisories are looked up in the staged install and the tool closures too, and gaps are reported", async () => {
  const seen = [];
  const io = {
    show,
    resolvedLock: (at) => (at === sha("0") ? RESOLVED : null),
    toolPackages: toolClosurePackages,
    stageRecord: (at) => (at === sha("0") ? record() : null),
    npmMeta,
    blackout: () => BLACKOUT,
    openAdvisories: async (packages) => {
      seen.push(packages);
      return [{ id: "GHSA-stage", severity: "HIGH", packages: [{ pkg: STAGE_ONLY[0], fixed: ["1.0.7"] }] }];
    },
  };
  const report = await advisoryReport({ pin: PIN, channel: "nightly", overrides: OVERRIDES }, io);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.packages, seen[0].length);
  for (const pkg of [...STAGE_ONLY, ...CLOSURE]) assert.ok(seen[0].includes(pkg), pkg);
  const gapped = await advisoryReport({ pin: { ...PIN, deviceToolLocks: {} }, channel: "nightly", overrides: OVERRIDES }, { ...io, stageRecord: () => null });
  assert.equal(gapped.gaps.length, 2);
});

/** An in-memory GitHub, as test/pipeline-issues.test.mjs has it. */
function fakeGitHub() {
  let next = 1;
  const issues = [];
  const bot = { login: "github-actions[bot]", type: "Bot" };
  return {
    issues,
    gh: {
      openIssues: async () => issues.filter((issue) => issue.state === "open").map((issue) => structuredClone(issue)),
      comments: async (number) => structuredClone(issues.find((issue) => issue.number === number).comments),
      createIssue: async ({ title, body }) => issues.push({ number: next++, title, body, state: "open", user: bot, comments: [] }),
      updateIssue: async (number, fields) => Object.assign(issues.find((issue) => issue.number === number), fields),
      comment: async (number, body) => issues.find((issue) => issue.number === number).comments.push({ user: bot, body }),
      ensureLabel: async () => {},
    },
  };
}

test("with a gap, no advisory issue is closed as fixed, and a coverage issue says what wasn't covered", async () => {
  const github = fakeGitHub();
  const quiet = { log: () => {} };
  const report = (open, gaps) => ({ checkedAt: "2026-10-30T20:00:00Z", channel: "nightly", release: PINNED, sha: sha("0"), packages: 10, gaps, open });
  const high = { id: "GHSA-stage", aliases: [], summary: "s", severity: "HIGH", packages: [{ pkg: STAGE_ONLY[0], fixed: ["1.0.7"] }] };
  const low = { id: "GHSA-low", aliases: [], summary: "s", severity: "LOW", packages: [{ pkg: CLOSURE[2], fixed: ["2.1.6"] }] };
  await reconcileAdvisories(report([high, low], []), github.gh, quiet);
  const open = () => github.issues.filter((issue) => issue.state === "open").map((issue) => issue.title).sort();
  assert.deepEqual(open(), ["[security] @electron-webauthn/types (nightly)", "[security] Moderate and low advisories (nightly)"]);
  // The stage record went missing this hour: the advisories in it are unknown, not fixed.
  await reconcileAdvisories(report([], ["the staged production install: the evaluate job left no checked stage lockfile for 0000000000"]), github.gh, quiet);
  assert.deepEqual(open(), ["[security] @electron-webauthn/types (nightly)", "[security] Advisory coverage incomplete (nightly)", "[security] Moderate and low advisories (nightly)"]);
  assert.match(github.issues.find((issue) => issue.title.includes("coverage")).body, /no checked stage lockfile/);
  // Covered again, and clear: everything closes.
  await reconcileAdvisories(report([], []), github.gh, quiet);
  assert.deepEqual(open(), []);
  // A report that doesn't say what it covered is refused.
  await assert.rejects(reconcileAdvisories({ ...report([], []), gaps: undefined }, github.gh, quiet), /couldn't cover/);
});

// ------------------------------------------------------ the evaluate job ----

/** A fake evaluator io whose builds return stage lockfiles. */
function fakeIo({ tags = [PINNED, NEWEST], builds = {}, carried = null, propose = async (tool) => lockEntry(toolLock(tool, [])), reviews = {} } = {}) {
  const calls = { build: [], proposed: [], reviews: [] };
  const io = {
    show,
    revParse: (ref) => (ref === NEWEST ? sha("a") : sha("0")),
    tags: () => tags,
    knownDeviceTools: () => new Set(),
    reviewAddedDeviceTools: async (previous, next, known, opts) => {
      calls.reviews.push(opts);
      const added = [...new Set(next)].filter((tool) => !previous.includes(tool) && !known.has(tool));
      return added.map((tool) => ({ tool, ok: true, reasons: [], lock: lockEntry(toolLock(tool, ["helper@1.0.0"])), ...reviews[tool] }));
    },
    proposeToolLock: async (tool) => {
      calls.proposed.push(tool);
      return propose(tool);
    },
    dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [] }),
    npmMeta,
    openAdvisories: async () => [],
    makeFastLane: () => async () => null,
    checkRules: () => ({ ok: true, skipped: [] }),
    resolveLock: () => UPSTREAM,
    build: async (ref, at, opts) => {
      calls.build.push({ ref, sha: at, locks: opts.locks });
      if (builds[at] instanceof Error) throw builds[at];
      return { skipped: [], stageLocks: [STAGE_LOCK], ...builds[at] };
    },
    carriedStage: () => carried,
    blackout: () => BLACKOUT,
    log: () => {},
  };
  return { io, calls };
}

test("the evaluate job keeps a stage record for each release it builds, and for the pinned one", async () => {
  // A new pin: its build's staged lockfiles, bound to it.
  const moved = fakeIo();
  const pinnedNew = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, moved.io);
  assert.equal(pinnedNew.pin.channels.nightly.ref, NEWEST);
  assert.deepEqual(readStageRecord(JSON.stringify(pinnedNew.stages.get(sha("a"))), { sha: sha("a"), blackout: BLACKOUT }).locks, [STAGE_LOCK]);
  assert.equal(pinnedNew.stages.get(sha("a")).blackout, BLACKOUT);
  assert.deepEqual(moved.calls.build.map((b) => b.sha), [sha("a")], "the pinned release isn't rebuilt when a new one is pinned");
  // Nothing newer: the record from the last run is carried over, nothing is built.
  const kept = record();
  const carried = fakeIo({ tags: [PINNED], carried: kept });
  const current = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, carried.io);
  assert.deepEqual(current.stages.get(sha("0")), JSON.parse(kept));
  assert.deepEqual(carried.calls.build, []);
  // Nothing newer and nothing carried over (first run, new overrides): the pinned release is built once.
  const fresh = fakeIo({ tags: [PINNED] });
  const built = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, fresh.io);
  assert.deepEqual(fresh.calls.build.map((b) => b.sha), [sha("0")]);
  assert.ok(built.stages.has(sha("0")));
  // Every candidate held: the same.
  const held = fakeIo({ builds: { [sha("a")]: new Error("typecheck failed") } });
  const heldResult = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, held.io);
  assert.equal(heldResult.exitCode, 3);
  assert.deepEqual(held.calls.build.map((b) => b.sha), [sha("a"), sha("0")]);
  assert.ok(heldResult.stages.has(sha("0")) && !heldResult.stages.has(sha("a")));
  // The pinned release doesn't build: said in the report, and no record.
  const broken = fakeIo({ tags: [PINNED], builds: { [sha("0")]: new Error("npm 404") } });
  const brokenResult = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, broken.io);
  assert.equal(brokenResult.stages.size, 0);
  assert.match(brokenResult.report, /couldn't be recorded here, so the advisory check can't cover it: npm 404/);
  // Without --build nothing is built for it.
  const dry = fakeIo({ tags: [PINNED] });
  assert.equal((await evaluateChannel({ channel: "nightly", pin: PIN }, dry.io)).stages.size, 0);
  assert.deepEqual(dry.calls.build, []);
});

test("the evaluator keeps a lockfile for each tool it clears, and proposes one for a reviewed tool without", async () => {
  const unlocked = { ...PIN, deviceToolLocks: {} };
  const { io, calls } = fakeIo();
  const result = await evaluateChannel({ channel: "nightly", pin: unlocked, build: true }, io);
  assert.deepEqual(calls.proposed, [TOOL]);
  assert.deepEqual(Object.keys(result.pin.deviceToolLocks), [TOOL]);
  assert.deepEqual(calls.build[0].locks, { [TOOL]: result.pin.deviceToolLocks[TOOL] }, "the build installs the proposed lockfile");
  assert.deepEqual(calls.reviews[0], { previousLocks: {} });
  // A newly cleared tool brings its reviewed lockfile with it.
  const bumped = fakeIo();
  bumped.io.show = (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : at === sha("a") ? JSON.stringify({ "expo-device-hub": "0.19.1" }) : TOOLS);
  const next = await evaluateChannel({ channel: "nightly", pin: PIN, build: true }, bumped.io);
  assert.deepEqual(Object.keys(next.pin.deviceToolLocks).sort(), [TOOL, "expo-device-hub@0.19.1"]);
  assert.equal(next.pin.deviceToolLocks[TOOL], PIN.deviceToolLocks[TOOL], "a kept lockfile isn't changed");
  assert.deepEqual(bumped.calls.proposed, []);
  // No lockfile can be had: held, with the reason.
  const failing = fakeIo({ propose: async () => Promise.reject(new Error("npm has no publish time")) });
  const heldResult = await evaluateChannel({ channel: "nightly", pin: unlocked }, failing.io);
  assert.equal(heldResult.exitCode, 3);
  assert.match(heldResult.report, /no dependency lockfile to keep for it: npm has no publish time/);
});

// -------------------------------------------------------- the commit job ----

test("the commit job checks the kept lockfiles: only for tools the release pins, verified, and none missing", async () => {
  const candidate = (locks) => ({ ...PIN, channels: { nightly: { ref: NEWEST, sha: sha("a"), evaluatedAt: "2026-10-31T01:00:00.000Z", leftOut: [] } }, deviceToolLocks: locks });
  const calls = [];
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS),
    unreleasedPin: () => null,
    knownDeviceTools: () => new Set(),
    reviewAddedDeviceTools: async (previous, next, known, opts) => {
      calls.push(opts);
      return [];
    },
    resolvedLock: () => UPSTREAM,
    dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [] }),
    npmMeta: async () => null,
    openAdvisories: async () => [],
    makeFastLane: () => async () => null,
    checkRules: () => ({ ok: true, skipped: [] }),
    log: () => {},
  };
  const verify = (locks) => verifyCandidate({ current: PIN, candidate: candidate(locks), channel: "nightly" }, io);
  assert.equal(await verify(PIN.deviceToolLocks), "changed");
  assert.deepEqual(calls[0], { locks: PIN.deviceToolLocks, previousLocks: PIN.deviceToolLocks }, "every lockfile goes to review, with the ones already kept");
  await assert.rejects(verify({ ...PIN.deviceToolLocks, "evil@1.0.0": lockEntry(toolLock("evil@1.0.0", [])) }), /keeps dependency lockfiles for device tools .* doesn't pin: evil@1\.0\.0/);
  const unlocked = { ...PIN, deviceToolLocks: {} };
  await assert.rejects(verifyCandidate({ current: unlocked, candidate: candidate({}), channel: "nightly" }, io), /no dependency lockfile for device tools it pins: expo-device-hub@0\.19\.0/);
});
