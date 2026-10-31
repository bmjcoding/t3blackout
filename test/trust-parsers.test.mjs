// node --test test/: version ordering, release tags, the YAML reader, CVSS and
// the security-override catalog edits (SUPPLY-11, -14, -15, -19, PIPE-02).
import { test } from "node:test";
import assert from "node:assert/strict";

import { cvssScore, scoreSeverity } from "../lib/cvss.mjs";
import { lockPackages } from "../lib/gates.mjs";
import { backwardMove, compareRefs, isReleaseTag, validatePin } from "../lib/pin.mjs";
import { overrideFor, raiseCatalog, readOverrides } from "../lib/overrides.mjs";
import { compareVersions, lineOf } from "../lib/semver.mjs";
import { RuleDrift } from "../lib/strip-engine.mjs";
import { parseDocuments, parseYaml } from "../lib/yaml.mjs";

test("SemVer precedence: numeric prerelease ids, hyphenated ids, build metadata ignored", () => {
  const sorted = ["1.0.0", "1.0.0-rc.1", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-beta", "1.0.0-alpha.beta", "1.0.0-alpha.1", "1.0.0-alpha", "1.0.0-alpha-2", "1.0.0-alpha-1"].sort(compareVersions);
  // Identifiers compare in ASCII order: "alpha" < "alpha-1", so alpha.1 sorts before alpha-1.
  assert.deepEqual(sorted, ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-alpha-1", "1.0.0-alpha-2", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]);
  assert.ok(compareVersions("1.0.0-alpha-1", "1.0.0-alpha-2") < 0);
  assert.ok(compareVersions("1.2.3+build", "1.2.4") < 0);
  assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
  assert.ok(compareVersions("v20.11.1", "20.9.0") > 0);
  assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareVersions("99999999999999999999.0.0", "99999999999999999998.0.0") > 0);
  for (const bad of ["1.2", "01.2.3", "1.2.3-01", "1.2.3-", "latest", ""]) assert.throws(() => compareVersions(bad, "1.0.0"), /isn't a SemVer/, bad);
  assert.equal(lineOf("0.35.4"), "0.35");
  assert.equal(lineOf("8.11.2"), "8");
});

test("release tags are canonical; equal releases must keep their commit", () => {
  assert.ok(isReleaseTag("v0.1.6-nightly.20261030.3917", "nightly"));
  assert.ok(isReleaseTag("v1.0.0", "stable"));
  for (const bad of ["v00.1.6-nightly.20261030.3917", "v0.01.6", "v0.1.6-nightly.20261332.1", "v0.1.6-nightly.20261030.03917", "0.1.6", "v0.1.6-beta.20261030.1"]) {
    assert.equal(isReleaseTag(bad), false, bad);
  }
  assert.equal(isReleaseTag("v0.1.6-preview.20261030.1", "nightly"), false);
  assert.throws(() => compareRefs("v00.1.6", "v0.1.6"), /isn't a release tag/);
  const pin = (ref, sha) => validatePin({ version: 1, channels: { nightly: { ref, sha, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools: [] });
  assert.throws(() => pin("v00.1.6-nightly.20261030.3917", "a".repeat(40)), /isn't a release tag/);
  const before = pin("v0.1.6-nightly.20261030.3917", "a".repeat(40));
  assert.match(backwardMove(before, pin("v0.1.6-nightly.20261030.3917", "b".repeat(40))), /changes .* commit/);
  assert.match(backwardMove(before, pin("v0.1.6-nightly.20261030.3904", "b".repeat(40))), /moves nightly back/);
  assert.equal(backwardMove(before, pin("v0.1.6-nightly.20261030.3940", "b".repeat(40))), null);
  assert.throws(() => validatePin({ ...before, deviceTools: ["agent-device@0.21.31", "agent-device@0.21.31"] }), /twice/);
  assert.throws(() => validatePin({ ...before, deviceTools: ["agent-device@latest"] }), /name@version/);
});

test("the YAML reader matches pnpm's lockfile shapes and refuses what it can't read", () => {
  const [doc] = parseYaml(
    [
      "lockfileVersion: '9.0'",
      "packages:   # a comment after the key",
      "  '@a/b@1.0.0':",
      "    resolution: {integrity: sha512-x==, tarball: 'https://r.example/a.tgz'}",
      "    cpu: [arm64, x64]",
      "  c@2.0.0: {resolution: {integrity: sha512-y}}",
      '  "d@3.0.0":',
      "    engines: {node: '>=18'}",
      "snapshots:",
      "  ? 'e@1.0.0(f@2.0.0)'",
      "  : dependencies:",
      "      f: 2.0.0",
      "    optionalDependencies:",
      "      g: 1.0.0",
      "list:",
      "- one",
      "- two: 2",
      "  three: 3",
    ].join("\n"),
  );
  assert.equal(doc.lockfileVersion, "9.0");
  assert.deepEqual(Object.keys(doc.packages), ["@a/b@1.0.0", "c@2.0.0", "d@3.0.0"]);
  assert.deepEqual(doc.packages["@a/b@1.0.0"].cpu, ["arm64", "x64"]);
  assert.equal(doc.packages["c@2.0.0"].resolution.integrity, "sha512-y");
  assert.deepEqual(doc.snapshots["e@1.0.0(f@2.0.0)"], { dependencies: { f: "2.0.0" }, optionalDependencies: { g: "1.0.0" } });
  assert.deepEqual(doc.list, ["one", { two: 2, three: 3 }]);
  for (const [bad, why] of [
    ["a: &x 1", /anchors/],
    ["a: *x", /anchors/],
    ["a: !tag 1", /anchors/],
    ["a: |\n  text", /block scalars/],
    ["a: 1\na: 2", /duplicate key/],
    ["a: one\n  two", /multi-line/],
    ["a: 'unterminated\n  rest'", /multi-line quoted/],
    ["a: {b: 1,\n  c: 2}", /multi-line flow/],
    ["a:\n  b: 1\n c: 2", /indentation|unexpected/],
    ["a: b: c", /mapping value/],
  ]) {
    assert.throws(() => parseYaml(bad), why, bad);
  }
  assert.equal(parseDocuments("---\na: 1\n---\nb: 2\n").length, 2);
});

test("lockPackages reads a commented header and flow entries, and refuses empty or unsupported inventories", () => {
  const lock = (packages) => ["lockfileVersion: '9.0'", "importers:", "  .: {}", ...packages].join("\n");
  assert.deepEqual([...lockPackages(lock(["packages: # comment", "  fresh@1.0.0: {resolution: {integrity: sha512-test}}"]))], ["fresh@1.0.0"]);
  assert.deepEqual([...lockPackages(lock(["packages:", '  "quoted@2.0.0":', "    resolution: {integrity: sha512-q}", "  local@file:vendor/local.tgz:", "    resolution: {tarball: file:vendor/local.tgz}"]))], ["quoted@2.0.0"]);
  assert.throws(() => lockPackages(lock(["packages: {}"])), /no registry packages/);
  assert.throws(() => lockPackages(""), /empty/);
  assert.throws(() => lockPackages(lock(["packages:", "  evil@https://evil.example/x.tgz:", "    resolution: {tarball: https://evil.example/x.tgz}"])), /resolved from https:\/\/evil\.example\/x\.tgz, not the npm registry/);
  assert.throws(() => lockPackages(lock(["packages:", "  odd@1.0.0: &anchor {}"])), /anchors/);
  assert.throws(() => lockPackages("lockfileVersion: '6.0'\npackages:\n  a@1.0.0: {}\n"), /isn't supported/);
});

test("CVSS v3.x and v2 base scores match FIRST's reference values", () => {
  const cases = [
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "CRITICAL"],
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10, "CRITICAL"],
    ["CVSS_V3", "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "MODERATE"],
    ["CVSS_V3", "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 7.8, "HIGH"],
    ["CVSS_V3", "CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.6, "LOW"],
    ["CVSS_V3", "CVSS:3.0/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N", 5.9, "MODERATE"],
    ["CVSS_V2", "AV:N/AC:L/Au:N/C:P/I:P/A:P", 7.5, "HIGH"],
    ["CVSS_V2", "AV:N/AC:L/Au:N/C:C/I:C/A:C", 10, "HIGH"],
  ];
  for (const [type, score, expected, severity] of cases) {
    assert.equal(cvssScore({ type, score }), expected, score);
    assert.equal(scoreSeverity(expected, type), severity, score);
  }
  assert.equal(cvssScore({ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H" }), null, "a missing metric");
  assert.equal(cvssScore({ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }), null);
});

test("overrides cover build metadata and refuse non-SemVer entries", () => {
  const sample = [{ selector: "sharp@0.35.4", version: "0.35.5", advisories: [] }];
  assert.deepEqual(overrideFor("sharp@0.35.4+build", sample), { name: "sharp", from: "0.35.0", to: "0.35.5" });
  assert.equal(overrideFor("sharp@0.36.0", sample), null);
  assert.ok(readOverrides().length > 0);
});

const catalog = (lines) => raiseCatalog(lines.join("\n"), [
  { selector: "undici@8.11.2", version: "8.12.2", advisories: [] },
  { selector: "qs@6.16.0", version: "6.16.1", advisories: [] },
  { selector: "sharp@0.35.4", version: "0.35.5", advisories: [] },
]);

test("raiseCatalog reads quoting, comments, ranges, aliases and named catalogs", () => {
  const out = catalog([
    "catalog:",
    "  undici: '8.11.2'",
    '  "qs": ^6.10.0 # upstream note',
    "  react: 19.0.0",
    "  sharp: ~0.35.1",
    "  big: ^9.0.0",
    "catalogs:",
    "  legacy:",
    "    undici: 8.3.0",
    "    fetcher: npm:undici@^8.0.0-beta.1",
    "  modern: {qs: 6.17.0, undici: =8.11.2}",
    "overrides:",
    "  undici: 8.11.2",
  ]).split("\n");
  assert.equal(out[1], "  undici: '8.12.2' # t3blackout security override (was 8.11.2)");
  assert.equal(out[2], '  "qs": ^6.16.1 # t3blackout security override (was ^6.10.0)');
  assert.equal(out[3], "  react: 19.0.0");
  assert.equal(out[4], "  sharp: ~0.35.5 # t3blackout security override (was ~0.35.1)");
  assert.equal(out[8], "    undici: 8.12.2 # t3blackout security override (was 8.3.0)");
  assert.equal(out[9], "    fetcher: npm:undici@^8.12.2 # t3blackout security override (was npm:undici@^8.0.0-beta.1)");
  assert.equal(out[10], "  modern: {qs: 6.17.0, undici: 8.12.2}");
  assert.equal(out[12], "  undici: 8.11.2", "only catalogs are touched");
  assert.equal(catalog(["catalog:", "  undici: ^8.12.2", "  qs: 7.0.0"]), "catalog:\n  undici: ^8.12.2\n  qs: 7.0.0");
});

test("raiseCatalog refuses ranges it can't judge for an overridden package, and unreadable YAML", () => {
  for (const value of [">=8.0.0 <9", "8.x", "*", "^8.0.0 || ^9.0.0", "latest", "workspace:*"]) {
    assert.throws(() => catalog(["catalog:", `  undici: '${value}'`]), (error) => error instanceof RuleDrift && /can't be checked/.test(error.message), value);
  }
  assert.equal(catalog(["catalog:", "  react: '>=18'"]), "catalog:\n  react: '>=18'", "a package without an override is left alone");
  assert.throws(() => catalog(["catalog:", "  undici: &v 8.11.2"]), RuleDrift);
  assert.throws(() => catalog(["catalog: [undici]"]), /isn't a mapping/);
});
