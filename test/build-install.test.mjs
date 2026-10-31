// node --test test/: dependency installs resolve first, are checked, and only
// then install frozen (lib/resolution.mjs, lib/stage-install.mjs): WORK's
// security-override re-resolution (SUPPLY-05) and the packager's staged
// production install (SUPPLY-04, BUILD-01).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyStageInstalls } from "../lib/build.mjs";
import { checkResolution } from "../lib/resolution.mjs";
import { classify, guardedInstall, main, releaseAgeConfig, shimEnv } from "../lib/stage-install.mjs";

/** A pnpm 9.0 lockfile (as pnpm 12 writes it) with `packages` (name@version) as direct dependencies. */
function lockfile(packages) {
  const split = (pkg) => [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];
  const quote = (key) => (key.startsWith("@") ? `'${key}'` : key);
  return [
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

const noGate = async () => {
  throw new Error("the age gate shouldn't run: nothing was added");
};
const youngGate = async (base, next) => ({ young: [{ pkg: "fresh@1.0.1", publishedAt: "2026-10-29T00:00:00.000Z" }], unknown: [] });

test("checkResolution: overrides must take, and versions the base lacks must be old enough", async () => {
  const base = lockfile(["is-number@7.0.0", "body-parser@2.3.0"]);
  // A vulnerable version an override replaces is still there.
  await assert.rejects(checkResolution(base, base, { gate: noGate }), /security overrides didn't take: body-parser@2.3.0/);
  // Its fix is fine without an age check (the gate still checks its integrity); nothing else was added.
  const fixed = lockfile(["is-number@7.0.0", "body-parser@2.4.0"]);
  const oldEnough = async () => ({ young: [{ pkg: "body-parser@2.4.0", publishedAt: "2026-10-29T00:00:00.000Z" }], unknown: [], substituted: [] });
  assert.deepEqual((await checkResolution(base, fixed, { gate: oldEnough })).added, []);
  // A version the base doesn't have, under the minimum age.
  await assert.rejects(checkResolution(base, lockfile(["is-number@7.0.0", "body-parser@2.4.0", "fresh@1.0.1"]), { gate: youngGate }), /under 3 days old.*fresh@1\.0\.1/);
});

test("the stage shims: the packager's staged install runs the guard explicitly, so every install through PATH in the stage is refused", () => {
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-stage-")));
  fs.mkdirSync(path.join(stage, "app"));
  // BUILD2-01: the rule desktop/stage-install-guarded runs the guard itself; a PATH `vp install --prod` is a new, unrouted install.
  assert.equal(classify("vp", ["install", "--prod"], path.join(stage, "app"), stage), "refuse");
  assert.equal(classify("vp", ["install", "--prod", "--no-frozen-lockfile"], path.join(stage, "app"), stage), "refuse");
  assert.equal(classify("pnpm", ["install"], path.join(stage, "app"), stage), "refuse");
  assert.equal(classify("npm", ["--prefix", "x", "ci"], path.join(stage, "app"), stage), "refuse");
  assert.equal(classify("pnpm", ["--package=x", "dlx", "x"], path.join(stage, "app"), stage), "refuse");
  assert.equal(classify("pnpm", ["list", "--prod", "--json"], path.join(stage, "app"), stage), "pass");
  assert.equal(classify("vp", ["install", "--prod"], os.tmpdir(), stage), "pass");
  const config = releaseAgeConfig(new Set(["a@1.0.0", "a@1.1.0", "@s/b@2.0.0"]), 3);
  assert.match(config, /^minimumReleaseAge: 4320$/m);
  assert.match(config, /^minimumReleaseAgeStrict: true$/m);
  assert.match(config, /^ {2}- "@s\/b@2\.0\.0"$/m);
  assert.match(config, /^ {2}- "a@1\.0\.0 \|\| 1\.1\.0"$/m);
});

/** A stage with a fake vp whose lockfile-only resolution writes `resolved`; returns what to run guardedInstall with. */
function fakeStage(resolved) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-stage-")));
  const app = path.join(root, "t3code-desktop-mac-stage-x", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), '{"name":"t3blackout","dependencies":{"is-number":"^7.0.0"}}\n');
  fs.writeFileSync(path.join(app, "pnpm-workspace.yaml"), "supportedArchitectures:\n  os:\n    - darwin\n");
  const vp = path.join(root, "real-vp.cjs");
  fs.writeFileSync(
    vp,
    `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.log"))}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", ${JSON.stringify(resolved)});
else if (process.argv.includes("--frozen-lockfile")) {
  fs.mkdirSync("node_modules/is-number", { recursive: true });
  fs.writeFileSync("node_modules/is-number/package.json", '{"name":"is-number","version":"7.0.0"}');
}`,
  );
  const real = path.join(root, "vp");
  fs.writeFileSync(real, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(vp)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "verified.yaml"), lockfile(["is-number@7.0.0"]));
  const env = { PATH: process.env.PATH, T3BLACKOUT_REAL_VP: real, T3BLACKOUT_SHIM_DIR: path.join(root, "shims"), T3BLACKOUT_STAGE_ROOT: root, T3BLACKOUT_VERIFIED_LOCK: path.join(root, "verified.yaml"), T3BLACKOUT_STAGE_RECORD: path.join(root, "record.jsonl") };
  const calls = () => fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
  return { root, app, env, calls };
}

test("SUPPLY-04/05: the staged install resolves without scripts, is checked, then installs frozen", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0"]));
  await guardedInstall(stage.app, stage.env);
  assert.deepEqual(stage.calls(), ["install --prod --lockfile-only --ignore-scripts", "install --prod --frozen-lockfile"]);
  assert.match(fs.readFileSync(path.join(stage.app, "pnpm-workspace.yaml"), "utf8"), /minimumReleaseAge: \d+\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude:\n {2}- "is-number@7\.0\.0"/);
  assert.equal(JSON.parse(fs.readFileSync(stage.env.T3BLACKOUT_STAGE_RECORD, "utf8")).dir, stage.app);
  // The build's check afterwards: every node_modules in the stage was checked.
  verifyStageInstalls({ tmpdir: stage.root, findArtifact() {}, cleanup() {} }, stage.env.T3BLACKOUT_STAGE_RECORD);
});

test("a staged resolution that fails the check installs nothing: no script ever ran", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0", "body-parser@2.3.0"]));
  await assert.rejects(guardedInstall(stage.app, stage.env), /security overrides didn't take/);
  assert.deepEqual(stage.calls(), ["install --prod --lockfile-only --ignore-scripts"]);
  assert.equal(fs.existsSync(path.join(stage.app, "node_modules")), false);
});

test("the build refuses a stage installed around the guard", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0"]));
  const stages = { tmpdir: stage.root, findArtifact() {}, cleanup() {} };
  // Never ran at all.
  assert.throws(() => verifyStageInstalls(stages, stage.env.T3BLACKOUT_STAGE_RECORD), /never ran/);
  // Ran for one folder, but another stage folder has node_modules nothing checked.
  await guardedInstall(stage.app, stage.env);
  const other = path.join(stage.root, "t3code-desktop-mac-stage-y", "server", "node_modules");
  fs.mkdirSync(other, { recursive: true });
  assert.throws(() => verifyStageInstalls(stages, stage.env.T3BLACKOUT_STAGE_RECORD), /installed dependencies nothing checked/);
});

test("shims stand in for vp, pnpm, npm and yarn, and refuse an unexpected install in the stage", async () => {
  const stage = fakeStage(lockfile(["is-number@7.0.0"]));
  const env = shimEnv({ dir: path.join(stage.root, "shims"), env: { PATH: process.env.PATH }, stageRoot: stage.root, verifiedLock: stage.env.T3BLACKOUT_VERIFIED_LOCK, record: stage.env.T3BLACKOUT_STAGE_RECORD });
  for (const tool of ["vp", "pnpm", "npm", "yarn"]) assert.ok(fs.statSync(path.join(stage.root, "shims", tool)).mode & 0o100, tool);
  assert.ok(env.PATH.startsWith(path.join(stage.root, "shims") + ":"));
  assert.ok(!env.T3BLACKOUT_REAL_NPM.startsWith(path.join(stage.root, "shims")));
  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(line);
  try {
    assert.equal(await main("pnpm", ["add", "left-pad"], { cwd: stage.app, env }), 1);
  } finally {
    console.error = error;
  }
  assert.match(errors.join("\n"), /refused `pnpm add left-pad` in the packager's stage/);
});
