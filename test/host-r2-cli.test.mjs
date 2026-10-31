// node --test test/: the CLI's rollback, recovery and install config, run from a
// scratch copy of bin/ and lib/ with every location (home, apps, state) in a
// scratch folder. Only commands that touch nothing else run here: rollback and
// configure (no network, no launch, no scheduling).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { tryLock } from "../lib/lock.mjs";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const isMac = process.platform === "darwin";

function cli() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-cli-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const apps = path.join(dir, "Applications");
  const data = path.join(dir, "data");
  fs.mkdirSync(apps);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    T3BLACKOUT_HOME: path.join(home, ".t3blackout"),
    T3BLACKOUT_APPS: apps,
    T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "t3blackout", "update-requests"),
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    T3BLACKOUT_HEADLESS: "1",
  };
  const slots = isMac
    ? { installed: path.join(apps, "T3 Blackout.app"), previous: path.join(apps, ".T3 Blackout.previous.app"), outgoing: path.join(apps, ".T3 Blackout.outgoing.app"), legacy: path.join(home, "Applications", "T3 Blackout.app"), staged: path.join(apps, ".T3 Blackout.new.app") }
    : { installed: path.join(data, "t3blackout", "app"), previous: path.join(data, "t3blackout", "app.previous"), outgoing: path.join(data, "t3blackout", "app.outgoing"), legacy: null, staged: path.join(data, "t3blackout", "app.new") };
  fs.mkdirSync(path.dirname(slots.installed), { recursive: true });
  const state = path.join(repo, "state");
  fs.mkdirSync(state, { recursive: true });
  const run = (args, extra = {}) => spawnSync(process.execPath, [path.join(repo, "bin", "t3blackout"), ...args], { encoding: "utf8", env: { ...env, ...extra }, timeout: 60_000 });
  const make = (where, v) => {
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, "version"), v);
  };
  const version = (where) => (fs.existsSync(where) ? fs.readFileSync(path.join(where, "version"), "utf8") : null);
  const record = (name) => JSON.parse(fs.readFileSync(path.join(state, name), "utf8"));
  const writeRecord = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value));
  return { dir, repo, state, slots, run, make, version, record, writeRecord };
}

/** Installed v2 recorded as current, v1 as previous. */
function installedTwo(c) {
  c.make(c.slots.installed, "v2");
  c.make(c.slots.previous, "v1");
  c.writeRecord("current.json", { ref: "v2" });
  c.writeRecord("previous.json", { ref: "v1" });
}

test("rollback waits its turn: refused while an update holds the lock, then swaps (HOST2-05)", async () => {
  const c = cli();
  installedTwo(c);
  const release = await tryLock(path.join(c.state, "update.lock"));
  try {
    const refused = c.run(["rollback"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /another t3blackout update is running/);
    assert.equal(c.version(c.slots.installed), "v2", "nothing moved");
    assert.equal(c.record("current.json").ref, "v2");
  } finally {
    await release();
  }
  const done = c.run(["rollback"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.deepEqual([c.version(c.slots.installed), c.version(c.slots.previous)], ["v1", "v2"]);
  assert.deepEqual([c.record("current.json").ref, c.record("previous.json").ref], ["v1", "v2"]);
  // The lock, the records and the log are yours alone (HOST2-04).
  assert.equal(fs.statSync(c.state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(c.state, "update.lock")).mode & 0o777, 0o600);
});

test("a record that isn't a file stops a rollback before anything moves (HOST2-08)", () => {
  const c = cli();
  installedTwo(c);
  fs.rmSync(path.join(c.state, "previous.json"));
  fs.mkdirSync(path.join(c.state, "previous.json"));
  const refused = c.run(["rollback"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /previous\.json isn't a regular file/);
  assert.deepEqual([c.version(c.slots.installed), c.version(c.slots.previous)], ["v2", "v1"]);
  assert.equal(fs.existsSync(path.join(c.state, "activation.json")), false);
});

test("an install cut off after its build went in is finished before the next command acts (HOST2-08)", () => {
  const c = cli();
  // As a crash left it: v3 moved in, v2 aside, records still naming v2.
  const { staged, ...slots } = c.slots;
  c.make(slots.installed, "v3");
  c.make(slots.outgoing, "v2");
  c.make(slots.previous, "v1");
  c.writeRecord("current.json", { ref: "v2" });
  c.writeRecord("previous.json", { ref: "v1" });
  const build = { ref: "v3", sha: "3".repeat(40), version: "3", blackout: null };
  c.writeRecord("activation.json", {
    v: 1, op: "install", slots, staged, origin: slots.installed, committed: false,
    records: { current: { ...build, installedAt: "2026-10-30T00:00:00.000Z" }, previous: { ref: "v2" }, clearPending: true, build },
  });
  const done = c.run(["rollback"]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /finished an interrupted install \(v3 installed\)/);
  // Then the rollback itself, on records that match the folders: back to v2.
  assert.deepEqual([c.version(slots.installed), c.version(slots.previous)], ["v2", "v3"]);
  assert.deepEqual([c.record("current.json").ref, c.record("previous.json").ref], ["v2", "v3"]);
  assert.equal(fs.existsSync(path.join(c.state, "activation.json")), false);
});

test("an invalid install config stops every command but configure, which repairs it (HOST2-10)", () => {
  const c = cli();
  installedTwo(c);
  fs.writeFileSync(path.join(c.state, "install.json"), '{"role":"host","env":{"T3BLACKOUT_APPS":');
  const refused = c.run(["rollback"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /install\.json isn't valid JSON/);
  assert.equal(c.version(c.slots.installed), "v2", "nothing ran on the default locations");
  assert.match(c.run(["configure"]).stdout, /give the role/);
  const repaired = c.run(["configure", "--role", "ui"]);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.equal(c.record("install.json").role, "ui");
  assert.equal(c.run(["rollback"]).status, 0);
});

test("configure refuses host roles that move what agent accounts rely on (HOST2-11)", { skip: !isMac && "host roles are macOS only" }, () => {
  const c = cli();
  const refused = c.run(["configure", "--role", "host"]);
  assert.equal(refused.status, 1);
  // The scratch apps folder is a T3BLACKOUT_APPS override; an account that can't write /Applications is refused first.
  assert.match(refused.stdout + refused.stderr, /can't use T3BLACKOUT_APPS|installs the app in \/Applications/);
  assert.equal(fs.existsSync(path.join(c.state, "install.json")), false);
});
