// node --test test/: offline checks for the evaluator's gates and the host scan.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isReservedHost } from "../lib/build.mjs";
import { lockPackages } from "../lib/gates.mjs";

test("reserved names are cleared, look-alikes aren't", () => {
  for (const host of ["startup-recovery.invalid", "t3-boot.test", "foo.localhost", "a.example", "127.0.0.1", "::1"]) {
    assert.equal(isReservedHost(host), true, host);
  }
  // example.com/net/org resolve (IANA serves them), so they need a known-hosts entry (BUILD-07).
  for (const host of ["example.com", "api.example.org", "example.attacker.com", "examples.com", "box.example.ts.net", "github.com", "invalid.com", "10.0.0.1"]) {
    assert.equal(isReservedHost(host), false, host);
  }
});

test("lockPackages reads every packages section and skips workspace links", () => {
  const lock = [
    "---",
    "lockfileVersion: '9.0'",
    "packages:",
    "",
    "  '@pnpm/exe@12.14.0':",
    "    resolution: {integrity: sha512-x}",
    "",
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies: {}",
    "packages:",
    "",
    "  '@babel/code-frame@7.27.1':",
    "    resolution: {integrity: sha512-y}",
    "",
    "  react@19.2.0:",
    "    resolution: {integrity: sha512-z}",
    "",
    "  local@link:packages/local:",
    "    resolution: {directory: packages/local}",
    "snapshots:",
    "",
    "  react@19.2.0: {}",
  ].join("\n");
  assert.deepEqual([...lockPackages(lock)].sort(), ["@babel/code-frame@7.27.1", "@pnpm/exe@12.14.0", "react@19.2.0"]);
});

import { compareRefs } from "../lib/pin.mjs";

test("release tags order by version, then nightly date and build, stable last", () => {
  const sorted = ["v0.1.4", "v0.1.4-nightly.20261028.3824", "v0.1.3-nightly.20261025.3692", "v0.1.4-nightly.20261028.3900", "v0.1.10-nightly.20261101.1"].sort(compareRefs);
  assert.deepEqual(sorted, ["v0.1.3-nightly.20261025.3692", "v0.1.4-nightly.20261028.3824", "v0.1.4-nightly.20261028.3900", "v0.1.4", "v0.1.10-nightly.20261101.1"]);
});

import { applyOverrides, overrideYamlLines, readOverrides } from "../lib/overrides.mjs";

test("security overrides are valid and replace exact versions only", () => {
  const overrides = readOverrides();
  assert.ok(overrides.length > 0);
  const sample = [{ selector: "undici@8.11.2", version: "8.12.2", advisories: ["GHSA-2m5v-pch6-74hx"] }];
  assert.deepEqual(applyOverrides(["undici@8.11.2", "undici@8.3.0", "undici@8.12.2", "undici@7.29.1", "react@19.0.0"], sample), ["undici@8.12.2", "undici@7.29.1", "react@19.0.0"]);
  assert.equal(overrideYamlLines(sample), '  "undici@>=8.0.0 <8.12.2": 8.12.2');
  assert.equal(overrideYamlLines([{ selector: "sharp@0.35.4", version: "0.35.5", advisories: [] }]), '  "sharp@>=0.35.0 <0.35.5": 0.35.5');
  for (const o of overrides) assert.ok(!o.version.startsWith("^") && !o.version.includes(" "), `${o.selector} must pin an exact version`);
});

import { makeRules } from "../lib/rules.mjs";

test("every string anchor has a string replacement", () => {
  const rules = makeRules({ updater: { node: "n", launcher: "l", path: "p" } });
  for (const rule of rules) for (const edit of rule.edits ?? []) {
    if (typeof edit.find === "string") assert.equal(typeof edit.replace, "string", rule.id);
  }
});

import { raiseCatalog } from "../lib/overrides.mjs";

test("catalog entries inside an override span are raised, others untouched", () => {
  const yaml = ["packages:", "  - apps/*", "catalog:", "  undici: 8.11.2", '  "@scope/x": 1.0.0', "  react: 19.0.0", "overrides:", "  undici: 8.11.2"].join("\n");
  const sample = [{ selector: "undici@8.11.2", version: "8.12.2", advisories: [] }];
  const out = raiseCatalog(yaml, sample).split("\n");
  assert.equal(out[3], "  undici: 8.12.2 # t3blackout security override (was 8.11.2)");
  assert.equal(out[5], "  react: 19.0.0");
  assert.equal(out[7], "  undici: 8.11.2", "only the catalog section is touched");
});
