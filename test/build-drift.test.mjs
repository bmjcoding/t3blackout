// node --test test/: the drift report's diagnostics (lib/drift.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyDrift, filesInError, regexAnchorText, renderDriftReport } from "../lib/drift.mjs";

test("BUILD-17: a type error's relative modules are found, TS2307's quoting and TS2305's", () => {
  const file = "apps/web/src/components/BlackoutBrand.tsx";
  const ts2307 = filesInError({ file, message: "TS2307: Cannot find module '../themePalette' or its corresponding type declarations." });
  assert.ok(ts2307.includes("apps/web/src/themePalette.ts"), ts2307.join(" "));
  const ts2305 = filesInError({ file, message: `TS2305: Module '"../themePalette"' has no exported member 'X'.` });
  assert.ok(ts2305.includes("apps/web/src/themePalette.ts"));
  const alias = filesInError({ file, message: "TS2307: Cannot find module '~/hooks/useTheme' or its corresponding type declarations." });
  assert.ok(alias.includes("apps/web/src/hooks/useTheme.ts"));
  // A package name is upstream's dependency, not a file of its own.
  assert.deepEqual(filesInError({ file, message: "TS2307: Cannot find module 'effect/Schema'." }), [file]);
});

test("BUILD-18: a regex anchor is looked for by the text it matched, not its own source", () => {
  const source = "const a = 1;\nexport const reconcileCloud = (state) => cloud.sync(state);\n";
  assert.equal(regexAnchorText(/export const reconcileCloud = \(\w+\) => cloud\.sync\(\w+\);/, source), "export const reconcileCloud = (state) => cloud.sync(state);");
  assert.equal(regexAnchorText(/nothing like it/, source), null);
  assert.equal(regexAnchorText(/x/, null), null);
});

const strictDrift = {
  ...emptyDrift({ version: "0.2.0", sha: "a".repeat(40) }),
  strict: { from: "b".repeat(40), rules: [{ id: "server/telemetry", why: "no telemetry", file: "x.ts", message: "gone", anchor: "posthog()", matched: null, text: "posthog()", now: [] }], files: [] },
};

test("BUILD-19: a strict failure's advice says nothing was installed and how to fix the guard", () => {
  const html = renderDriftReport(strictDrift);
  assert.match(html, /Your installed build is unchanged/);
  assert.match(html, /Fix the strict rule/);
  assert.doesNotMatch(html, /this build already runs it/);
  assert.doesNotMatch(html, /remove its rules/);
});

test("an optional feature left out gets the keep-or-bring-back advice; a clean build none", () => {
  const drift = {
    ...emptyDrift({ version: "0.2.0", sha: "a".repeat(40) }),
    features: [{ name: "wordmark", label: "Wordmark", description: null, reason: "anchor", requires: null, from: null, rules: [], errors: [], files: [] }],
  };
  const html = renderDriftReport(drift);
  assert.match(html, /Keep upstream's version/);
  assert.match(html, /this build already runs it/);
  assert.doesNotMatch(renderDriftReport(emptyDrift({ version: "0.2.0", sha: "a".repeat(40) })), /What you can do/);
});
