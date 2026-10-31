// node --test test/*.test.mjs: the lockfile graph and the advisory inventory a
// pinned release really installs (lib/lockfile.mjs, lib/inventory.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

import { alertInventory, checkResolvedLock, checkedResolvedLock, deviceToolsInUse } from "../lib/inventory.mjs";
import { COMMON, LONG_PEERS, OVERRIDES, RESOLVED, UPSTREAM, lockfile, npmMeta } from "./pipeline-fixtures.mjs";
import { parseLockfile, reachablePackages, registryPackages } from "../lib/lockfile.mjs";
import { applyOverrides } from "../lib/overrides.mjs";
import { lockPackages } from "../lib/gates.mjs";

test("parseLockfile reads every document, aliases, peers, links and `?` keys", () => {
  const lock = parseLockfile(UPSTREAM);
  assert.deepEqual([...lock.packages].sort(), ["@tsc-rs/typescript@0.8.0", "app@1.0.0", "big@1.0.0", "only-via-vuln@1.0.0", "peer@2.0.0", "pnpm@12.14.0", "shared@1.0.0", "vuln@1.0.0"]);
  assert.ok(lock.roots.includes("@tsc-rs/typescript@0.8.0"), "an alias points at its real package");
  assert.ok(!lock.roots.some((root) => root.startsWith("local@")), "workspace links aren't packages");
  assert.deepEqual(lock.deps.get(`big@1.0.0${LONG_PEERS}`), ["shared@1.0.0"]);
  assert.deepEqual(registryPackages(lock.packages), [...lockPackages(UPSTREAM)].sort());
});

test("parseLockfile refuses what it can't account for instead of skipping it", () => {
  assert.throws(() => parseLockfile("lockfileVersion: '6.0'\npackages: {}\n"), /version 6\.0 isn't supported/);
  assert.throws(() => parseLockfile(UPSTREAM.replace("  'shared@1.0.0': {}\n", "")), /refers to shared@1\.0\.0, which it has no snapshot/);
  assert.throws(() => parseLockfile(UPSTREAM.replace("snapshots:\n  'peer", "snapshots: &anchor\n  'peer")));
  assert.throws(() => parseLockfile(""), /empty/);
});

test("reachablePackages stops at a cut package and doesn't count what only it brought in", () => {
  const lock = parseLockfile(UPSTREAM);
  const cut = reachablePackages(lock, (pkg) => pkg === "vuln@1.0.0");
  assert.ok(!cut.has("vuln@1.0.0") && !cut.has("only-via-vuln@1.0.0"));
  assert.ok(cut.has("shared@1.0.0"), "still reachable without the overridden package");
});

test("the inventory is the resolved graph: override-added packages in, dropped ones out (PIPE-05)", () => {
  const { packages, problems } = checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: RESOLVED, overrides: OVERRIDES });
  assert.deepEqual(problems, []);
  assert.ok(packages.includes("newdep@3.0.0"), "a dependency the override brought in is scanned");
  assert.ok(packages.includes("vuln@1.0.1") && !packages.includes("vuln@1.0.0"));
  assert.ok(!packages.includes("only-via-vuln@1.0.0"), "a package only the old version needed isn't");
  // The old inventory (upstream's lockfile with versions substituted) got both wrong.
  const substituted = applyOverrides([...lockPackages(UPSTREAM)], OVERRIDES);
  assert.ok(!substituted.includes("newdep@3.0.0") && substituted.includes("only-via-vuln@1.0.0"));
});

test("a resolved lockfile that dropped a package no override explains, or kept an overridden one, doesn't fit", async () => {
  // shared is still needed without vuln (app and big use it), so it can't just go.
  const withoutShared = lockfile({ ...COMMON, "shared@1.0.0": undefined, "big@1.0.0": [], "app@1.0.0": ["vuln: 1.0.1"], "vuln@1.0.1": [] });
  const dropped = checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: withoutShared, overrides: OVERRIDES });
  assert.match(dropped.problems.join(), /lacks 1 package version.*shared@1\.0\.0/);
  const kept = checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: UPSTREAM, overrides: OVERRIDES });
  assert.match(kept.problems.join(), /still has overridden versions: vuln@1\.0\.0/);
  // The alert job's check says so too, and a lockfile it can't read is a problem, not a crash.
  assert.match((await checkedResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: withoutShared, overrides: OVERRIDES }, { meta: npmMeta })).problems.join(), /lacks 1 package version/);
  assert.match((await checkedResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: "lockfileVersion: '5.4'\n", overrides: OVERRIDES }, { meta: npmMeta })).problems.join(), /isn't supported/);
});

test("device tools in the inventory are the release's own, not every approval (PIPE-06)", async () => {
  const pins = JSON.stringify({ "agent-device": "0.21.31", "expo-device-hub": "0.19.0-canary-20261023-1357114" });
  const tools = deviceToolsInUse(pins);
  assert.deepEqual(tools, ["agent-device@0.21.31", "expo-device-hub@0.19.0-canary-20261023-1357114"]);
  const show = (at, file) => (file === "pnpm-lock.yaml" ? UPSTREAM : pins);
  const { packages } = await alertInventory({ sha: "0".repeat(40), show, resolvedLock: RESOLVED, toolPackages: (tool) => [tool], stage: null, overrides: OVERRIDES, blackout: "b" }, { meta: npmMeta });
  assert.ok(packages.includes("agent-device@0.21.31") && !packages.includes("agent-device@0.21.25"));
  assert.throws(() => deviceToolsInUse(null), /no longer pins device tools/);
  assert.throws(() => deviceToolsInUse('{"agent-device": "^1.0.0"}'), /no exact version/);
});
