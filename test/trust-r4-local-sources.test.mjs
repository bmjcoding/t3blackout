// node --test test/: what a lockfile installs from the checkout is what the
// pinned commit has there (SUPPLY4-01). Round 3 checked workspace links by name
// only: a `file:` folder went unchecked on disk (a symlink to anywhere passed and
// pnpm copied whatever was there), and a link into node_modules or build output
// counted as upstream's own though no commit holds it. Now names in
// node_modules fail in the lockfile itself (both dependency gates), and before
// the frozen install every workspace project, link target, `file:` folder and
// tarball must lead, after symlinks, to something the pinned commit tracks
// (lib/resolution.mjs checkLinksInTree, given `git ls-tree` of that commit), and
// a copied folder may hold nothing else. The staged production install, which
// no commit's tree backs, may not install from local folders at all.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { dependencyAgeGate, lockIdentities, resolutionKind } from "../lib/gates.mjs";
import { inTree, parseLockfile } from "../lib/lockfile.mjs";
import { checkLinksInTree, checkResolution, localSources, trackedTree } from "../lib/resolution.mjs";
import { guardedInstall } from "../lib/stage-install.mjs";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r4-local-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const INTEGRITY = "sha512-chlxkgJp4PZIiff6kUe/MWLp5+soELWNYA2IsOTus1YwKj8d9JZS6QsU7Ryqwhb1f4i0nQ5SsoUj6d5kGgq0KQ==";
const OLD = { versions: { "1.0.0": { dist: { integrity: INTEGRITY } } }, time: { "1.0.0": "2015-01-01T00:00:00.000Z" } };
globalThis.fetch = async (url) => (String(url) === "https://registry.npmjs.org/is-number" ? Response.json(OLD) : new Response("not found", { status: 404 }));

/**
 * A pnpm 12 lockfile: the root depends on is-number and `deps` ([name, version]
 * as pnpm writes them), packages/app links ../lib, and `packages` ([key,
 * resolution]) are the local packages those name.
 */
function lock(deps = [], packages = []) {
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      is-number:",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    ...deps.flatMap(([name, version]) => [`      ${name}:`, `        specifier: ${version}`, `        version: ${version}`]),
    "  packages/app:",
    "    dependencies:",
    "      lib:",
    "        specifier: workspace:*",
    "        version: link:../lib",
    "packages:",
    "  is-number@1.0.0:",
    `    resolution: {integrity: ${INTEGRITY}}`,
    ...packages.flatMap(([key, resolution]) => [`  '${key}':`, `    resolution: ${resolution}`]),
    "snapshots:",
    "  is-number@1.0.0: {}",
    ...packages.map(([key]) => `  '${key}': {}`),
    "",
  ].join("\n");
}

const FOLDER = ["pkg@file:vendor/pkg", "{directory: vendor/pkg, type: directory}"];
const TARBALL = ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/md-1.0.0.tgz}"];
const LOCAL = lock([["pkg", "file:vendor/pkg"], ["md", "file:vendor/md-1.0.0.tgz"], ["also", "link:packages/also"]], [FOLDER, TARBALL]);

const git = (cwd, args) => {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const write = (file, content = "x\n") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/**
 * A committed checkout: the workspace projects, a vendored folder and tarball, and
 * packages/also, a tracked symlink to packages/lib. `extra(root)` adds to it
 * before the commit. Returns { root, tree } (tree: trackedTree of the commit).
 */
function checkout(name, extra = () => {}) {
  const root = path.join(dir, name);
  for (const file of ["package.json", "packages/app/package.json", "packages/lib/package.json", "vendor/pkg/package.json", "vendor/pkg/src/index.js", "vendor/md-1.0.0.tgz"]) write(path.join(root, file));
  fs.symlinkSync("lib", path.join(root, "packages/also"));
  git(root, ["init", "-q", "-b", "main"]);
  extra(root);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "pinned"]);
  return { root, tree: trackedTree(git(root, ["ls-tree", "-r", "-t", "-z", "HEAD"])) };
}

test("trackedTree reads git ls-tree: folders, files, executables and symlinks", () => {
  const { tree } = checkout("tree", (root) => {
    write(path.join(root, "run.sh"));
    fs.chmodSync(path.join(root, "run.sh"), 0o755);
  });
  assert.equal(tree.get("vendor"), "dir");
  assert.equal(tree.get("vendor/pkg/src/index.js"), "file");
  assert.equal(tree.get("run.sh"), "file");
  assert.equal(tree.get("packages/also"), "symlink");
  assert.throws(() => trackedTree("100644 blob abc"), /can't read git ls-tree's entry/);
});

test("what the lockfile installs from the checkout: workspace projects, links, file: folders and tarballs", () => {
  const sources = localSources(parseLockfile(LOCAL)).map(({ where, kind }) => `${kind} ${where}`);
  assert.deepEqual(sources.sort(), ["copy vendor/pkg", "link .", "link packages/also", "link packages/app", "link packages/lib", "tarball vendor/md-1.0.0.tgz"]);
  // A package resolved from somewhere its version doesn't name, or the checkout itself.
  for (const [key, resolution] of [
    ["pkg@file:vendor/pkg", "{directory: vendor/other, type: directory}"],
    ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA, tarball: 'file:vendor/md-2.0.0.tgz'}"],
    ["md@file:vendor/md-1.0.0.tgz", "{integrity: sha512-AAAA}"],
    ["root@file:.", "{directory: ., type: directory}"],
  ]) {
    assert.throws(() => localSources(parseLockfile(lock([], [[key, resolution]]))), /isn't resolved from the folder or file its version names/, `${key} ${resolution}`);
  }
});

test("SUPPLY4-01: names in node_modules, or outside the tree, fail in the lockfile itself, for both dependency gates", async () => {
  const base = lock();
  assert.equal(inTree("packages/lib"), true);
  for (const where of ["node_modules/unchecked", "packages/lib/node_modules/x", "../outside", "/tmp/x"]) assert.equal(inTree(where), false, where);
  // The reviewer's untracked link, and the same through a file: folder.
  const linked = lock([["outside", "link:node_modules/unchecked"]]);
  const copied = lock([["outside", "file:node_modules/unchecked"]], [["outside@file:node_modules/unchecked", "{directory: node_modules/unchecked, type: directory}"]]);
  for (const next of [linked, copied]) {
    await assert.rejects(dependencyAgeGate(base, next), /node_modules\/unchecked/);
    await assert.rejects(checkResolution(base, next, { overrides: [] }), /node_modules\/unchecked/);
  }
  assert.throws(() => parseLockfile(linked), /links outside to node_modules\/unchecked, outside upstream's tree \(or in node_modules/);
  // pnpm writes links only for importers; one among the packages is upstream's own only inside the tree.
  assert.throws(() => resolutionKind("x@link:../outside", { directory: "../outside" }, new Map()), /isn't resolved inside upstream's tree/);
  assert.equal(resolutionKind("x@link:packages/x", { directory: "packages/x" }, new Map()), "local");
  assert.throws(() => resolutionKind("x@file:vendor/node_modules/x", { directory: "vendor/node_modules/x", type: "directory" }, new Map()), /isn't resolved inside upstream's tree/);
  // And a workspace project there.
  const project = lock().replace(/ {2}packages\/app:\n(?: {4}.*\n)+/, "  node_modules/app: {}\n");
  assert.throws(() => localSources(parseLockfile(project)), /workspace project node_modules\/app isn't a path in upstream's tree/);
  // Upstream's own vendored folders and tarballs are still its own.
  assert.equal(lockIdentities(LOCAL).size, 1);
  assert.equal((await dependencyAgeGate(base, LOCAL)).ok, true);
});

test("the pinned commit's folders, tarballs and in-tree symlinks pass; node_modules in a copied folder is left out, as pnpm does", () => {
  const { root, tree } = checkout("good");
  checkLinksInTree(LOCAL, root, tree);
  // Installed dependencies inside a file: folder, which pnpm doesn't copy.
  write(path.join(root, "vendor/pkg/node_modules/dep/index.js"));
  checkLinksInTree(LOCAL, root, tree);
  // The check can't run without the commit's files.
  assert.throws(() => checkLinksInTree(LOCAL, root), /needs the pinned commit's files/);
  assert.throws(() => checkLinksInTree(LOCAL, root, new Map()), /needs the pinned commit's files/);
});

test("SUPPLY4-01: a file: folder that is a symlink out of the checkout is refused (the reviewer's probe)", () => {
  const outside = path.join(dir, "outside");
  write(path.join(outside, "package.json"), '{"name":"outside","version":"1.0.0"}');
  // Committed, even: a tracked symlink doesn't make what it points at tracked.
  const { root, tree } = checkout("escape", (top) => fs.symlinkSync(outside, path.join(top, "packages/local")));
  const next = lock([["outside", "file:packages/local"]], [["outside@file:packages/local", "{directory: packages/local, type: directory}"]]);
  assert.throws(() => checkLinksInTree(next, root, tree), /outside@file:packages\/local leads out of upstream's checkout, to .*outside/);
  // The same for a tarball.
  write(path.join(outside, "md.tgz"));
  fs.symlinkSync(path.join(outside, "md.tgz"), path.join(root, "vendor/linked.tgz"));
  const tarball = lock([["md", "file:vendor/linked.tgz"]], [["md@file:vendor/linked.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/linked.tgz}"]]);
  assert.throws(() => checkLinksInTree(tarball, root, tree), /leads out of upstream's checkout/);
});

test("SUPPLY4-01: untracked or generated targets are refused: build output, node_modules behind a symlink, missing paths", () => {
  const { root, tree } = checkout("untracked", (top) => {
    // A tracked symlink into node_modules, which no commit holds.
    fs.symlinkSync("../node_modules/unchecked", path.join(top, "packages/cached"));
  });
  write(path.join(root, "dist/lib/package.json"));
  write(path.join(root, "node_modules/unchecked/package.json"));
  write(path.join(root, "vendor/built.tgz"));
  const refused = [
    [lock([["out", "link:dist/lib"]]), /'s link out \(dist\/lib\) is dist\/lib, which isn't a folder upstream's pinned commit has/],
    [lock([["cached", "link:packages/cached"]]), /is node_modules\/unchecked, which isn't a folder upstream's pinned commit has/],
    [lock([["out", "file:dist/lib"]], [["out@file:dist/lib", "{directory: dist/lib, type: directory}"]]), /out@file:dist\/lib is dist\/lib, which isn't a folder/],
    [lock([["md", "file:vendor/built.tgz"]], [["md@file:vendor/built.tgz", "{integrity: sha512-AAAA, tarball: file:vendor/built.tgz}"]]), /is vendor\/built\.tgz, which isn't a file upstream's pinned commit has/],
    [lock([["md", "file:vendor/pkg"]], [["md@file:vendor/pkg", "{integrity: sha512-AAAA, tarball: file:vendor/pkg}"]]), /is vendor\/pkg, which isn't a file/],
    [lock([["gone", "link:packages/gone"]]), /link gone \(packages\/gone\) isn't in upstream's checkout/],
    [lock([["unchecked", "link:node_modules/unchecked"]]), /outside upstream's tree \(or in node_modules/],
  ];
  for (const [next, why] of refused) assert.throws(() => checkLinksInTree(next, root, tree), why);
});

test("SUPPLY4-01: a copied file: folder may hold nothing the commit doesn't, and no symlink", () => {
  const { root, tree } = checkout("contents");
  write(path.join(root, "vendor/pkg/src/generated.js"));
  assert.throws(() => checkLinksInTree(LOCAL, root, tree), /pkg@file:vendor\/pkg holds vendor\/pkg\/src\/generated\.js, which upstream's pinned commit doesn't/);
  fs.rmSync(path.join(root, "vendor/pkg/src/generated.js"));
  // pnpm follows symlinks when it copies a folder: even one to a tracked file brings that file's bytes.
  fs.symlinkSync("../../package.json", path.join(root, "vendor/pkg/src/root.json"));
  assert.throws(() => checkLinksInTree(LOCAL, root, tree), /holds a symlink, vendor\/pkg\/src\/root\.json/);
  // A linked (not copied) workspace folder may hold build output; the build makes some.
  fs.rmSync(path.join(root, "vendor/pkg/src/root.json"));
  write(path.join(root, "packages/lib/dist/index.js"));
  checkLinksInTree(LOCAL, root, tree);
});

test("SUPPLY4-01: the staged production install may not install from the stage's own folders", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r4-stage-")));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "stage", "app");
  write(path.join(app, "package.json"), '{"name":"t3blackout","dependencies":{"is-number":"1.0.0"}}\n');
  const resolved = lock([["local", "file:sub"]], [["local@file:sub", "{directory: sub, type: directory}"]]).replace(/ {2}packages\/app:\n(?: {4}.*\n)+/, "");
  // A fake vp: lockfile-only writes `resolved`; a frozen install would leave a marker.
  const vp = path.join(root, "vp.cjs");
  fs.writeFileSync(vp, `const fs = require("node:fs");\nif (process.argv.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", ${JSON.stringify(resolved)});\nelse fs.writeFileSync(${JSON.stringify(path.join(root, "installed"))}, "");\n`);
  fs.writeFileSync(path.join(root, "vp"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(vp)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "verified.yaml"), lock());
  const env = { PATH: process.env.PATH, T3BLACKOUT_REAL_VP: path.join(root, "vp"), T3BLACKOUT_SHIM_DIR: path.join(root, "shims"), T3BLACKOUT_STAGE_ROOT: root, T3BLACKOUT_VERIFIED_LOCK: path.join(root, "verified.yaml"), T3BLACKOUT_STAGE_RECORD: path.join(root, "record.jsonl") };
  await assert.rejects(guardedInstall(app, env), /would install local@file:sub from the stage itself/);
  assert.equal(fs.existsSync(path.join(root, "installed")), false, "nothing was installed");
});
