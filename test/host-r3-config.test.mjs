// node --test test/: the locations a run uses are checked before anything is
// written (lib/install-config.mjs locationsOf, lib/load-install-config.mjs):
// empty is unset, relative or in-the-clone T3BLACKOUT_HOME is refused; and the
// CLI shim (~/.t3blackout/bin/t3blackout) never replaces or writes through to
// the CLI itself (HOST3-02).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { locationsOf, readInstallConfig, useLocations } from "../lib/install-config.mjs";

const REPO = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));

/** A scratch clone (bin/ and lib/), a home, and every location in the scratch folder. */
function clone() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-config-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const launcher = path.join(repo, "bin", "t3blackout");
  const original = fs.readFileSync(launcher, "utf8");
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_APPS: path.join(dir, "Apps"), T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "requests"), XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config"), T3BLACKOUT_HEADLESS: "1" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [launcher, ...args], { cwd: repo, encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 });
  const intact = () => fs.readFileSync(launcher, "utf8") === original;
  return { dir, repo, home, launcher, run, intact };
}

test("empty locations are unset; relative ones and a T3BLACKOUT_HOME in this clone are refused (HOST3-02)", () => {
  const locations = locationsOf({ T3BLACKOUT_HOME: "", T3BLACKOUT_APPS: "/Volumes/Apps/", XDG_DATA_HOME: "/data/../store" });
  assert.equal(locations.T3BLACKOUT_HOME, null);
  assert.equal(locations.T3BLACKOUT_APPS, "/Volumes/Apps");
  assert.equal(locations.XDG_DATA_HOME, "/store");
  assert.throws(() => locationsOf({ T3BLACKOUT_HOME: "." }), /T3BLACKOUT_HOME=\. isn't an absolute path/);
  assert.throws(() => locationsOf({ XDG_CONFIG_HOME: "config" }), /isn't an absolute path/);
  for (const inside of [REPO, `${REPO}/`, path.join(REPO, "state"), path.join(REPO, "bin", "..")]) {
    assert.throws(() => locationsOf({ T3BLACKOUT_HOME: inside }), /is this clone .* or inside it/, inside);
  }
  // Through a symlink, and in another letter case where the disk ignores case.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-config-")));
  fs.symlinkSync(REPO, path.join(dir, "link"));
  assert.throws(() => locationsOf({ T3BLACKOUT_HOME: path.join(dir, "link", "home") }), /or inside it/);
  const upper = REPO.toUpperCase();
  if (upper !== REPO && fs.existsSync(upper)) assert.throws(() => locationsOf({ T3BLACKOUT_HOME: upper }), /or inside it/);
  // Beside the clone is fine.
  assert.equal(locationsOf({ T3BLACKOUT_HOME: path.join(path.dirname(REPO), "t3b-home") }).T3BLACKOUT_HOME, path.join(path.dirname(REPO), "t3b-home"));
  // Applied to the environment: empties are gone even when another location is refused.
  const env = { T3BLACKOUT_HOME: "", T3BLACKOUT_APPS: "/Volumes/Apps/" };
  useLocations(env);
  assert.deepEqual(env, { T3BLACKOUT_APPS: "/Volumes/Apps" });
  const refused = { T3BLACKOUT_HOME: "", XDG_DATA_HOME: "data" };
  assert.throws(() => useLocations(refused));
  assert.deepEqual(refused, { XDG_DATA_HOME: "data" });
});

test("a saved T3BLACKOUT_HOME in the clone is an invalid config (HOST3-02)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-config-"));
  const file = path.join(dir, "install.json");
  fs.writeFileSync(file, JSON.stringify({ role: "ui", env: { T3BLACKOUT_HOME: REPO } }));
  assert.throws(() => readInstallConfig(file), /install\.json is invalid \(T3BLACKOUT_HOME=.* is this clone/);
});

test("configure with an empty, relative or in-clone T3BLACKOUT_HOME never overwrites the CLI (HOST3-02)", () => {
  // Empty: unset, so the shim goes to the default home and configure works.
  const empty = clone();
  const saved = empty.run(["configure", "--role", "ui"], { T3BLACKOUT_HOME: "" });
  assert.equal(saved.status, 0, saved.stdout + saved.stderr);
  assert.ok(empty.intact(), "the CLI is untouched");
  assert.match(fs.readFileSync(path.join(empty.home, ".t3blackout", "bin", "t3blackout"), "utf8"), /^#!\/bin\/sh\n# Written by t3blackout/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(empty.repo, "state", "install.json"), "utf8")).env.T3BLACKOUT_HOME, null);
  assert.equal(empty.run(["configure", "--role", "ui"], { T3BLACKOUT_HOME: "" }).status, 0, "and it still runs");
  // Relative, the clone itself, and inside it: refused before anything is written.
  for (const value of [".", "REPO", "REPO/lib"]) {
    const c = clone();
    const home = value.replace("REPO", c.repo);
    for (const args of [["configure", "--role", "ui"], ["drift"]]) {
      const refused = c.run(args, { T3BLACKOUT_HOME: home });
      assert.equal(refused.status, 1, `${value} ${args[0]}`);
      assert.match(refused.stdout, /T3BLACKOUT_HOME=.* (isn't an absolute path|is this clone)/, `${value} ${args[0]}`);
      assert.ok(c.intact(), `${value} ${args[0]}: the CLI is untouched`);
    }
    assert.equal(fs.existsSync(path.join(c.repo, "state", "install.json")), false, `${value}: nothing saved`);
    assert.equal(fs.existsSync(path.join(c.repo, "lib", "bin")), false, `${value}: no shim inside the clone`);
    assert.equal(c.run(["drift"]).status, 0, `${value}: the CLI still runs`);
  }
});

test("a shim path that leads to the CLI is replaced, never written through (HOST3-02)", () => {
  // The shim is a symlink to the CLI: replaced by the shim itself.
  const link = clone();
  const t3bHome = path.join(link.home, ".t3blackout");
  fs.mkdirSync(path.join(t3bHome, "bin"), { recursive: true });
  fs.symlinkSync(link.launcher, path.join(t3bHome, "bin", "t3blackout"));
  assert.equal(link.run(["drift"], { T3BLACKOUT_HOME: t3bHome }).status, 0);
  assert.ok(link.intact(), "the CLI is untouched");
  const shim = path.join(t3bHome, "bin", "t3blackout");
  assert.equal(fs.lstatSync(shim).isSymbolicLink(), false);
  assert.match(fs.readFileSync(shim, "utf8"), /exec .*'\S*\/repo\/bin\/t3blackout' "\$@"/);
  // The shim's folder is the clone's bin/ by another path: left alone.
  const folder = clone();
  const other = path.join(folder.home, ".t3blackout");
  fs.mkdirSync(other);
  fs.symlinkSync(path.join(folder.repo, "bin"), path.join(other, "bin"));
  assert.equal(folder.run(["drift"], { T3BLACKOUT_HOME: other }).status, 0);
  assert.ok(folder.intact(), "the CLI is untouched");
});
