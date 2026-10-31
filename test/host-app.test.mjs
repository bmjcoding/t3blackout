// node --test test/: swapping the installed app, and what counts as it running (lib/platform/app.mjs).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { installBuild, isDesktopCommand, rollBackBuild } from "../lib/platform/app.mjs";

function apps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-app-"));
  const paths = {
    installed: path.join(dir, "T3 Blackout.app"),
    staged: path.join(dir, ".T3 Blackout.new.app"),
    previous: path.join(dir, ".T3 Blackout.previous.app"),
    outgoing: path.join(dir, ".T3 Blackout.outgoing.app"),
  };
  const make = (where, version) => {
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, "version"), version);
  };
  const version = (where) => (fs.existsSync(where) ? fs.readFileSync(path.join(where, "version"), "utf8") : null);
  const journal = path.join(dir, "activation.json");
  const committed = [];
  const tx = { journal, commit: (records) => committed.push(records) };
  const { staged, ...slots } = paths;
  const swapIn = (extra = {}) => installBuild({ ...tx, slots: { ...slots, ...extra }, staged, records: { n: committed.length } });
  const swapBack = () => rollBackBuild({ ...tx, slots, records: { back: true } });
  return { dir, paths, make, version, journal, committed, swapIn, swapBack };
}

test("activation installs the new build and keeps the old one for rollback", () => {
  const { paths, make, version, journal, committed, swapIn, swapBack } = apps();
  make(paths.previous, "1");
  make(paths.installed, "2");
  make(paths.staged, "3");
  swapIn();
  assert.equal(version(paths.installed), "3");
  assert.equal(version(paths.previous), "2");
  assert.equal(fs.existsSync(paths.staged), false);
  assert.equal(fs.existsSync(paths.outgoing), false);
  assert.equal(fs.existsSync(journal), false, "closed");
  swapBack();
  assert.equal(version(paths.installed), "2");
  assert.equal(version(paths.previous), "3");
  assert.deepEqual(committed, [{ n: 0 }, { back: true }]);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.installed)).sort(), [path.basename(paths.previous), path.basename(paths.installed)].sort());
});

test("a failed activation puts the installed build and the old rollback back", () => {
  const { paths, make, version, journal, committed, swapIn } = apps();
  make(paths.previous, "1");
  make(paths.installed, "2");
  // Nothing staged: refused before anything moves.
  assert.throws(() => swapIn(), /staged build .* is missing/);
  // Staged where it can't be moved from (its folder read-only): the move into
  // place fails after the installed app moved out.
  const locked = path.join(path.dirname(paths.installed), "locked");
  const staged = path.join(locked, "staged.app");
  make(staged, "3");
  fs.chmodSync(locked, 0o555);
  try {
    const { staged: _, ...slots } = paths;
    assert.throws(() => installBuild({ journal, commit: (records) => committed.push(records), slots, staged, records: {} }), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.equal(version(paths.installed), "2");
  assert.equal(version(paths.previous), "1");
  assert.equal(version(staged), "3", "still staged");
  assert.equal(fs.existsSync(paths.outgoing), false);
  assert.equal(fs.existsSync(journal), false);
  assert.deepEqual(committed, []);
});

test("a first activation, and one from the legacy location", () => {
  const { dir, paths, make, version, swapIn } = apps();
  make(paths.staged, "1");
  swapIn();
  assert.equal(version(paths.installed), "1");
  assert.equal(fs.existsSync(paths.previous), false);
  const legacy = path.join(dir, "home-Applications", "T3 Blackout.app");
  fs.rmSync(paths.installed, { recursive: true });
  make(legacy, "0");
  make(paths.staged, "2");
  swapIn({ legacy });
  assert.equal(version(paths.installed), "2");
  assert.equal(version(paths.previous), "0");
  assert.equal(fs.existsSync(legacy), false);
});

test("rollback without a previous build changes nothing", () => {
  const { paths, make, version, committed, swapBack } = apps();
  make(paths.installed, "2");
  assert.throws(() => swapBack(), /no previous build/);
  assert.equal(version(paths.installed), "2");
  assert.deepEqual(committed, []);
});

test("only the desktop holds an update back, not servers run from the app", () => {
  const exe = "/Applications/T3 Blackout.app/Contents/MacOS/";
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout", exe), true);
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout -psn_0_12345", exe), true);
  const server = "/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout /Applications/T3 Blackout.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";
  assert.equal(isDesktopCommand(`${server} serve --host 127.0.0.1 --port 3773 --base-dir /Users/agent-claude/.t3blackout`, exe), false);
  assert.equal(isDesktopCommand(`${server} auth pairing create --json`, exe), false);
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/Frameworks/T3 Blackout Helper.app/Contents/MacOS/T3 Blackout Helper", exe), false);
  assert.equal(isDesktopCommand("/opt/t3/app/t3code --type=renderer", "/opt/t3/app/"), true);
  assert.equal(isDesktopCommand("/opt/t3/app/t3code /opt/t3/app/resources/app.asar/apps/server/dist/bin.mjs serve", "/opt/t3/app/"), false);
});
