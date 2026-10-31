// node --test test/: recovery only finishes a journal this install wrote
// (lib/platform/app.mjs readJournal): version, fields and types, records, and
// every path bound to the configured slots and staging folders, checked before
// anything moves; and it never finishes a "committed" install or rollback when
// the folders say otherwise (HOST3-05).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { recoverActivation } from "../lib/platform/app.mjs";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/** Installed v2, rollback copy v1, v3 staged; an unrelated project beside them. */
function world() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-app-")));
  const apps = path.join(dir, "Applications");
  fs.mkdirSync(apps);
  const slots = {
    installed: path.join(apps, "T3 Blackout.app"),
    previous: path.join(apps, ".T3 Blackout.previous.app"),
    outgoing: path.join(apps, ".T3 Blackout.outgoing.app"),
    legacy: null,
  };
  const staged = path.join(apps, ".T3 Blackout.new.app");
  const pending = path.join(apps, ".T3 Blackout.pending.app");
  const make = (where, v) => {
    fs.mkdirSync(where);
    fs.writeFileSync(path.join(where, "version"), v);
  };
  make(slots.installed, "2");
  make(slots.previous, "1");
  make(staged, "3");
  const project = path.join(dir, "project");
  make(project, "keep");
  const journal = path.join(dir, "activation.json");
  const commits = [];
  const recover = () => recoverActivation({ journal, commit: (records) => commits.push(records), slots, staging: [staged, pending] });
  const write = (entry) => fs.writeFileSync(journal, JSON.stringify(entry));
  const listing = () => [fs.readdirSync(apps).sort(), fs.readFileSync(path.join(project, "version"), "utf8")];
  const records = { current: { ref: "v3" }, previous: { ref: "v2" }, clearPending: true, build: { ref: "v3", sha: "3".repeat(40) } };
  const install = { v: 1, op: "install", slots, staged, origin: slots.installed, records, committed: false };
  const rollback = { v: 1, op: "rollback", slots, records: { current: { ref: "v1" }, previous: { ref: "v2" }, clearPending: false }, committed: false };
  return { dir, apps, slots, staged, project, journal, commits, recover, write, listing, install, rollback, make };
}

test("a journal that isn't one this install wrote is refused before anything moves (HOST3-05)", () => {
  const cases = (w) => [
    ["another version", { ...w.rollback, v: 999 }],
    ["no version", (({ v, ...rest }) => rest)(w.rollback)],
    ["an unknown op", { ...w.rollback, op: "swap" }],
    ["an extra field", { ...w.rollback, staged: w.staged }],
    ["a missing field", (({ committed, ...rest }) => rest)(w.install)],
    ["committed not a boolean", { ...w.rollback, committed: "yes" }],
    ["previous slot elsewhere", { ...w.rollback, committed: true, slots: { ...w.slots, previous: w.project } }],
    ["outgoing slot elsewhere", { ...w.rollback, committed: true, slots: { ...w.slots, outgoing: w.project } }],
    ["installed slot elsewhere", { ...w.rollback, slots: { ...w.slots, installed: w.project } }],
    ["an unknown slot", { ...w.rollback, slots: { ...w.slots, extra: w.project } }],
    ["a legacy slot it doesn't have", { ...w.install, slots: { ...w.slots, legacy: w.project }, origin: w.project }],
    ["staged outside staging", { ...w.install, staged: w.project }],
    ["origin elsewhere", { ...w.install, origin: w.project }],
    ["records not objects", { ...w.rollback, records: { ...w.rollback.records, current: "v1" } }],
    ["an unknown record", { ...w.rollback, records: { ...w.rollback.records, install: { ref: "x" } } }],
    ["clearPending not a boolean", { ...w.install, records: { ...w.install.records, clearPending: "yes" } }],
    ["a build that isn't an object", { ...w.install, records: { ...w.install.records, build: "v3" } }],
  ];
  for (const [label] of cases(world())) {
    const w = world();
    const [, entry] = cases(w).find(([name]) => name === label);
    w.write(entry);
    const before = w.listing();
    assert.throws(() => w.recover(), /activation\.json is damaged/, label);
    assert.deepEqual(w.listing(), before, `${label}: nothing moved`);
    assert.deepEqual(w.commits, [], `${label}: no records written`);
    assert.equal(fs.existsSync(w.journal), true, `${label}: the journal stays`);
  }
});

test("a committed journal is never finished while nothing is installed (HOST3-05)", () => {
  for (const op of ["install", "rollback"]) {
    const w = world();
    fs.renameSync(w.slots.installed, w.slots.outgoing);
    fs.rmSync(w.staged, { recursive: true });
    w.write({ ...w[op], committed: true });
    const before = w.listing();
    assert.throws(() => w.recover(), /says its build went in, but nothing is installed/, op);
    assert.deepEqual(w.listing(), before, `${op}: the rollback copy wasn't replaced or deleted`);
    assert.deepEqual(w.commits, []);
    assert.equal(fs.existsSync(w.journal), true);
  }
});

test("a staged build gone missing isn't taken for a committed install: the build it would replace never moved (HOST3-05)", () => {
  const w = world();
  fs.rmSync(w.staged, { recursive: true });
  w.write(w.install);
  const outcome = w.recover();
  assert.equal(outcome.committed, false);
  assert.deepEqual(w.commits, [], "records still name v2, which is what's installed");
  assert.equal(fs.readFileSync(path.join(w.slots.installed, "version"), "utf8"), "2");
  assert.equal(fs.readFileSync(path.join(w.slots.previous, "version"), "utf8"), "1");
});

test("journals this install wrote still recover, from either staging folder (HOST3-05)", () => {
  const w = world();
  // Cut off right after the new build went in.
  fs.renameSync(w.slots.installed, w.slots.outgoing);
  fs.renameSync(w.staged, w.slots.installed);
  w.write(w.install);
  assert.equal(w.recover().committed, true);
  assert.deepEqual(w.commits, [w.install.records]);
  assert.equal(fs.readFileSync(path.join(w.slots.previous, "version"), "utf8"), "2");
  // A pending build whose install was cut off before anything moved: undone, still staged.
  const p = world();
  const pending = path.join(p.apps, ".T3 Blackout.pending.app");
  fs.renameSync(p.staged, pending);
  p.write({ ...p.install, staged: pending });
  assert.deepEqual(p.recover(), { op: "install", committed: false, staged: pending, records: p.install.records });
  assert.equal(fs.existsSync(pending), true);
});

test("the CLI refuses a crafted rollback journal naming another project, and leaves it alone (HOST3-05)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-app-cli-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const state = path.join(repo, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const victim = path.join(dir, "unrelated-project");
  const other = path.join(dir, "unrelated-backup");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "different.txt"), "other");
  fs.writeFileSync(
    path.join(state, "activation.json"),
    JSON.stringify({ v: 1, op: "rollback", committed: true, slots: { installed: path.join(dir, "unrelated-installed"), previous: victim, outgoing: other }, records: { current: { ref: "fake" }, previous: { ref: "fake-previous" }, clearPending: false } }),
  );
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_HOME: path.join(home, ".t3blackout"), T3BLACKOUT_APPS: path.join(dir, "Apps"), T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "requests"), XDG_DATA_HOME: path.join(dir, "data"), T3BLACKOUT_HEADLESS: "1" };
  const result = spawnSync(process.execPath, [path.join(repo, "bin", "t3blackout"), "rollback"], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /activation\.json is damaged \(its app folders aren't this install's\)/);
  assert.deepEqual(fs.readdirSync(victim), ["important.txt"]);
  assert.deepEqual(fs.readdirSync(other), ["different.txt"]);
  assert.equal(fs.existsSync(path.join(state, "current.json")), false, "no records rewritten");
  assert.equal(fs.existsSync(path.join(state, "activation.json")), true);
});
