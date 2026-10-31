// node --test test/: installing and rolling back are transactions over the app
// folders and their records (lib/platform/app.mjs): whatever fails, or wherever
// the process dies, recovery leaves the folders and the records agreeing.
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeJsonAtomic } from "../lib/atomic-file.mjs";
import { installBuild, recoverActivation, rollBackBuild } from "../lib/platform/app.mjs";

/** Installed v2 (records v2/v1), rollback copy v1, and v3 staged. */
function world() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-app-")));
  const apps = path.join(dir, "Applications");
  const state = path.join(dir, "state");
  fs.mkdirSync(apps);
  fs.mkdirSync(state);
  const slots = {
    installed: path.join(apps, "T3 Blackout.app"),
    previous: path.join(apps, ".T3 Blackout.previous.app"),
    outgoing: path.join(apps, ".T3 Blackout.outgoing.app"),
    legacy: null,
  };
  const staged = path.join(apps, ".T3 Blackout.new.app");
  const make = (where, v) => {
    fs.mkdirSync(where);
    fs.writeFileSync(path.join(where, "version"), v);
  };
  make(slots.installed, "2");
  make(slots.previous, "1");
  make(staged, "3");
  const current = path.join(state, "current.json");
  const previous = path.join(state, "previous.json");
  writeJsonAtomic(current, { v: "2" });
  writeJsonAtomic(previous, { v: "1" });
  const journal = path.join(state, "activation.json");
  const commit = (records) => {
    writeJsonAtomic(previous, records.previous);
    writeJsonAtomic(current, records.current);
  };
  const version = (where) => (fs.existsSync(where) ? fs.readFileSync(path.join(where, "version"), "utf8") : null);
  const record = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).v : null);
  const install = () => installBuild({ journal, slots, staged, records: { current: { v: "3" }, previous: { v: "2" } }, commit });
  const rollback = () => rollBackBuild({ journal, slots, records: { current: { v: "1" }, previous: { v: "2" } }, commit });
  const recover = () => recoverActivation({ journal, commit, slots, staging: [staged] });
  const view = () => ({
    installed: version(slots.installed),
    previous: version(slots.previous),
    staged: version(staged),
    current: record(current),
    previousRecord: record(previous),
    journal: fs.existsSync(journal),
    apps: fs.readdirSync(apps).sort(),
  });
  return { slots, staged, journal, install, rollback, recover, view, current, previous };
}

/** The folders and records agree, and nothing half-done is left. */
function assertConsistent(view, label) {
  assert.equal(view.journal, false, `${label}: journal closed`);
  assert.equal(view.installed, view.current, `${label}: the installed build is the one recorded`);
  assert.equal(view.previous, view.previousRecord, `${label}: the rollback copy is the one recorded`);
  assert.equal(view.apps.some((name) => /outgoing|discard/.test(name)), false, `${label}: no scratch left (${view.apps})`);
}

const MUTATIONS = ["renameSync", "rmSync", "openSync", "writeFileSync", "mkdirSync", "rmdirSync", "unlinkSync"];

/** Runs `fn` with the process "dying" at the `at`-th filesystem change: that call and every later one fail. */
function dyingAt(at, fn) {
  const real = Object.fromEntries(MUTATIONS.map((name) => [name, fsDefault[name]]));
  let calls = 0;
  for (const name of MUTATIONS) {
    fsDefault[name] = (...args) => {
      calls++;
      if (at && calls >= at) throw Object.assign(new Error(`died at change ${at}`), { code: "EDIED" });
      return real[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    fn();
  } catch (error) {
    if (!at) throw error;
  } finally {
    Object.assign(fsDefault, real);
    syncBuiltinESMExports();
  }
  return calls;
}

test("an install interrupted at any step is finished or undone by recovery (HOST2-08)", () => {
  const total = dyingAt(0, () => world().install());
  assert.ok(total > 5, `counted ${total} changes`);
  for (let at = 1; at <= total; at++) {
    const w = world();
    dyingAt(at, w.install);
    w.recover();
    const view = w.view();
    assertConsistent(view, `install dying at change ${at}`);
    // Either it went in (and v2 is the rollback copy) or it didn't (and v3 is still staged).
    if (view.installed === "3") assert.deepEqual([view.previous, view.staged], ["2", null], `at ${at}`);
    else assert.deepEqual([view.installed, view.previous, view.staged], ["2", "1", "3"], `at ${at}`);
  }
});

test("a rollback interrupted at any step is finished or undone by recovery (HOST2-09)", () => {
  const total = dyingAt(0, () => world().rollback());
  for (let at = 1; at <= total; at++) {
    const w = world();
    dyingAt(at, w.rollback);
    w.recover();
    const view = w.view();
    assertConsistent(view, `rollback dying at change ${at}`);
    assert.ok(
      (view.installed === "1" && view.previous === "2") || (view.installed === "2" && view.previous === "1"),
      `rollback dying at change ${at}: ${JSON.stringify(view)}`,
    );
  }
});

test("records that fail after the new build went in: committed, never restaged, finished later (HOST2-08)", () => {
  const w = world();
  let failing = true;
  const flaky = (records) => {
    if (failing) throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
    writeJsonAtomic(w.current, records.current);
    writeJsonAtomic(w.previous, records.previous);
  };
  assert.throws(
    () => installBuild({ journal: w.journal, slots: w.slots, staged: w.staged, records: { current: { v: "3" }, previous: { v: "2" } }, commit: flaky }),
    (error) => error.committed === true && /new build is in place/.test(error.message),
  );
  let view = w.view();
  assert.equal(view.installed, "3");
  assert.equal(view.staged, null, "the staged build was consumed: nothing to restage");
  assert.equal(view.journal, true, "kept for recovery");
  assert.equal(view.current, "2", "records not written yet");
  // A rollback now must not run on the stale records: recovery comes first.
  assert.throws(() => w.rollback(), /didn't finish/);
  failing = false;
  assert.deepEqual(recoverActivation({ journal: w.journal, commit: flaky, slots: w.slots, staging: [w.staged] }).committed, true);
  view = w.view();
  assertConsistent(view, "after recovery");
  assert.equal(view.installed, "3");
});

test("a rollback whose last move fails is finished by recovery, not left without a rollback copy (HOST2-09)", () => {
  const w = world();
  const realRename = fsDefault.renameSync;
  fsDefault.renameSync = (from, to) => {
    if (from === w.slots.outgoing && to === w.slots.previous) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => w.rollback(), (error) => error.committed === true);
  } finally {
    fsDefault.renameSync = realRename;
    syncBuiltinESMExports();
  }
  let view = w.view();
  assert.equal(view.installed, "1");
  assert.equal(view.previous, null);
  assert.equal(view.journal, true);
  w.recover();
  view = w.view();
  assertConsistent(view, "after recovery");
  assert.deepEqual([view.installed, view.previous], ["1", "2"]);
});

test("a damaged journal stops recovery instead of guessing", () => {
  const w = world();
  fs.writeFileSync(w.journal, "{\"op\":");
  assert.throws(() => w.recover(), /activation\.json is damaged/);
  assert.equal(fs.existsSync(w.journal), true);
});
