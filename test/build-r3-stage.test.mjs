// node --test test/: the packager's stage after round 3 (BUILD3-01): the shims
// refuse every package-manager command aimed at the stage but reading what's
// installed, and the build checks the staged files themselves, byte for byte,
// against what the guard installed from the checked lockfile, so a replacement
// that keeps a package's name and version fails (the reviewer's `npm ins`).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyStageInstalls } from "../lib/build.mjs";
import { classify, findOnPath, guardedInstall, main, stageChanges, stageContents } from "../lib/stage-install.mjs";

const LOCK = [
  "lockfileVersion: '9.0'",
  "importers:",
  "  .:",
  "    dependencies:",
  "      is-number:",
  "        specifier: 7.0.0",
  "        version: 7.0.0",
  "packages:",
  "  is-number@7.0.0:",
  "    resolution: {integrity: sha512-AAAA}",
  "snapshots:",
  "  is-number@7.0.0: {}",
  "",
].join("\n");

/** A stage whose fake vp resolves LOCK and installs is-number@7.0.0, plus a native package, the way pnpm lays them out. */
function fakeStage() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-stage-")));
  const app = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "t3blackout", version: "1.0.0", dependencies: { "is-number": "7.0.0" } }));
  fs.writeFileSync(path.join(root, "verified.yaml"), LOCK);
  const vp = path.join(root, "vp");
  const install = `
const fs = require("node:fs");
if (process.argv.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", ${JSON.stringify(LOCK)});
else {
  const store = "node_modules/.pnpm/is-number@7.0.0/node_modules/is-number";
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(store + "/package.json", JSON.stringify({ name: "is-number", version: "7.0.0" }));
  fs.writeFileSync(store + "/index.js", "module.exports = (n) => typeof n === 'number';\\n");
  fs.symlinkSync(".pnpm/is-number@7.0.0/node_modules/is-number", "node_modules/is-number");
}`;
  fs.writeFileSync(vp, `#!${process.execPath}\n${install}\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH,
    T3BLACKOUT_REAL_VP: vp,
    T3BLACKOUT_REAL_NPM: findOnPath("npm", process.env.PATH, "/nonexistent") ?? "",
    T3BLACKOUT_SHIM_DIR: path.join(root, "shims"),
    T3BLACKOUT_STAGE_ROOT: root,
    T3BLACKOUT_VERIFIED_LOCK: path.join(root, "verified.yaml"),
    T3BLACKOUT_STAGE_RECORD: path.join(root, "record.jsonl"),
  };
  return { root, app, env, stages: { tmpdir: root } };
}

/** Runs `step` with console.log quiet (the guard reports what it checked). */
async function quietly(step) {
  const log = console.log;
  console.log = () => {};
  try {
    return await step();
  } finally {
    console.log = log;
  }
}

test("BUILD3-01: anything aimed at the stage but reading what's installed is refused, the reviewer's `npm ins` included", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-classify-")));
  const stage = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(stage, { recursive: true });
  const elsewhere = fs.realpathSync(os.tmpdir());
  const refused = [
    ["npm", ["ins", "--no-save", "--package-lock=false", "../replacement.tgz"]],
    ["npm", ["isntall"]], // npm's typo alias
    ["npm", ["run", "postinstall"]],
    ["npm", ["exec", "--", "whatever"]],
    ["npm", []],
    ["pnpm", ["postinstall"]], // an implicit script
    ["pnpm", ["--dir", stage, "list"]], // the command has to come first
    ["pnpm", ["store", "add", "x"]],
    ["yarn", []], // installs
    ["yarn", ["list"]],
    ["vp", ["install", "--prod"]],
    ["vp", ["list"]],
    ["pnpm", ["-v", "install"]],
  ];
  for (const [tool, args] of refused) assert.equal(classify(tool, args, stage, root), "refuse", `${tool} ${args.join(" ")}`);
  // Aimed from outside: a destination option, or the environment.
  assert.equal(classify("npm", ["ins", `--prefix=${stage}`], elsewhere, root), "refuse");
  assert.equal(classify("npm", ["i"], elsewhere, root, { npm_config_prefix: stage }), "refuse");
  // Reading what's installed, or a version, passes; so does anything not aimed at the stage.
  for (const [tool, args] of [
    ["pnpm", ["list", "--prod", "--json", "--depth", "Infinity"]],
    ["pnpm", ["why", "is-number"]],
    ["npm", ["ls", "--all", "--json"]],
    ["npm", ["--version"]],
    ["yarn", ["-v"]],
  ]) {
    assert.equal(classify(tool, args, stage, root), "pass", `${tool} ${args.join(" ")}`);
  }
  assert.equal(classify("npm", ["ins", "left-pad"], elsewhere, root), "pass");
  assert.equal(classify("vp", ["exec", "--filter", "@t3tools/desktop", "--", "electron-builder", "--projectDir", stage], elsewhere, root), "pass");
});

/** A small package tree in a fresh folder: `files` (path below node_modules -> text). */
function tree(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-tree-")));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, "node_modules", name)), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", name), text);
  }
  return dir;
}

test("BUILD3-01: stageChanges allows only what packaging adds: copies of installed binaries and native rebuild output", () => {
  const pty = ".pnpm/node-pty@1.0.0/node_modules/node-pty";
  const dir = tree({
    ".pnpm/a@1.0.0/node_modules/a/package.json": '{"name":"a","version":"1.0.0"}',
    ".pnpm/a@1.0.0/node_modules/a/index.js": "module.exports = 1;\n",
    ".pnpm/keyring-darwin@1.0.0/node_modules/keyring-darwin/keyring.node": "BINARY",
    ".pnpm/keyring@1.0.0/node_modules/keyring/package.json": "{}",
    [`${pty}/package.json`]: '{"name":"node-pty","version":"1.0.0"}',
    [`${pty}/binding.gyp`]: "{}",
    [`${pty}/lib/index.js`]: "require('../build/Release/pty.node');\n",
  });
  fs.symlinkSync(".pnpm/a@1.0.0/node_modules/a", path.join(dir, "node_modules", "a"));
  const before = stageContents(dir);
  assert.match(before[".pnpm/a@1.0.0/node_modules/a/index.js"], /^file 6\d\d [0-9a-f]{64}$/);
  assert.equal(before.a, "link .pnpm/a@1.0.0/node_modules/a");
  const at = (name) => path.join(dir, "node_modules", name);
  // What the packager and electron-builder do: copy a binary beside its loader, rebuild node-pty.
  fs.copyFileSync(at(".pnpm/keyring-darwin@1.0.0/node_modules/keyring-darwin/keyring.node"), at(".pnpm/keyring@1.0.0/node_modules/keyring/keyring.darwin-arm64.node"));
  fs.mkdirSync(at(`${pty}/build/Release/.deps`), { recursive: true });
  fs.writeFileSync(at(`${pty}/build/Release/pty.node`), "COMPILED", { mode: 0o755 });
  fs.mkdirSync(at(".pnpm/node-pty@1.0.0/node-addon-api@7.1.1/node_modules/node-addon-api"), { recursive: true });
  fs.writeFileSync(at(".pnpm/node-pty@1.0.0/node-addon-api@7.1.1/node_modules/node-addon-api/x.target.mk"), "");
  // node-gyp's scratch for a dependency also lands inside the package, run to run (seen in a real build).
  fs.mkdirSync(at(`${pty}/node-addon-api@7.1.1/node_modules/node-addon-api`), { recursive: true });
  fs.writeFileSync(at(`${pty}/node-addon-api@7.1.1/node_modules/node-addon-api/node_addon_api_except.stamp`), "");
  assert.deepEqual(stageChanges(before, stageContents(dir)), []);
  // Anything else is a change, wherever it is.
  const probe = (change, expected) => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-probe-"));
    fs.cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
    change((name) => path.join(copy, "node_modules", name));
    assert.deepEqual(stageChanges(before, stageContents(copy)), expected);
  };
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/index.js"), "module.exports = 'replaced';\n"), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.chmodSync(p(".pnpm/a@1.0.0/node_modules/a/index.js"), 0o755), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.rmSync(p(".pnpm/a@1.0.0/node_modules/a/index.js")), [".pnpm/a@1.0.0/node_modules/a/index.js"]);
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/index.mjs"), "export default 2;\n"), [".pnpm/a@1.0.0/node_modules/a/index.mjs"]);
  probe((p) => {
    fs.rmSync(p("a"));
    fs.symlinkSync(".pnpm/keyring@1.0.0/node_modules/keyring", p("a"));
  }, ["a"]);
  // A binary nothing installed, even under a native package's own folder.
  probe((p) => fs.writeFileSync(p(".pnpm/a@1.0.0/node_modules/a/evil.node"), "NEW"), [".pnpm/a@1.0.0/node_modules/a/evil.node"]);
  probe((p) => fs.writeFileSync(p(`${pty}/lib/evil.node`), "NEW"), [`.pnpm/node-pty@1.0.0/node_modules/node-pty/lib/evil.node`]);
  // A new node_modules in the native package, where its own require() calls would look first.
  probe((p) => {
    fs.mkdirSync(p(`${pty}/node_modules/evil@1.0.0`), { recursive: true });
    fs.writeFileSync(p(`${pty}/node_modules/evil@1.0.0/index.js`), "");
  }, [`${pty}/node_modules`, `${pty}/node_modules/evil@1.0.0`, `${pty}/node_modules/evil@1.0.0/index.js`]);
  // A file beside the native package's code (index.json would answer require("./lib/index")'s fallback).
  probe((p) => fs.writeFileSync(p(`${pty}/lib/index.json`), "{}"), [`${pty}/lib/index.json`]);
  // A package dropped into the native package's store entry, where Node would resolve it from.
  probe((p) => {
    fs.mkdirSync(p(".pnpm/node-pty@1.0.0/node_modules/evil"));
    fs.writeFileSync(p(".pnpm/node-pty@1.0.0/node_modules/evil/package.json"), "{}");
  }, [".pnpm/node-pty@1.0.0/node_modules/evil", ".pnpm/node-pty@1.0.0/node_modules/evil/package.json"]);
  // A link in the rebuild output.
  probe((p) => fs.symlinkSync("/etc", p(`${pty}/build/Release/elsewhere`)), [`.pnpm/node-pty@1.0.0/node_modules/node-pty/build/Release/elsewhere`]);
});

test("BUILD3-01: the reviewer's replacement through npm: refused by the shim, and failing the build by absolute path", async (t) => {
  const npm = findOnPath("npm", process.env.PATH, "/nonexistent");
  if (!npm) return t.skip("no npm on PATH");
  const stage = fakeStage();
  await quietly(() => guardedInstall(stage.app, stage.env));
  verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD);
  // is-number@7.0.0 again, same name and version, other bytes and an install script.
  const pkg = path.join(stage.root, "fixture", "package");
  fs.mkdirSync(pkg, { recursive: true });
  const marker = path.join(stage.root, "script-ran");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "is-number", version: "7.0.0", scripts: { install: "node install.cjs" } }));
  fs.writeFileSync(path.join(pkg, "install.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = () => 'unreviewed replacement';\n");
  const tarball = path.join(stage.root, "replacement.tgz");
  assert.equal(spawnSync("tar", ["-czf", tarball, "-C", path.dirname(pkg), "package"]).status, 0);
  const args = ["ins", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--offline", "--cache", path.join(stage.root, "npm-cache"), tarball];
  // Through the shim (the PATH the packager has): refused before npm runs.
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await main("npm", args, { cwd: stage.app, env: stage.env }), 1);
  } finally {
    console.error = error;
  }
  assert.equal(fs.existsSync(marker), false);
  verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD);
  // By absolute path, past the shims: npm replaces the package's files under the same name and version.
  const real = spawnSync(npm, [...args.slice(0, -1), "--ignore-scripts", tarball], { cwd: stage.app, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" } });
  assert.equal(real.status, 0, real.stderr);
  assert.match(fs.readFileSync(path.join(stage.app, "node_modules", "is-number", "index.js"), "utf8"), /unreviewed replacement/);
  assert.throws(() => verifyStageInstalls(stage.stages, stage.env.T3BLACKOUT_STAGE_RECORD), /isn't what was installed from its checked lockfile: node_modules\/.*is-number/);
});

test("BUILD3-01: a record without the installed files (an older guard's) fails the build", async () => {
  const stage = fakeStage();
  await quietly(() => guardedInstall(stage.app, stage.env));
  const record = stage.env.T3BLACKOUT_STAGE_RECORD;
  const { files, ...rest } = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.ok(files);
  fs.writeFileSync(record, `${JSON.stringify(rest)}\n`);
  assert.throws(() => verifyStageInstalls(stage.stages, record), /has no record of the files it installed/);
});
