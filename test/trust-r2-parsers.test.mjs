// node --test test/: round-2 parser and data checks. CVSS metrics are own
// properties only (SUPPLY2-10); minimum ages are finite and publish times real
// calendar dates (SUPPLY2-11); npm ranges match node-semver; pin.json's device
// tool locks; the seroval override clears both advisories (SUPPLY2-07, PIPE2-04).
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { isAlerting, severityOf } from "../lib/advisories.mjs";
import { cvssScore, scoreSeverity } from "../lib/cvss.mjs";
import { ageSetting, publishedTime } from "../lib/gates.mjs";
import { readOverrides } from "../lib/overrides.mjs";
import { backwardMove, validatePin } from "../lib/pin.mjs";
import { compareVersions, parseRange, satisfies } from "../lib/semver.mjs";

const BASE = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";

test("a CVSS vector with inherited names as metrics or values is unscored, and its advisory alerts as UNKNOWN (SUPPLY2-10)", () => {
  for (const vector of [BASE.replace("AV:N", "AV:constructor"), BASE.replace("C:H", "C:toString"), BASE.replace("AC:L", "AC:__proto__"), `${BASE.replace("/A:H", "")}/hasOwnProperty:H`]) {
    assert.equal(cvssScore({ type: "CVSS_V3", score: vector }), null, vector);
    const severity = severityOf({ id: "GHSA-test", severity: [{ type: "CVSS_V3", score: vector }] });
    assert.equal(severity, "UNKNOWN", vector);
    assert.equal(isAlerting(severity), true);
  }
  assert.equal(cvssScore({ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:valueOf/I:P/A:P" }), null);
  assert.equal(cvssScore({ type: "CVSS_V3", score: BASE }), 9.8);
  for (const bad of [NaN, Infinity, -1, 11, "9.8", null]) assert.equal(scoreSeverity(bad), "UNKNOWN", String(bad));
  assert.equal(scoreSeverity(9.8), "CRITICAL");
});

test("minimum ages must be finite after conversion; publish times must be real calendar instants (SUPPLY2-11)", () => {
  assert.throws(() => ageSetting("9".repeat(400)), /non-negative number of days/);
  assert.throws(() => ageSetting(Infinity), /not Infinity/);
  assert.equal(ageSetting("3"), 3);
  assert.equal(ageSetting(0.5), 0.5);
  for (const bad of ["2026-02-30T12:00:00Z", "2026-02-29T12:00:00Z", "2026-13-01T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z"]) {
    assert.equal(publishedTime(bad), null, bad);
  }
  assert.equal(publishedTime("2024-02-29T23:59:59.123Z"), Date.UTC(2024, 1, 29, 23, 59, 59, 123));
});

test("npm ranges: carets, tildes, x-ranges, hyphens, unions and prereleases as node-semver decides", () => {
  const cases = [
    ["1.2.3", "^1.0.0", true], ["2.0.0", "^1.0.0", false], ["0.2.9", "^0.2.3", true], ["0.3.0", "^0.2.3", false],
    ["0.0.3", "^0.0.3", true], ["0.0.4", "^0.0.3", false], ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false],
    ["1.9.0", "1.x", true], ["2.0.0", "1", false], ["1.5.0", "1.2.3 - 2.3", true], ["2.4.0", "1.2.3 - 2.3", false],
    ["4.6.6", "^3.25 || ^4", true], ["3.0.0", ">= 1.0.0 < 2", false], ["1.2.3-beta.3", "^1.2.3-beta.2", true],
    ["1.2.4-alpha", "^1.2.3-beta.2", false], ["2.0.0-rc.1", "*", false], ["1.0.0", "", true], ["1.3.0", ">1.2", true], ["1.2.9", ">1.2", false],
  ];
  for (const [version, range, want] of cases) assert.equal(satisfies(version, range), want, `${version} ${range}`);
  for (const bad of ["latest", "github:x/y", "file:../x", "1.2.3.4", ">=", "^1.2.3 - 2"]) assert.throws(() => parseRange(bad), bad);
});

test("pin.json's device tool locks: exact shape, matching digest, and never changed or dropped once there", () => {
  const lock = '{"lockfileVersion":3}\n';
  const entry = { sha256: createHash("sha256").update(lock).digest("hex"), lock };
  const pin = { version: 1, channels: {}, deviceTools: ["agent-device@0.21.31"], deviceToolLocks: { "agent-device@0.21.31": entry } };
  assert.equal(validatePin(structuredClone(pin)).deviceToolLocks["agent-device@0.21.31"].lock, lock);
  for (const [locks, why] of [
    [{ "agent-device@0.21.31": { ...entry, lock: `${lock} ` } }, /doesn't match its sha256/],
    [{ "agent-device@0.21.31": { ...entry, note: "x" } }, /exactly sha256 and lock/],
    [{ "agent-device": entry }, /isn't name@version/],
    [[], /must be an object/],
  ]) {
    assert.throws(() => validatePin({ ...pin, deviceToolLocks: locks }), why);
  }
  const other = '{"lockfileVersion":3,"x":1}\n';
  const changed = { ...pin, deviceToolLocks: { "agent-device@0.21.31": { sha256: createHash("sha256").update(other).digest("hex"), lock: other } } };
  assert.match(backwardMove(pin, changed), /replaces agent-device@0\.21\.31's reviewed dependency lock/);
  assert.match(backwardMove(pin, { ...pin, deviceToolLocks: {} }), /removes agent-device@0\.21\.31's reviewed dependency lock/);
  assert.equal(backwardMove({ ...pin, deviceToolLocks: {} }, pin), null);
});

test("the seroval override's fix has neither advisory its old target had (SUPPLY2-07, PIPE2-04)", () => {
  const seroval = readOverrides().find((o) => o.selector.startsWith("seroval@"));
  assert.ok(compareVersions(seroval.version, "1.6.11") >= 0, `seroval fix ${seroval.version}`);
  for (const id of ["GHSA-9wx9-5pv9-3349", "GHSA-f86p-h4j2-7qgj"]) assert.ok(seroval.advisories.includes(id), id);
});
