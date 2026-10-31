// node --test test/: workspace links stay inside upstream's tree (SUPPLY3-04).
// A `link:` was left out of the registry inventory without any check, so a
// lockfile could link a folder outside the pinned checkout (mutable, with no
// source or integrity anyone checked) into node_modules. Every importer link must
// now name a folder inside the tree (both gates read the lockfile through
// lib/lockfile.mjs), only importers may link, and before the frozen install the
// build checks no symlink on the way leads out (checkLinksInTree).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { dependencyAgeGate } from "../lib/gates.mjs";
import { parseLockfile } from "../lib/lockfile.mjs";
import { checkLinksInTree, checkResolution } from "../lib/resolution.mjs";
import { COMMON, UPSTREAM, lockfile } from "./pipeline-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r3-lockfile-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const INTEGRITY = "sha512-chlxkgJp4PZIiff6kUe/MWLp5+soELWNYA2IsOTus1YwKj8d9JZS6QsU7Ryqwhb1f4i0nQ5SsoUj6d5kGgq0KQ==";
/** What pnpm 12.14.0 wrote for a project depending on is-number and, optionally, `outside: link:<path>` (the reviewer's run). */
const pnpmLock = (link) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      is-number:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    ...(link ? ["      outside:", `        specifier: ${link}`, `        version: ${link}`] : []),
    "",
    "packages:",
    "",
    "  is-number@1.0.0:",
    `    resolution: {integrity: ${INTEGRITY}}`,
    "    engines: {node: '>=0.10.0'}",
    "",
    "snapshots:",
    "",
    "  is-number@1.0.0: {}",
    "",
  ].join("\n");

const OLD = { versions: { "1.0.0": { dist: { integrity: INTEGRITY } } }, time: { "1.0.0": "2015-01-01T00:00:00.000Z" } };

test("SUPPLY3-04: a link out of upstream's tree fails both dependency gates", async () => {
  globalThis.fetch = async (url) => (String(url) === "https://registry.npmjs.org/is-number" ? Response.json(OLD) : new Response("not found", { status: 404 }));
  const base = pnpmLock(null);
  for (const link of ["link:../../../../../tmp/t3b-review-SUPPLY/r3-link/outside", "link:/tmp/outside", "link:packages/../../outside"]) {
    const next = pnpmLock(link);
    await assert.rejects(dependencyAgeGate(base, next), /links outside to .*, outside upstream's tree/, link);
    await assert.rejects(checkResolution(base, next, { overrides: [] }), /outside upstream's tree/, link);
  }
  // A link inside the tree still counts as upstream's own.
  assert.equal((await dependencyAgeGate(base, pnpmLock("link:packages/outside"))).ok, true);
});

test("links resolve from their importer; only importers may link", () => {
  const workspace = (desktopLink) =>
    [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a:",
      "        specifier: workspace:*",
      "        version: link:packages/a",
      "  apps/desktop:",
      "    dependencies:",
      "      a:",
      "        specifier: workspace:*",
      `        version: ${desktopLink}`,
      "      web:",
      "        specifier: workspace:*",
      "        version: link:../web",
      "packages: {}",
      "snapshots: {}",
      "",
    ].join("\n");
  assert.deepEqual(parseLockfile(workspace("link:../../packages/a")).links, [
    { importer: ".", name: "a", target: "packages/a" },
    { importer: "apps/desktop", name: "a", target: "packages/a" },
    { importer: "apps/desktop", name: "web", target: "apps/web" },
  ]);
  assert.throws(() => parseLockfile(workspace("link:../../../packages/a")), /apps\/desktop links a to \.\.\/\.\.\/\.\.\/packages\/a, outside upstream's tree/);
  assert.deepEqual(parseLockfile(UPSTREAM).links, [{ importer: ".", name: "local", target: "packages/local" }]);
  const linkedSnapshot = lockfile({ ...COMMON, "app@1.0.0": ["helper: link:../helper"] });
  assert.throws(() => parseLockfile(linkedSnapshot), /app@1\.0\.0\(peer@2\.0\.0\) links helper; only workspace projects may link/);
});

test("the build's check: no workspace folder or link target leads out of the checkout through a symlink", () => {
  const root = path.join(dir, "checkout");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(root, "packages/local"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  // What the pinned commit has (git ls-tree; test/trust-r4-local-sources.test.mjs runs the real one).
  const tree = new Map([["packages", "dir"], ["packages/local", "dir"], ["packages/real", "dir"]]);
  checkLinksInTree(UPSTREAM, root, tree);
  // The same name, now a symlink out of the tree.
  fs.rmSync(path.join(root, "packages/local"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "packages/local"));
  // (packages/local is both a workspace project and the root's link target.)
  assert.throws(() => checkLinksInTree(UPSTREAM, root, tree), /packages\/local leads out of upstream's checkout/);
  // A symlinked folder that stays inside is fine; a missing one isn't.
  fs.rmSync(path.join(root, "packages/local"));
  fs.mkdirSync(path.join(root, "packages/real"));
  fs.symlinkSync("real", path.join(root, "packages/local"));
  checkLinksInTree(UPSTREAM, root, tree);
  fs.rmSync(path.join(root, "packages/local"));
  assert.throws(() => checkLinksInTree(UPSTREAM, root, tree), /isn't in upstream's checkout/);
});
