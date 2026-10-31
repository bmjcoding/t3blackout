// node --test test/: the evaluate job's resolved lockfile is an untrusted proposal
// (SUPPLY2-01, PIPE2-01). What a security fix is measured against comes from
// upstream's lockfile at the pinned commit and the owner's overrides alone
// (trustedInventory), and the proposal itself is checked completely: importers,
// every untouched package's version, dependencies and bytes, each override's fix,
// and what the fixes bring in against npm.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { baseExposure } from "../lib/evaluate.mjs";
import { addedPackageProblems, checkResolvedLock, trustedInventory } from "../lib/inventory.mjs";
import { verifyCandidate } from "../lib/pincheck.mjs";
import { COMMON, OVERRIDES, RESOLVED, UPSTREAM, lockfile } from "./pipeline-fixtures.mjs";

const TOOLS = JSON.stringify({ "agent-device": "0.21.31" });
/** RESOLVED with vuln@1.0.1's own dependencies replaced. */
const resolvedWith = (vulnDeps, extra = {}) => lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0"], "vuln@1.0.1": vulnDeps, "newdep@3.0.0": [], ...extra });
/** npm metadata: vuln@1.0.1 asks for newdep ^3.0.0. */
const meta = async (name) =>
  ({
    vuln: { versions: { "1.0.1": { dependencies: { newdep: "^3.0.0" } } } },
    newdep: { versions: { "3.0.0": {}, "4.0.0": {} } },
    attacker: { versions: { "1.0.0": {} } },
  })[name] ?? null;
const check = (resolvedLock) => checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock, overrides: OVERRIDES });

test("trustedInventory: upstream's packages a build keeps, the overrides' fixes and the release's device tools; nothing else", () => {
  const packages = trustedInventory({ upstreamLock: UPSTREAM, deviceTools: ["agent-device@0.21.31"], overrides: OVERRIDES });
  assert.deepEqual(packages, ["@tsc-rs/typescript@0.8.0", "agent-device@0.21.31", "app@1.0.0", "big@1.0.0", "pnpm@12.14.0", "shared@1.0.0", "vuln@1.0.1"]);
  assert.throws(() => trustedInventory({ upstreamLock: null, deviceTools: [], overrides: OVERRIDES }), /missing at the pinned commit/);
});

test("the fast lane never sees what the evaluate job's lockfile adds (SUPPLY2-01's repro, through verifyCandidate)", async () => {
  const poisoned = resolvedWith(["newdep: 3.0.0", "attacker: 1.0.0"], { "attacker@1.0.0": [] });
  let base = null;
  const io = {
    show: (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : TOOLS),
    unreleasedPin: () => null,
    knownDeviceTools: () => new Set(),
    reviewAddedDeviceTools: async () => [],
    resolvedLock: () => poisoned,
    openAdvisories: async () => [],
    makeFastLane: ({ basePackages }) => {
      base = basePackages;
      return async () => null;
    },
    dependencyAgeGate: async () => ({ ok: true, added: 0, young: [], waived: [], unknown: [], substituted: [] }),
    npmMeta: meta,
    checkRules: () => ({ ok: true, skipped: [] }),
    log: () => {},
  };
  const sha = (c) => c.repeat(40);
  const entry = (ref, at) => ({ ref, sha: at, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] });
  const lock = '{"lockfileVersion":3}\n';
  const deviceToolLocks = { "agent-device@0.21.31": { sha256: createHash("sha256").update(lock).digest("hex"), lock } };
  const current = { version: 1, channels: { nightly: entry("v0.1.6-nightly.20261030.3917", sha("0")) }, deviceTools: ["agent-device@0.21.31"], deviceToolLocks };
  const candidate = { ...current, channels: { nightly: entry("v0.1.7-nightly.20261031.4001", sha("a")) } };
  // (verifyCandidate checks the proposal against the repo's real overrides, so here it just doesn't fit.)
  await assert.rejects(verifyCandidate({ current, candidate, channel: "nightly" }, io), /resolved lockfile:/);
  assert.ok(base, "the fast lane was built");
  assert.ok(!base.includes("attacker@1.0.0"));
  const exposure = await baseExposure({ sha: sha("0"), upstreamLock: UPSTREAM, deviceToolsText: TOOLS, overrides: OVERRIDES }, { openAdvisories: async () => [] });
  assert.deepEqual(exposure.packages, trustedInventory({ upstreamLock: UPSTREAM, deviceTools: ["agent-device@0.21.31"], overrides: OVERRIDES }));
});

test("a faithful resolution fits, with what the override brought in listed for npm to check", async () => {
  const { problems, added, packages } = check(RESOLVED);
  assert.deepEqual(problems, []);
  assert.deepEqual(added, ["newdep@3.0.0", "vuln@1.0.1"]);
  assert.ok(!packages.includes("vuln@1.0.0") && !packages.includes("only-via-vuln@1.0.0"));
  assert.deepEqual(await addedPackageProblems({ resolvedLock: RESOLVED, added, overrides: OVERRIDES }, { meta }), []);
});

test("an invented, rewired, swapped or unfixed resolution doesn't fit (PIPE2-01)", () => {
  // An extra predecessor hung off a package upstream has.
  const extra = lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0", "attacker: 1.0.0"], "attacker@1.0.0": [], "vuln@1.0.1": ["newdep: 3.0.0"], "newdep@3.0.0": [] });
  assert.match(check(extra).problems.join("\n"), /gives 1 package\(s\) other dependencies than upstream's lockfile: app@1\.0\.0/);
  // The override's fix left out (and its subtree with it).
  const unfixed = lockfile({ ...COMMON, "app@1.0.0": ["shared: 1.0.0"] });
  assert.match(check(unfixed).problems.join("\n"), /lacks the security override fix\(es\) vuln@1\.0\.1/);
  // The overridden version kept.
  assert.match(check(UPSTREAM).problems.join("\n"), /still has overridden versions: vuln@1\.0\.0/);
  // Another version of an untouched package.
  const bumped = lockfile({ ...COMMON, "shared@1.0.0": undefined, "shared@1.1.0": [], "big@1.0.0": ["shared: 1.1.0"], "app@1.0.0": ["vuln: 1.0.1", "shared: 1.1.0"], "vuln@1.0.1": ["newdep: 3.0.0"], "newdep@3.0.0": [] });
  assert.match(check(bumped).problems.join("\n"), /lacks 1 package version\(s\) .*shared@1\.0\.0/);
  // Same version, other bytes.
  const swapped = RESOLVED.replace(/('shared@1\.0\.0':\n {4}resolution: \{integrity: )sha512-\d+/, "$1sha512-c3dhcA==");
  assert.notEqual(swapped, RESOLVED);
  assert.match(check(swapped).problems.join("\n"), /resolves 1 version\(s\) to other bytes than upstream's lockfile: shared@1\.0\.0/);
  // A non-registry source.
  const tarball = RESOLVED.replace(/('newdep@3\.0\.0':\n {4}resolution: )\{integrity: (sha512-\d+)\}/, "$1{integrity: $2, tarball: 'https://example.org/newdep.tgz'}");
  assert.match(check(tarball).problems.join("\n"), /newdep@3\.0\.0 is resolved from https:\/\/example\.org\/newdep\.tgz/);
});

test("what an override brings in must be what its dependents ask for on npm", async () => {
  const problems = async (resolvedLock) => addedPackageProblems({ resolvedLock, added: check(resolvedLock).added, overrides: OVERRIDES }, { meta });
  assert.deepEqual(await problems(resolvedWith([])), ["vuln@1.0.1 needs newdep, which the resolved lockfile doesn't give it"]);
  assert.deepEqual(await problems(resolvedWith(["newdep: 4.0.0"], { "newdep@3.0.0": undefined, "newdep@4.0.0": [] })), ["vuln@1.0.1 asks for newdep@^3.0.0, not newdep@4.0.0"]);
  assert.deepEqual(await problems(resolvedWith(["newdep: 3.0.0", "attacker: 1.0.0"], { "attacker@1.0.0": [] })), ["vuln@1.0.1 gets attacker@1.0.0, which its package.json doesn't ask for"]);
  await assert.rejects(addedPackageProblems({ resolvedLock: RESOLVED, added: ["vuln@1.0.1"], overrides: OVERRIDES }, { meta: async () => assert.fail("offline") }), /offline/);
});
