// node --test test/: which security-override fixes a resolution must carry
// (SUPPLY3-08). An overridden version reached only through another overridden
// one is replaced with it: an honest resolution whose fixed parent no longer
// needs it isn't rejected for leaving it out, while a fix the transformed graph
// still reaches stays mandatory, and an overridden version stays forbidden.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkResolvedLock, trustedInventory } from "../lib/inventory.mjs";
import { COMMON, OVERRIDES, RESOLVED, UPSTREAM, lockfile } from "./pipeline-fixtures.mjs";

const NESTED = [...OVERRIDES, { selector: "only-via-vuln@1.0.0", version: "1.0.1", advisories: ["GHSA-removed-child"] }];

test("SUPPLY3-08: an override's child that the fixed parent dropped isn't a mandatory fix", () => {
  const { problems, added } = checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: RESOLVED, overrides: NESTED });
  assert.deepEqual(problems, []);
  assert.deepEqual(added, ["newdep@3.0.0", "vuln@1.0.1"]);
  // The fast lane's floor only counts fixes a build still reaches.
  assert.ok(!trustedInventory({ upstreamLock: UPSTREAM, deviceTools: [], overrides: NESTED }).includes("only-via-vuln@1.0.1"));
});

test("an overridden version upstream reaches directly still needs its fix, and may not survive", () => {
  // Upstream's app also depends on only-via-vuln directly: the override applies there.
  const upstream = lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.0", "shared: 1.0.0", "only-via-vuln: 1.0.0"], "vuln@1.0.0": ["only-via-vuln: 1.0.0", "shared: 1.0.0"], "only-via-vuln@1.0.0": [] });
  const missing = lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0"], "vuln@1.0.1": ["newdep: 3.0.0"], "newdep@3.0.0": [] });
  assert.match(checkResolvedLock({ upstreamLock: upstream, resolvedLock: missing, overrides: NESTED }).problems.join("; "), /lacks the security override fix\(es\) only-via-vuln@1\.0\.1/);
  const survived = lockfile({ ...COMMON, "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0"], "vuln@1.0.1": ["newdep: 3.0.0", "only-via-vuln: 1.0.0"], "newdep@3.0.0": [], "only-via-vuln@1.0.0": [] });
  assert.match(checkResolvedLock({ upstreamLock: UPSTREAM, resolvedLock: survived, overrides: NESTED }).problems.join("; "), /still has overridden versions: only-via-vuln@1\.0\.0/);
  assert.ok(trustedInventory({ upstreamLock: upstream, deviceTools: [], overrides: NESTED }).includes("only-via-vuln@1.0.1"));
});
