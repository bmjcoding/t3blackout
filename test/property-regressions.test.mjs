// node --test test/: inputs property-based testing found, kept as plain tests so
// they run on every change: each was a wrong answer before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeAdvisories, severityOf } from "../lib/advisories.mjs";
import { cvssScore } from "../lib/cvss.mjs";
import { parseOverrides, parseToolOverrides } from "../lib/overrides.mjs";

test("a security override whose selector has no package name is refused, not read as the package `1.2.`", () => {
  const entry = { selector: "1.2.3", version: "1.2.4", advisories: ["GHSA-2222-3333-4444"] };
  assert.throws(() => parseOverrides(JSON.stringify({ overrides: [entry] })), /invalid entry/);
  assert.throws(() => parseToolOverrides(JSON.stringify({ overrides: [], deviceTools: [entry] })), /invalid deviceTools entry/);
  assert.equal(parseOverrides(JSON.stringify({ overrides: [{ ...entry, selector: "lodash@1.2.3" }] })).length, 1);
});

test("a severity entry that's null, or whose vector is an object, is unscored instead of stopping the scan", () => {
  for (const entry of [null, undefined, 7, "CVSS:3.1/AV:N", { type: "CVSS_V3", score: { toString: "" } }, { type: "CVSS_V3", score: ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"] }]) {
    assert.equal(cvssScore(entry), null, JSON.stringify(entry));
  }
  assert.equal(cvssScore({ type: "CVSS_V3", score: " CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H " }), 9.8);
  assert.equal(severityOf({ id: "GHSA-x", severity: [null, { type: "CVSS_V3", score: { toString: "" } }] }), "UNKNOWN");
});

test("merged fixed versions don't depend on the order the sources answered in, even when two differ only in build metadata", () => {
  const record = (fixed, source) => ({ id: "GHSA-2222-3333-4444", aliases: [], severity: "LOW", summary: "", packages: [{ pkg: "c@0.1.0", fixed: [fixed] }], sources: [source] });
  const a = record("1.0.1+build", "osv");
  const b = record("1.0.1", "github");
  assert.deepEqual(mergeAdvisories([a, b]), mergeAdvisories([b, a]));
  assert.deepEqual(mergeAdvisories([a, b])[0]?.packages[0]?.fixed, ["1.0.1", "1.0.1+build"]);
});
