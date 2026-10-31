// node --test test/: the update lock holds itself (lib/lock.mjs): no helper
// process that could die or fail to start, no PATH lookups, and a lock file
// no other account can open.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { tryLock } from "../lib/lock.mjs";

const LOCK_MODULE = new URL("../lib/lock.mjs", import.meta.url).href;
const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-lock-")), "update.lock");

/** A process that takes the lock with `env` and holds it; resolves once it reports. */
async function holder(file, env = process.env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { tryLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const release = await tryLock(${JSON.stringify(file)});
    console.log(release ? "held" : "busy");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"], env });
  const [line] = await once(child.stdout, "data");
  return { child, state: String(line).trim() };
}

test("the lock is taken with no PATH at all, and holds (HOST2-03)", async () => {
  const file = lockFile();
  const { child, state } = await holder(file, { PATH: "" });
  try {
    assert.equal(state, "held");
    assert.equal(await tryLock(file), null, "a second taker is refused");
  } finally {
    child.kill("SIGKILL");
  }
});

test("no helper process holds it, so none can die and drop it (HOST2-03)", async () => {
  const file = lockFile();
  const { child, state } = await holder(file);
  try {
    assert.equal(state, "held");
    const children = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).stdout.trim();
    assert.equal(children, "", "the holder has no child processes");
    assert.equal(await tryLock(file), null);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the lock file is owner-only: made 0600, tightened if looser, never a symlink (HOST2-04)", async () => {
  const file = lockFile();
  const release = await tryLock(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await release();
  fs.chmodSync(file, 0o644);
  const again = await tryLock(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await again();
  const link = `${file}.link`;
  fs.symlinkSync(file, link);
  await assert.rejects(tryLock(link), /ELOOP|symbolic link/);
});
