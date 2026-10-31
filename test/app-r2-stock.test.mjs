// node --test test/*.test.mjs: nothing in a build sends people to stock T3 (decision H), and the
// round-2 app rules (provider installers, ACP binaries, granted-file CSP) stay strict.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { featureIndex } from "../lib/features.mjs";
import { STOCK_GUIDANCE, makeRules } from "../lib/rules.mjs";
import { applyRules, findAbsentViolations } from "../lib/strip-engine.mjs";

const rules = makeRules({ updater: { node: "/usr/bin/node", launcher: "/opt/t3b/bin/t3blackout", path: "/usr/bin" }, build: null });
const index = featureIndex(rules);
const byId = new Map(rules.map((rule) => [rule.id, rule]));
const assertion = byId.get("stock/no-stock-guidance");
const stockIds = rules.map((rule) => rule.id).filter((id) => /\/no-stock-|\/no-update-manually-/.test(id) && !id.startsWith("stock/"));
const matchesStock = (text) => STOCK_GUIDANCE.some(({ pattern }) => pattern.test(text));

test("the stock-guidance patterns catch upstream's ways to stock T3, not its version labels", () => {
  for (const stock of [
    'const FALLBACK_TRIAGE_COMMAND = "npx t3 triage";',
    "<CommandBlock command=\"npx t3 connect\" />",
    "Pair with the matching CLI instead: \\`npx t3@${this.serverVersion} pair\\`.",
    "Use `npx t3@latest` if `t3` is missing",
    "return `npm install --global --prefix ${prefix} t3@${targetVersion}`;",
    "pnpm dlx t3 serve",
    "bunx t3",
    'const DOWNLOAD_URL = "https://t3.codes/download";',
    "curl -fsSL https://t3.codes/install.sh | sh",
    'const RELEASES_URL = "https://github.com/pingdotgg/t3code/releases";',
    "or, update manually using",
  ]) {
    assert.ok(matchesStock(stock), stock);
  }
  for (const label of [
    "`Reconnected on t3@${result.value.targetVersion}.`",
    "`t3@${targetVersion} is not on npm yet`",
    "Remove it the same way (`npm uninstall -g t3`, or delete the checkout).",
    "needs a manual update",
    "npx t3code-extras",
    "~/.t3blackout/bin/t3blackout update",
    "`t3 pair`",
  ]) {
    assert.ok(!matchesStock(label), label);
  }
});

test("every stock replacement is strict, runs before the brand rule, and leaves no stock text", () => {
  const order = rules.map((rule) => rule.id);
  assert.ok(stockIds.length >= 14, stockIds.join(", "));
  for (const id of stockIds) {
    assert.equal(index.get(id), undefined, `${id} must be strict`);
    assert.ok(order.indexOf(id) < order.indexOf("brand/name"), `${id} anchors on upstream's "T3 Code"`);
    for (const edit of byId.get(id).edits) {
      if (typeof edit.replace === "string") assert.ok(!matchesStock(edit.replace), `${id} writes stock text: ${edit.replace}`);
    }
  }
  assert.equal(order.at(-1), "stock/no-stock-guidance", "the assertion runs after every rule, the brand rule included");
  assert.equal(index.get("stock/no-stock-guidance"), undefined, "a match stops the update");
});

const tree = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-app-r2-stock-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};

test("the assertion fails the build on shipped source, and skips tests, fixtures and comments", () => {
  const root = tree({
    "apps/web/src/lib/bootError.ts": 'const A = "npx t3 triage";\n// npx t3 users see onboarding\n',
    "apps/web/src/lib/bootError.test.ts": 'const A = "npx t3 triage";\n',
    "apps/web/src/testing/fake.ts": 'const A = "npx t3 serve";\n',
    "apps/web/index.html": '<a href="https://t3.codes/download">get</a>\n',
    "apps/desktop/src/app/x.ts": "/**\n * see https://github.com/pingdotgg/t3code/releases\n */\nconst ok = 1;\n",
    "apps/server/src/x.ts": "const label = `t3@${version}`;\n",
    "packages/shared/src/release.ts": 'export const URL = "https://github.com/pingdotgg/t3code/releases";\n',
    "packages/shared/scripts/gen.ts": 'const A = "npx t3";\n',
    "packages/provider-testing/src/x.ts": 'const A = "npx t3";\n',
    "packages/shared/src/node_modules/x/index.js": 'const A = "npx t3";\n',
  });
  const hits = findAbsentViolations(root, assertion);
  assert.deepEqual(hits.sort(), [
    "apps/web/index.html:1 (t3.codes download)",
    "apps/web/src/lib/bootError.ts:1 (npx t3)",
    "packages/shared/src/release.ts:1 (stock releases)",
  ]);
  const failures = applyRules(root, [assertion]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, "stock/no-stock-guidance");
  assert.match(failures[0].message, /3 line\(s\) still match: .*bootError\.ts:1 \(npx t3\)/);
  fs.rmSync(root, { recursive: true });
});

test("the assertion passes a clean tree and never follows a symlink out", () => {
  const outside = tree({ "leak.ts": 'const A = "npx t3";\n' });
  const root = tree({
    "apps/web/src/a.ts": "export const ok = 1;\n",
    "apps/web/index.html": "<title>x</title>\n",
    "apps/desktop/src/a.ts": "export const ok = 1;\n",
    "apps/server/src/a.ts": "export const ok = 1;\n",
    "packages/contracts/src/a.ts": "export const ok = 1;\n",
  });
  fs.mkdirSync(path.join(root, "packages", "shared"), { recursive: true });
  fs.symlinkSync(path.join(outside, "leak.ts"), path.join(root, "apps/web/src/leak.ts"));
  fs.symlinkSync(outside, path.join(root, "packages", "shared", "src"));
  fs.symlinkSync(outside, path.join(root, "packages", "linked"));
  assert.deepEqual(findAbsentViolations(root, assertion), []);
  assert.deepEqual(applyRules(root, [assertion]), []);
  fs.rmSync(root, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

test("a root upstream moved stops the build instead of passing an empty check", () => {
  const root = tree({ "apps/web/src/a.ts": "export const ok = 1;\n", "apps/web/index.html": "<title>x</title>\n", "apps/server/src/a.ts": "\n" });
  fs.mkdirSync(path.join(root, "packages", "contracts"), { recursive: true });
  const failures = applyRules(root, [assertion]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /apps\/desktop\/src no longer exists/);
  fs.mkdirSync(path.join(root, "apps", "desktop", "src"), { recursive: true });
  assert.match(applyRules(root, [assertion])[0].message, /packages\/\*\/src no longer exists/);
  fs.rmSync(root, { recursive: true });
});

test("provider updates, ACP binaries and granted-file CSP stay strict", () => {
  for (const id of [
    "provider/updates-minimum-age",
    "provider/updates-manual-reason",
    "server/provider-update-manual-reason",
    "acp-registry/installs-minimum-age",
    "acp-registry/no-prebuilt-binaries",
    "acp-registry/no-prebuilt-binaries-message",
    "server/static-assets-csp",
  ]) {
    assert.equal(index.get(id), undefined, `${id} must be strict`);
  }
  const provider = byId.get("provider/updates-minimum-age").edits;
  const ungated = provider.find((edit) => edit.find instanceof RegExp && edit.count === 4);
  assert.ok(ungated, "the four installer branches are replaced, all or nothing");
  const replaced = 'return makeProviderMaintenanceCapabilities({\n      provider: definition.provider,\n      packageName,\n      updateExecutable: "bun",\n      updateArgs: ["i", "-g", `${packageName}@latest`],\n      updateLockKey: "bun-global",\n    });\n';
  assert.equal(`    ${replaced}`.replace(new RegExp(ungated.find.source, "g"), ungated.replace), '    return blackoutUngatedInstall(manual, "bun");\n');
  const text = provider.map((edit) => (typeof edit.replace === "string" ? edit.replace : "")).join("\n");
  assert.match(text, /Update this provider with npm or pnpm, or its own updater\./);
  assert.match(text, /!\/\^\(\?:npm-global:\|pnpm-global\$\)\/\.test\(/, "only npm and pnpm take a targeted install");
  assert.doesNotMatch(text, /bun-global|yarn-global|vite-plus-global/);
  const acp = byId.get("acp-registry/no-prebuilt-binaries").edits.map((edit) => edit.replace).join("\n");
  assert.match(acp, /input\.preference === "auto" \? \["npx", "uvx"\] : \[input\.preference\]/);
  assert.match(acp, /const BLACKOUT_PREBUILT_BINARIES: boolean = false;/);
  assert.match(acp, /if \(!BLACKOUT_PREBUILT_BINARIES\) \{\n\s+return yield\* new AcpRegistryError/);
});
