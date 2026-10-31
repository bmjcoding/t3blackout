// node --test test/: one update at a time (lib/lock.mjs).
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { tryLock } from "../lib/lock.mjs";

const LOCK_MODULE = new URL("../lib/lock.mjs", import.meta.url).href;
const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-lock-")), "update.lock");

/** Another process that takes the lock and holds it; resolves once it reports. */
async function holder(file) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { tryLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const release = await tryLock(${JSON.stringify(file)});
    console.log(release ? "held" : "busy");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(child.stdout, "data");
  return { child, state: String(line).trim() };
}

test("only one holder at a time; release frees it", async () => {
  const file = lockFile();
  const release = await tryLock(file);
  assert.equal(typeof release, "function");
  assert.equal(await tryLock(file), null);
  await release();
  await release();
  const again = await tryLock(file);
  assert.equal(typeof again, "function");
  await again();
});

test("a killed holder never leaves the lock behind", async () => {
  const file = lockFile();
  const { child, state } = await holder(file);
  assert.equal(state, "held");
  assert.equal(await tryLock(file), null);
  child.kill("SIGKILL");
  await once(child, "exit");
  let release = null;
  for (let i = 0; i < 40 && !release; i++) {
    release = await tryLock(file);
    if (!release) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(typeof release, "function");
  await release();
});

test("racing for the lock, exactly one process wins", async () => {
  const file = lockFile();
  const racers = await Promise.all(Array.from({ length: 6 }, () => holder(file)));
  try {
    assert.equal(racers.filter((r) => r.state === "held").length, 1);
  } finally {
    for (const { child } of racers) child.kill("SIGKILL");
  }
});

test("releasing can't take another holder's lock", async () => {
  const file = lockFile();
  const mine = await tryLock(file);
  await mine();
  const { child, state } = await holder(file);
  try {
    assert.equal(state, "held");
    await mine(); // a stale release is a no-op
    assert.equal(await tryLock(file), null);
  } finally {
    child.kill("SIGKILL");
  }
});
