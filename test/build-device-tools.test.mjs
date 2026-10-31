// node --test test/: device tools' dependency closures (lib/device-tools.mjs,
// SUPPLY-09, BUILD2-02), offline: the registry steps are stand-ins.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { NPM_FALLBACK, checkToolClosure, closurePackages, deviceToolLocks, lockEntry, reviewToolClosure, verifyToolLock } from "../lib/device-tools.mjs";
import { reviewAddedDeviceTools } from "../lib/gates.mjs";
import { makeRules } from "../lib/rules.mjs";

const REG = "https://registry.npmjs.org/";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const tarball = (name, version) => `${REG}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
const integrity = (pkg) => `sha512-${createHash("sha512").update(pkg).digest("base64")}`;

/** A package-lock.json (v3) for `tool` (name@version) and its closure, as { "name@version": extra entry fields }. */
function lock(tool, packages) {
  const at = tool.lastIndexOf("@");
  const entries = Object.fromEntries(
    Object.entries(packages).map(([pkg, extra]) => {
      const i = pkg.lastIndexOf("@");
      const name = pkg.slice(0, i);
      const version = pkg.slice(i + 1);
      return [`node_modules/${name}`, { version, resolved: tarball(name, version), integrity: integrity(pkg), ...extra }];
    }),
  );
  const root = { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [tool.slice(0, at)]: tool.slice(at + 1) } };
  return `${JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", lockfileVersion: 3, requires: true, packages: { "": root, ...entries } }, null, 2)}\n`;
}

/**
 * npm metadata as the registry would send it for `published` ({ "name@version": ISO
 * time }). `tool` depends on every other package published here (any version), so
 * the closure is what npm installs for it.
 */
const registry = (published, change = {}) => async (name) => {
  const versions = {};
  const time = {};
  const others = [...new Set(Object.keys(published).map((pkg) => pkg.slice(0, pkg.lastIndexOf("@"))))].filter((other) => other !== "tool");
  for (const [pkg, at] of Object.entries(published)) {
    const i = pkg.lastIndexOf("@");
    if (pkg.slice(0, i) !== name) continue;
    const version = pkg.slice(i + 1);
    const dependencies = name === "tool" ? { dependencies: Object.fromEntries(others.map((other) => [other, "*"])) } : {};
    versions[version] = { ...dependencies, dist: { tarball: tarball(name, version), integrity: integrity(pkg), ...change[pkg] } };
    time[version] = at;
  }
  return Object.keys(versions).length ? { versions, time } : null;
};

/** Stand-in for fetching a registry tarball: a package.json with an install script for `native`. */
const fetchPackage = async (name, version, into) => {
  const dir = path.join(into, "package");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, scripts: name === "native" ? { install: "prebuild-install" } : {} }));
  return { dir };
};

const OLD = "2026-10-01T00:00:00.000Z";

test("a closure must be the registry's own tarballs with integrity hashes, inside node_modules", () => {
  assert.deepEqual([...closurePackages(lock("tool@1.0.0", { "tool@1.0.0": {}, "@s/helper@1.0.1": {} })).keys()], ["tool@1.0.0", "@s/helper@1.0.1"]);
  assert.throws(() => closurePackages(lock("tool@1.0.0", { "tool@1.0.0": { resolved: "https://evil.example.org/tool.tgz" } })), /isn't a registry package/);
  assert.throws(() => closurePackages(lock("tool@1.0.0", { "tool@1.0.0": { resolved: `${REG}tool/-/tool-6.6.6.tgz` } })), /isn't a registry package/);
  assert.throws(() => closurePackages(lock("tool@1.0.0", { "tool@1.0.0": { integrity: undefined } })), /isn't a registry package/);
  assert.throws(() => closurePackages(lock("tool@1.0.0", { "tool@1.0.0": { link: true } })), /isn't a registry package/);
  const outside = JSON.parse(lock("tool@1.0.0", { "tool@1.0.0": {} }));
  outside.packages["../elsewhere/node_modules/tool"] = outside.packages["node_modules/tool"];
  assert.throws(() => closurePackages(JSON.stringify(outside)), /outside its node_modules/);
});

test("BUILD2-02: a kept lock is checked on its exact bytes against npm, never resolved again", async () => {
  const text = lock("tool@1.0.0", { "tool@1.0.0": {}, "helper@1.0.0": {} });
  const entry = lockEntry(text);
  const meta = registry({ "tool@1.0.0": OLD, "helper@1.0.0": OLD });
  assert.deepEqual((await verifyToolLock("tool@1.0.0", entry, { now: NOW, meta })).packages, ["helper@1.0.0", "tool@1.0.0"]);
  // Bytes that don't match the recorded SHA-256.
  await assert.rejects(verifyToolLock("tool@1.0.0", { ...entry, lock: text.replace("1.0.0", "1.0.1") }, { now: NOW, meta }), /doesn't match its sha256/);
  // A lock for something else, or with more at its root.
  await assert.rejects(verifyToolLock("tool@2.0.0", entry, { now: NOW, meta }), /isn't for tool@2\.0\.0 alone/);
  const extraRoot = JSON.parse(text);
  extraRoot.packages[""].dependencies.evil = "1.0.0";
  await assert.rejects(verifyToolLock("tool@1.0.0", lockEntry(JSON.stringify(extraRoot)), { now: NOW, meta }), /isn't for tool@1\.0\.0 alone/);
  // The registry publishes different bytes for that version (SUPPLY2-02 for tools), or it's young or undated.
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry({ "tool@1.0.0": OLD, "helper@1.0.0": OLD }, { "helper@1.0.0": { integrity: "sha512-BBBB" } }) }), /helper@1\.0\.0 \(its tarball or integrity isn't npm's\)/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry({ "tool@1.0.0": OLD, "helper@1.0.0": "2026-10-29T00:00:00.000Z" }) }), /helper@1\.0\.0 \(published 2026-10-29.*under 3 days/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry({ "tool@1.0.0": OLD, "helper@1.0.0": "soon" }) }), /helper@1\.0\.0 \(no publish time/);
  await assert.rejects(verifyToolLock("tool@1.0.0", entry, { now: NOW, meta: registry({ "tool@1.0.0": OLD }) }), /helper@1\.0\.0 \(not on npm\)/);
  // A lock without the tool in it.
  const without = lock("tool@1.0.0", { "helper@1.0.0": {} });
  await assert.rejects(verifyToolLock("tool@1.0.0", lockEntry(without), { now: NOW, meta }), /doesn't contain tool@1\.0\.0/);
});

test("BUILD2-02: the build bakes the kept bytes even when the registry would now resolve something else", async () => {
  const kept = lock("tool@1.0.0", { "tool@1.0.0": {}, "helper@1.0.0": {} });
  const pinJson = { deviceToolLocks: { "tool@1.0.0": lockEntry(kept) } };
  // helper@1.1.0 exists now (a moved dist-tag would pick it up on a fresh resolution); the build doesn't resolve.
  const meta = registry({ "tool@1.0.0": OLD, "helper@1.0.0": OLD, "helper@1.1.0": OLD });
  const locks = await deviceToolLocks(["tool@1.0.0"], { pinJson, nativeAssets: { version: 1, packages: {} }, now: NOW, meta, fetch: fetchPackage });
  assert.equal(locks["tool@1.0.0"].lock, kept);
  assert.match(locks["tool@1.0.0"].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(locks["tool@1.0.0"].manifest), { name: "t3blackout-device-tool", version: "0.0.0", private: true, dependencies: { tool: "1.0.0" } });
  // No kept lock: the build stops, saying what to do.
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { pinJson: { deviceToolLocks: {} }, nativeAssets: { version: 1, packages: {} }, now: NOW, meta, fetch: fetchPackage }), /no reviewed dependency lockfile for device tool tool@1\.0\.0/);
  // A tampered kept lock.
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { pinJson: { deviceToolLocks: { "tool@1.0.0": { sha256: "0".repeat(64), lock: kept } } }, nativeAssets: { version: 1, packages: {} }, now: NOW, meta, fetch: fetchPackage }), /doesn't match its sha256/);
  // An install script the native-assets manifest doesn't cover holds it (BUILD2-03).
  const scripted = lock("tool@1.0.0", { "tool@1.0.0": {}, "native@2.0.0": { hasInstallScript: true } });
  const scriptedPin = { deviceToolLocks: { "tool@1.0.0": lockEntry(scripted) } };
  await assert.rejects(
    deviceToolLocks(["tool@1.0.0"], { pinJson: scriptedPin, nativeAssets: { version: 1, packages: {} }, now: NOW, meta: registry({ "tool@1.0.0": OLD, "native@2.0.0": OLD }), fetch: fetchPackage }),
    /native@2\.0\.0 have install scripts.*lib\/native-assets\.json/,
  );
});

test("a proposed closure is resolved as of the tool's publish time, then checked like a kept one", async () => {
  let asked = null;
  const resolve = (pin, { before }) => {
    asked = before;
    return { manifest: "{}", lock: lock("tool@1.0.0", { "tool@1.0.0": {}, "helper@1.0.1": {} }) };
  };
  const published = async () => "2026-10-20T00:00:00.000Z";
  const young = registry({ "tool@1.0.0": OLD, "helper@1.0.1": "2026-10-29T00:00:00.000Z" });
  await assert.rejects(checkToolClosure("tool@1.0.0", { resolve, publishedAt: published, now: NOW, verify: (pin, entry, opts) => verifyToolLock(pin, entry, { ...opts, meta: young }) }), /helper@1\.0\.1 \(published 2026-10-29/);
  assert.equal(asked, "2026-10-20T00:00:00.000Z");
  const meta = registry({ "tool@1.0.0": OLD, "helper@1.0.1": OLD });
  const ok = await checkToolClosure("tool@1.0.0", { resolve, publishedAt: published, now: NOW, verify: (pin, entry, opts) => verifyToolLock(pin, entry, { ...opts, meta }) });
  assert.deepEqual(ok.packages, ["helper@1.0.1", "tool@1.0.0"]);
  assert.equal(ok.entry.sha256, createHash("sha256").update(ok.entry.lock).digest("hex"));
});

/** Stand-in package fetch and scan: what each package version reaches. */
function scanner(scans) {
  const fetch = async (name, version, into) => {
    fs.mkdirSync(into, { recursive: true });
    return { dir: `${name}@${version}` };
  };
  const scan = (dir) => ({ hosts: new Set(scans[dir] ?? []), analytics: new Set(dir === "fresh@1.0.0" ? ["posthog"] : []) });
  return { fetch, scan };
}
const isKnownHost = (host) => ["github.com", "registry.npmjs.org"].includes(host);

test("SUPPLY-09: a dependency the previous kept lock didn't have is scanned like the tool; registry trouble holds it", async () => {
  const next = lockEntry(lock("tool@2.0.0", { "tool@2.0.0": {}, "helper@1.1.0": {}, "fresh@1.0.0": {} }));
  const previous = lockEntry(lock("tool@1.0.0", { "tool@1.0.0": {}, "helper@1.0.0": {} }));
  const verify = async (pin, entry) => ({ pin, packages: [...closurePackages(entry.lock).keys()].sort() });
  const { fetch, scan } = scanner({ "helper@1.0.0": ["github.com"], "helper@1.1.0": ["github.com", "collector.evil.example.org"], "fresh@1.0.0": ["registry.npmjs.org"] });
  const check = async () => {
    throw new Error("a kept lock must not be resolved again");
  };
  const review = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, lock: next, previousLock: previous, check, verify, fetch, scan });
  assert.equal(review.ok, false);
  assert.deepEqual(review.reasons, ["dependency fresh@1.0.0: new analytics names: posthog", "dependency helper@1.1.0: new network hosts: collector.evil.example.org"]);
  assert.equal(review.lock, next);
  // Without a kept previous lock nothing counts as reviewed: helper@1.1.0 is compared with nothing.
  const fresh = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, lock: next, check, verify, fetch, scan });
  assert.ok(fresh.reasons.includes("dependency helper@1.1.0: new network hosts: collector.evil.example.org"));
  const failing = await reviewToolClosure("tool@2.0.0", "tool@1.0.0", { isKnownHost, verify: async () => { throw new Error("npm is down"); }, lock: next });
  assert.deepEqual(failing, { ok: false, pin: "tool@2.0.0", reasons: ["npm is down"], notes: [], lock: null });
});

test("reviewAddedDeviceTools with kept locks: an added tool needs one; a newly kept lock is reviewed; a lock added alongside is no baseline", async () => {
  const seen = [];
  const closure = async (tool, previous, opts) => {
    seen.push({ tool, previous, lock: opts.lock ?? null, previousLock: opts.previousLock ?? null });
    return { ok: true, reasons: [], lock: opts.lock ?? { sha256: "proposed" } };
  };
  const review = async () => ({ ok: true, reasons: [] });
  // Offline: the newest reviewed version by its version number, not npm's publish times.
  const latest = async (name, reviewed) => [...reviewed].filter((t) => t.startsWith(`${name}@`)).sort().at(-1) ?? null;
  const a = lockEntry(lock("tool@1.0.0", { "tool@1.0.0": {} }));
  const b = lockEntry(lock("tool@2.0.0", { "tool@2.0.0": {} }));
  // An added tool with no kept lock fails; nothing is resolved for it.
  const missing = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a }, previousLocks: { "tool@1.0.0": a } });
  assert.deepEqual(missing.map(({ tool, ok }) => ({ tool, ok })), [{ tool: "tool@2.0.0", ok: false }]);
  assert.match(missing[0].reasons[0], /keeps no reviewed dependency lockfile for tool@2\.0\.0/);
  assert.equal(seen.length, 0);
  // With one: reviewed against the previous version's kept lock.
  const added = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a, "tool@2.0.0": b }, previousLocks: { "tool@1.0.0": a } });
  assert.equal(added[0].ok, true);
  assert.deepEqual(seen.at(-1), { tool: "tool@2.0.0", previous: "tool@1.0.0", lock: b, previousLock: a });
  // A tool reviewed by hand gets its first kept lock: its closure is reviewed; the baseline lock added in the same pin doesn't count.
  seen.length = 0;
  const relocked = await reviewAddedDeviceTools([], [], { knownDeviceTools: ["tool@1.0.0", "tool@2.0.0"], isKnownHost, closure, review, latest, locks: { "tool@1.0.0": a, "tool@2.0.0": b }, previousLocks: {} });
  assert.deepEqual(relocked.map(({ tool }) => tool), ["tool@1.0.0", "tool@2.0.0"]);
  assert.ok(seen.every(({ previousLock }) => previousLock === null));
  // Proposing (the evaluate job): no kept locks, the result carries the lock to keep.
  const proposed = await reviewAddedDeviceTools(["tool@1.0.0"], ["tool@1.0.0", "tool@2.0.0"], { isKnownHost, closure, review, latest, previousLocks: { "tool@1.0.0": a } });
  assert.deepEqual(proposed[0].lock, { sha256: "proposed" });
  assert.deepEqual(seen.at(-1).previousLock, a);
});

test("the app installs device tools from the kept closures, with npm ci and no install scripts, and the npm fallback is exact", () => {
  const locks = { "agent-device@0.21.31": { manifest: '{"dependencies":{"agent-device":"0.21.31"}}', lock: "{}", digest: "d".repeat(64), needs: [], assets: [] } };
  const rules = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: { version: "1", sha: "a".repeat(40), changes: null, skipped: [], driftReport: null, deviceToolLocks: locks } });
  const local = rules.find((rule) => rule.id === "server/device-tools-frozen");
  const ssh = rules.find((rule) => rule.id === "server/device-tools-frozen-ssh");
  const replaced = (rule) => rule.edits.map((edit) => edit.replace).join("\n");
  assert.match(replaced(local), /BLACKOUT_DEVICE_TOOL_LOCKS[^=]*= \{"agent-device@0\.21\.31"/);
  assert.match(replaced(local), /\["ci", "--ignore-scripts", "--no-fund", "--no-audit"\]/);
  assert.match(replaced(local), new RegExp(`--package=${NPM_FALLBACK}`));
  assert.doesNotMatch(replaced(local), /npm@11"/);
  assert.match(replaced(ssh), /run\('npm', \['ci', '--ignore-scripts'/);
  assert.match(NPM_FALLBACK, /^npm@\d+\.\d+\.\d+$/);
  // A dry run (no build) installs nothing.
  const dry = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((rule) => rule.id === "server/device-tools-frozen");
  assert.match(replaced(dry), /= \{\};/);
});
