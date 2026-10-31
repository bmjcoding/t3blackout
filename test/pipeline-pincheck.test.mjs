// node --test test/*.test.mjs: the commit job's re-derivation (lib/pincheck.mjs).
// The evaluate job's pin.json is only a proposal: each case is a proposal a
// compromised evaluate job could make, refused here from git, npm and OSV alone.
import { test } from "node:test";
import assert from "node:assert/strict";

import { lockEntry } from "../lib/device-tools.mjs";
import { verifyCandidate } from "../lib/pincheck.mjs";
import { COMMON, UPSTREAM, lockfile } from "./pipeline-fixtures.mjs";

const sha = (c) => c.repeat(40);
const PINNED = "v0.1.6-nightly.20261030.3917";
const NEXT = "v0.1.7-nightly.20261031.4001";
/** A stand-in for a device tool's reviewed package-lock.json, as pin.json keeps it. */
const LOCK = (tool) => lockEntry(`${JSON.stringify({ lockfileVersion: 3, tool })}\n`);
const CURRENT = {
  version: 1,
  channels: { nightly: { ref: PINNED, sha: sha("0"), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } },
  deviceTools: ["agent-device@0.21.31"],
  deviceToolLocks: { "agent-device@0.21.31": LOCK("agent-device@0.21.31") },
};
/** CURRENT moved to NEXT, approving `tools`, each with its lock kept. */
const moved = (extra = {}, tools = CURRENT.deviceTools) => ({
  ...CURRENT,
  channels: { nightly: { ref: NEXT, sha: sha("a"), evaluatedAt: "2026-10-31T01:00:00.000Z", leftOut: [], ...extra } },
  deviceTools: tools,
  deviceToolLocks: Object.fromEntries(tools.map((tool) => [tool, LOCK(tool)])),
});
const clean = { ok: true, added: 0, young: [], waived: [], unknown: [] };

function fakeIo({ tools = { [sha("0")]: "0.21.31", [sha("a")]: "0.21.31" }, released = true, reviews = {}, gate = async () => clean, resolved = { [sha("0")]: UPSTREAM, [sha("a")]: UPSTREAM }, check = { ok: true, skipped: [] } } = {}) {
  const calls = { reviews: [], checkRules: [] };
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : tools[at] ? JSON.stringify({ "agent-device": tools[at] }) : null),
    unreleasedPin: (previous, next) => (released ? null : `pins nightly to ${next.channels.nightly.ref} at ${next.channels.nightly.sha.slice(0, 10)}, but upstream's ${next.channels.nightly.ref} is missing`),
    knownDeviceTools: () => new Set(["agent-device@0.21.25"]),
    reviewAddedDeviceTools: async (previous, next, known) => {
      const reviewed = new Set([...known, ...previous]);
      const added = [...new Set(next)].filter((tool) => !reviewed.has(tool));
      calls.reviews.push(added);
      return added.map((tool) => ({ tool, ...(reviews[tool] ?? { ok: true, reasons: [] }) }));
    },
    resolvedLock: (at) => resolved[at] ?? null,
    dependencyAgeGate: (base, lock, opts) => gate(base, lock, opts),
    openAdvisories: async () => [],
    makeFastLane: () => async () => null,
    checkRules: (ref, at, opts) => {
      calls.checkRules.push({ ref, sha: at, approvals: opts.approvals });
      return check;
    },
    log: () => {},
  };
  return { io, calls };
}

const verify = (candidate, options = {}) => {
  const { io, calls } = fakeIo(options);
  return { result: verifyCandidate({ current: CURRENT, candidate, channel: "nightly" }, io), calls };
};

test("a real, newer release that passes everything is signed; an identical pin is left alone", async () => {
  const { result, calls } = verify(moved());
  assert.equal(await result, "changed");
  assert.deepEqual(calls.checkRules, [{ ref: NEXT, sha: sha("a"), approvals: [] }]);
  assert.equal(await verify(structuredClone(CURRENT)).result, "unchanged");
});

test("an approval for a device tool the release doesn't pin is refused (PIPE-01, SUPPLY-03)", async () => {
  await assert.rejects(verify(moved({}, ["agent-device@0.21.31", "unreviewed-attacker-tool@1.0.0"])).result, /approves device tools .* doesn't pin: unreviewed-attacker-tool@1\.0\.0/);
});

test("an approval for a version the release pins is reviewed here, and refused when review fails", async () => {
  const tools = { [sha("0")]: "0.21.31", [sha("a")]: "0.21.40" };
  const { result, calls } = verify(moved({}, ["agent-device@0.21.31", "agent-device@0.21.40"]), { tools });
  assert.equal(await result, "changed");
  assert.deepEqual(calls.reviews, [["agent-device@0.21.40"]]);
  assert.deepEqual(calls.checkRules[0].approvals, ["agent-device@0.21.40"]);
  const failing = { "agent-device@0.21.40": { ok: false, reasons: ["new network hosts: evil.example.net"] } };
  await assert.rejects(verify(moved({}, ["agent-device@0.21.31", "agent-device@0.21.40"]), { tools, reviews: failing }).result, /approves agent-device@0\.21\.40: new network hosts/);
  await assert.rejects(verify(moved(), { tools }).result, /pins unreviewed device tools agent-device@0\.21\.40/);
});

test("only the evaluated channel may move, strictly forward, and only to what upstream's tag names", async () => {
  await assert.rejects(verify({ ...CURRENT, channels: { ...CURRENT.channels, stable: { ref: "v0.1.6", sha: sha("e"), evaluatedAt: "2026-10-31T01:00:00.000Z", leftOut: [] } } }).result, /changes stable/);
  const noNightly = { ...CURRENT, channels: {} };
  await assert.rejects(verifyCandidate({ current: noNightly, candidate: moved(), channel: "nightly" }, fakeIo().io), /adds a nightly pin/);
  await assert.rejects(verify({ ...CURRENT, deviceTools: ["agent-device@0.21.31", "agent-device@0.21.40"] }).result, /doesn't move nightly forward/);
  await assert.rejects(verify(moved({ ref: "v0.1.5-nightly.20261029.3877" })).result, /moves nightly back/);
  await assert.rejects(verify(moved(), { released: false }).result, /upstream's v0\.1\.7-nightly\.20261031\.4001 is missing/);
  await assert.rejects(verify(moved({ ref: "v0.1.7-nightly.badformat" })).result, /isn't a release tag/);
  await assert.rejects(verifyCandidate({ current: null, candidate: moved(), channel: "nightly" }, fakeIo().io), /main has no pin\.json/);
});

test("dependencies under the minimum age are refused, with the fast lane the evaluator had", async () => {
  const young = async (base, lock, opts) => (opts?.waive !== undefined ? { ...clean, ok: false, young: [{ pkg: "fresh@1.0.0", publishedAt: "2026-10-30T00:00:00Z" }] } : clean);
  await assert.rejects(verify(moved(), { gate: young }).result, /dependencies under 3 days old: fresh@1\.0\.0/);
  let waive = "unset";
  const watch = async (base, lock, opts) => {
    if (opts?.waive !== undefined) waive = opts.waive;
    return clean;
  };
  await verify(moved(), { gate: watch }).result;
  assert.equal(typeof waive, "function", "the fast lane from the pinned release's exposure");
  waive = "unset";
  await verify(moved(), { gate: watch, resolved: { [sha("a")]: UPSTREAM } }).result;
  assert.equal(typeof waive, "function", "the fast lane comes from upstream's own lockfile, not the evaluate job's resolution (SUPPLY2-01)");
});

test("the resolved lockfile must be there and fit upstream's", async () => {
  await assert.rejects(verify(moved(), { resolved: { [sha("0")]: UPSTREAM } }).result, /no resolved lockfile for v0\.1\.7/);
  const dropped = lockfile({ ...COMMON, "shared@1.0.0": undefined, "big@1.0.0": [], "app@1.0.0": ["vuln: 1.0.0"], "vuln@1.0.0": ["only-via-vuln: 1.0.0"], "only-via-vuln@1.0.0": [] });
  await assert.rejects(verify(moved(), { resolved: { [sha("0")]: UPSTREAM, [sha("a")]: dropped } }).result, /resolved lockfile: lacks 1 package version.*shared@1\.0\.0/);
});

test("the strip rules must apply, and every feature they leave out must be listed", async () => {
  await assert.rejects(verify(moved(), { check: { ok: false, message: "upstream names 1 new network host(s). Nothing was installed." } }).result, /new network host/);
  await assert.rejects(verify(moved(), { check: { ok: true, skipped: ["names"] } }).result, /doesn't list features its rules leave out: names/);
  assert.equal(await verify(moved({ leftOut: ["names"] }), { check: { ok: true, skipped: ["names"] } }).result, "changed");
  await assert.rejects(verify(moved({ leftOut: ["no-such-feature"] })).result, /features that don't exist: no-such-feature/);
});
