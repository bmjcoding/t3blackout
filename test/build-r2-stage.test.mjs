// node --test test/: the packager's staged install boundary (BUILD2-01,
// SUPPLY2-05): the rule runs the guard explicitly, the shims refuse any install
// aimed at the stage however it's spelled, and the build checks afterwards
// that every staged node_modules is still exactly what the guard checked.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyStageInstalls } from "../lib/build.mjs";
import { makeRules } from "../lib/rules.mjs";
import { classify, guardedInstall, installedPackages, main, stageDigest } from "../lib/stage-install.mjs";
import { applyRules } from "../lib/strip-engine.mjs";

/** A pnpm 9.0 lockfile with `packages` (name@version) as direct dependencies. */
function lockfile(packages) {
  const split = (pkg) => [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];
  const quote = (key) => (key.startsWith("@") ? `'${key}'` : key);
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    ...packages.flatMap((pkg) => [`      ${quote(split(pkg)[0])}:`, `        specifier: ${split(pkg)[1]}`, `        version: ${split(pkg)[1]}`]),
    "",
    "packages:",
    "",
    ...packages.flatMap((pkg) => [`  ${quote(pkg)}:`, "    resolution: {integrity: sha512-AAAA}", ""]),
    "snapshots:",
    "",
    ...packages.flatMap((pkg) => [`  ${quote(pkg)}: {}`, ""]),
  ].join("\n");
}

const stageRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-stage-")));

test("SUPPLY2-05: an install aimed at the stage is refused however it's spelled; other commands pass", () => {
  const root = stageRoot();
  const stage = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(stage, { recursive: true });
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-repo-")));
  // Global options with values before the command (the reviewer's case), from outside the stage.
  assert.equal(classify("pnpm", ["--dir", stage, "install", "--prod"], repo, root), "refuse");
  assert.equal(classify("pnpm", ["-C", stage, "add", "left-pad"], repo, root), "refuse");
  assert.equal(classify("npm", ["--prefix", stage, "install"], repo, root), "refuse");
  assert.equal(classify("npm", ["install", `--prefix=${stage}`], repo, root), "refuse");
  assert.equal(classify("yarn", ["--cwd", path.relative(repo, stage), "install"], repo, root), "refuse");
  assert.equal(classify("vp", ["--filter", "./x", "install"], stage, root), "refuse");
  // A destination in the environment.
  assert.equal(classify("npm", ["install"], repo, root, { npm_config_prefix: stage }), "refuse");
  // Script runners and links count too.
  assert.equal(classify("npm", ["rebuild"], stage, root), "refuse");
  assert.equal(classify("pnpm", ["link", "../x"], stage, root), "refuse");
  // What the packager and electron-builder really run.
  assert.equal(classify("vp", ["exec", "--filter", "@t3tools/desktop", "--", "electron-builder", "--projectDir", stage, "--mac", "--arm64"], repo, root), "pass");
  assert.equal(classify("pnpm", ["list", "--prod", "--json", "--depth", "Infinity"], stage, root), "pass");
  assert.equal(classify("vp", ["run", "build:desktop"], repo, root), "pass");
  assert.equal(classify("pnpm", ["install"], repo, root), "pass");
});

/** A stage folder with a fake vp (lockfile-only writes `resolved`, frozen installs `installed`). */
function fakeStage(resolved, installed = { "is-number": "7.0.0" }) {
  const root = stageRoot();
  const app = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), '{"name":"t3blackout","dependencies":{"is-number":"^7.0.0"}}\n');
  fs.writeFileSync(path.join(app, "pnpm-workspace.yaml"), "supportedArchitectures:\n  os:\n    - darwin\n");
  const vp = path.join(root, "real-vp.cjs");
  fs.writeFileSync(
    vp,
    `const fs = require("node:fs");
if (process.argv.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", ${JSON.stringify(resolved)});
else {
  for (const [name, version] of Object.entries(${JSON.stringify(installed)})) {
    fs.mkdirSync("node_modules/.pnpm/" + name + "@" + version + "/node_modules/" + name, { recursive: true });
    fs.writeFileSync("node_modules/.pnpm/" + name + "@" + version + "/node_modules/" + name + "/package.json", JSON.stringify({ name, version }));
    fs.symlinkSync(".pnpm/" + name + "@" + version + "/node_modules/" + name, "node_modules/" + name);
  }
  fs.writeFileSync("node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'");
}`,
  );
  const real = path.join(root, "vp");
  fs.writeFileSync(real, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(vp)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "verified.yaml"), lockfile(["is-number@7.0.0"]));
  const env = { PATH: process.env.PATH, T3BLACKOUT_REAL_VP: real, T3BLACKOUT_SHIM_DIR: path.join(root, "shims"), T3BLACKOUT_STAGE_ROOT: root, T3BLACKOUT_VERIFIED_LOCK: path.join(root, "verified.yaml"), T3BLACKOUT_STAGE_RECORD: path.join(root, "record.jsonl") };
  return { root, app, env, stages: { tmpdir: root, findArtifact() {}, cleanup() {} } };
}

test("BUILD2-01: the guard runs only as the rule calls it, once per stage folder, and refuses loosened settings", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0"]));
  await assert.rejects(main("guard", ["install"], { cwd: stage.app, env: stage.env }), /the guard runs `vp install --prod` only/);
  assert.equal(await main("guard", ["install", "--prod"], { cwd: stage.app, env: stage.env }), 0);
  await assert.rejects(guardedInstall(stage.app, stage.env), /already installed once/);
  // Outside the build's private temp folder.
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-outside-")));
  await assert.rejects(guardedInstall(outside, stage.env), /isn't in the build's private temp folder/);
  // Upstream turning off pnpm's checks in the stage's own config.
  const loose = fakeStage(lockfile(["is-number@7.0.0"]));
  fs.appendFileSync(path.join(loose.app, "pnpm-workspace.yaml"), "trustLockfile: true\n");
  await assert.rejects(guardedInstall(loose.app, loose.env), /sets trustLockfile/);
});

test("BUILD2-01: the build refuses a stage changed after its check: an install around the guard, or a rewritten manifest", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0"]));
  await guardedInstall(stage.app, stage.env);
  const record = stage.env.T3BLACKOUT_STAGE_RECORD;
  const checked = verifyStageInstalls(stage.stages, record);
  assert.equal(checked.locks.length, 1);
  assert.match(checked.locks[0], /is-number@7\.0\.0/);
  // An npm started by absolute path (past the shims) adds a package; its record is still there.
  fs.mkdirSync(path.join(stage.app, "node_modules", "evil"), { recursive: true });
  fs.writeFileSync(path.join(stage.app, "node_modules", "evil", "package.json"), '{"name":"evil","version":"1.0.0"}');
  assert.throws(() => verifyStageInstalls(stage.stages, record), /has packages its checked lockfile doesn't: evil@1\.0\.0/);
  fs.rmSync(path.join(stage.app, "node_modules", "evil"), { recursive: true });
  verifyStageInstalls(stage.stages, record);
  // The manifest the check was for isn't the one there now.
  fs.writeFileSync(path.join(stage.app, "package.json"), '{"name":"t3blackout","dependencies":{"is-number":"^7.0.0","evil":"*"}}\n');
  assert.throws(() => verifyStageInstalls(stage.stages, record), /isn't the one checked/);
});

test("installedPackages reads real package folders (pnpm's store, nested, scoped), skipping links and bundled dependencies", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-installed-")));
  const pkg = (where, manifest) => {
    fs.mkdirSync(path.join(dir, where), { recursive: true });
    fs.writeFileSync(path.join(dir, where, "package.json"), JSON.stringify(manifest));
  };
  pkg("node_modules/.pnpm/a@1.0.0/node_modules/a", { name: "a", version: "1.0.0" });
  pkg("node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b", { name: "@s/b", version: "2.0.0", bundleDependencies: ["inner"] });
  pkg("node_modules/.pnpm/@s+b@2.0.0/node_modules/@s/b/node_modules/inner", { name: "inner", version: "9.9.9" });
  pkg("node_modules/c", { name: "c", version: "3.0.0" });
  pkg("node_modules/c/node_modules/d", { name: "d", version: "4.0.0" });
  fs.symlinkSync(".pnpm/a@1.0.0/node_modules/a", path.join(dir, "node_modules", "a"));
  fs.writeFileSync(path.join(dir, "node_modules/.pnpm/lock.yaml"), "");
  fs.mkdirSync(path.join(dir, "node_modules/.bin"));
  assert.deepEqual([...installedPackages(dir)].sort(), ["@s/b@2.0.0", "a@1.0.0", "c@3.0.0", "d@4.0.0"]);
  fs.mkdirSync(path.join(dir, "node_modules/stray"));
  assert.throws(() => installedPackages(dir), /stray is in node_modules without a readable package\.json/);
});

/** The two staged installs in scripts/build-desktop-artifact.ts, as upstream writes them (plus `extra`). */
const packager = (extra = "") =>
  [
    'export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;',
    "function stageApp() {",
    '  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);',
    "}",
    "function stageSidecar() {",
    '  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);',
    "}",
    extra,
  ].join("\n");

test("BUILD2-01: the rule routes upstream's two staged installs through the guard, and a third install stops the build", () => {
  const rule = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((r) => r.id === "desktop/stage-install-guarded");
  const apply = (text) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-rule-"));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, rule.file), text);
    const log = console.log;
    console.log = () => {};
    try {
      return { failures: applyRules(root, [rule]), text: fs.readFileSync(path.join(root, rule.file), "utf8") };
    } finally {
      console.log = log;
    }
  };
  const done = apply(packager());
  assert.deepEqual(done.failures, []);
  assert.equal(done.text.match(/const installCommand = blackoutStageInstall\(\);/g).length, 2);
  assert.doesNotMatch(done.text, /resolveSpawnCommand\("vp", \[\.\.\.STAGE_INSTALL_ARGS\]\)/);
  assert.match(done.text, /process\.env\.T3BLACKOUT_STAGE_GUARD/);
  assert.equal(apply(packager('function more() {\n  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);\n}')).failures.length, 1);
  assert.equal(apply(packager("const again = [...STAGE_INSTALL_ARGS];")).failures.length, 1);
});

test("a staged install's digest covers its manifest, workspace config and lockfile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-digest-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const before = stageDigest(dir);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "x");
  assert.notEqual(stageDigest(dir), before);
});
