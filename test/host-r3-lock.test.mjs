// node --test test/: the update lock handed to the self-update rerun is the
// locked descriptor itself (lib/lock.mjs runHoldingLock, adoptLock): the rerun
// holds and releases it, it stays held when the run that started the rerun is
// killed, nothing the rerun starts keeps it, and only the lock file's own
// descriptor is ever adopted (HOST3-03).
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { HANDED_ENV, tryLock } from "../lib/lock.mjs";

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const LOCK_MODULE = new URL("../lib/lock.mjs", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, what, ms = 20_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) if (condition()) return;
  assert.fail(`timed out waiting for ${what}`);
}

const alive = (pid) => {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return stat !== "" && !stat.includes("Z");
};

/** Whether the lock at `file` is free right now (taking it and giving it back). */
async function free(file) {
  const release = await tryLock(file);
  await release?.();
  return Boolean(release);
}

/** A process that takes the lock at `file` and runs `child` (node -e, a module) under it, as the self-update rerun does. */
function parentRunning(file, child, { env = process.env, stdio = "ignore" } = {}) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    const { tryLock, runHoldingLock } = await import(${JSON.stringify(LOCK_MODULE)});
    const release = await tryLock(${JSON.stringify(file)});
    if (!release) process.exit(9);
    process.exit(await runHoldingLock(release, process.execPath, ${JSON.stringify(child)}));
  `], { env, stdio });
}

/** A rerun that adopts the lock, reports, starts a long-lived process of its own, and releases when asked. */
const ADOPTER = (file) => ["--input-type=module", "-e", `
  import * as fs from "node:fs";
  import { spawn } from "node:child_process";
  const { adoptLock, HANDED_ENV } = await import(${JSON.stringify(LOCK_MODULE)});
  const release = await adoptLock(${JSON.stringify(file)}, Number(process.env[HANDED_ENV]));
  const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(`${file}.adopted`)}, JSON.stringify({ pid: process.pid, adopted: Boolean(release), grandchild: grandchild.pid }));
  const poll = setInterval(async () => {
    if (!fs.existsSync(${JSON.stringify(`${file}.release`)})) return;
    clearInterval(poll);
    await release?.();
    fs.writeFileSync(${JSON.stringify(`${file}.released`)}, "");
    setInterval(() => {}, 1000);
  }, 20);
`];

const lockFile = () => path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-lock-"))), "update.lock");

test("the rerun holds the handed lock after its parent is killed, until it releases it, and nothing it started keeps it (HOST3-03)", async () => {
  const file = lockFile();
  const parent = parentRunning(file, ADOPTER(file));
  let rerun = null;
  try {
    await until(() => fs.existsSync(`${file}.adopted`), "the rerun");
    rerun = JSON.parse(fs.readFileSync(`${file}.adopted`, "utf8"));
    assert.equal(rerun.adopted, true);
    assert.equal(await free(file), false, "held while both live");
    const exited = once(parent, "exit");
    parent.kill("SIGKILL");
    await exited;
    assert.equal(alive(rerun.pid), true, "the rerun carries on");
    assert.equal(await free(file), false, "still held: no second update can start beside the rerun");
    fs.writeFileSync(`${file}.release`, "");
    await until(() => fs.existsSync(`${file}.released`), "the release");
    assert.equal(alive(rerun.pid), true);
    assert.equal(alive(rerun.grandchild), true, "the rerun's own process is still running");
    assert.equal(await free(file), true, "released by the rerun, and not kept by what it started");
  } finally {
    parent.kill("SIGKILL");
    for (const pid of [rerun?.pid, rerun?.grandchild]) {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});

test("only the lock file's own descriptor is adopted; a stale variable adopts nothing (HOST3-03)", async () => {
  const file = lockFile();
  const held = await tryLock(file);
  const other = path.join(path.dirname(file), "other");
  fs.writeFileSync(other, "");
  const otherFd = fs.openSync(other, "r+");
  const lockFd = fs.openSync(file, "r+");
  try {
    const adopt = (stdio3) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", `
        const { adoptLock, HANDED_ENV } = await import(${JSON.stringify(LOCK_MODULE)});
        console.log(Boolean(await adoptLock(${JSON.stringify(file)}, Number(process.env[HANDED_ENV]))));
      `], { encoding: "utf8", env: { ...process.env, [HANDED_ENV]: "3" }, stdio: ["ignore", "pipe", "inherit", ...(stdio3 === null ? [] : [stdio3])] }).stdout.trim();
    assert.equal(adopt(null), "false", "no descriptor handed");
    assert.equal(adopt(otherFd), "false", "another file's descriptor");
    // The lock file's, but not the holder's: Linux checks the lock itself;
    // macOS can't, and takes the lock file's descriptor for the parent's (lib/lock.mjs).
    if (process.platform !== "darwin") assert.equal(adopt(lockFd), "false", "an unlocked descriptor of the lock file");
    assert.equal(await free(file), false, "the holder still has it");
  } finally {
    fs.closeSync(otherFd);
    fs.closeSync(lockFd);
    await held();
  }
});

/** A scratch clone and its state folder, as test/host-r2-cli.test.mjs makes them. */
function cli() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-lock-cli-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const state = path.join(repo, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_HOME: path.join(home, ".t3blackout"), T3BLACKOUT_APPS: path.join(dir, "Apps"), T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "requests"), XDG_DATA_HOME: path.join(dir, "data"), XDG_CONFIG_HOME: path.join(dir, "config"), T3BLACKOUT_HEADLESS: "1" };
  return { dir, repo, state, env, bin: path.join(repo, "bin", "t3blackout"), lock: path.join(state, "update.lock") };
}

test("the CLI runs under a lock handed to it, and refuses one that isn't (HOST3-03)", async () => {
  const c = cli();
  // `drift` takes no lock; `rollback` does, and with nothing installed fails after taking it.
  const handed = parentRunning(c.lock, [c.bin, "rollback"], { env: c.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  handed.stdout.on("data", (chunk) => (output += chunk));
  const [code] = await once(handed, "exit");
  assert.equal(code, 1);
  assert.match(output, /no previous build to roll back to/, "it got past the lock");
  assert.doesNotMatch(output, /another t3blackout update is running/);
  assert.equal(await free(c.lock), true, "and released it");
  // The variable without the descriptor, while someone holds the lock: refused.
  const held = await tryLock(c.lock);
  try {
    const stale = spawnSync(process.execPath, [c.bin, "rollback"], { encoding: "utf8", env: { ...c.env, [HANDED_ENV]: "3" } });
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /another t3blackout update is running/);
  } finally {
    await held();
  }
});

test("killing the run that self-updated doesn't free the lock while the rerun CLI still works (HOST3-03)", async () => {
  const c = cli();
  // The rerun stops partway, holding the lock: `rollback` reads state/current.json, here a FIFO no one writes yet.
  const fifo = path.join(c.state, "current.json");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const parent = parentRunning(c.lock, [c.bin, "rollback"], { env: c.env });
  const pidFile = path.join(c.state, "update.lock.pid");
  let rerun = null;
  try {
    await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")) !== parent.pid && Number(fs.readFileSync(pidFile, "utf8")) > 0, "the rerun to take the lock");
    rerun = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(await free(c.lock), false);
    const exited = once(parent, "exit");
    parent.kill("SIGKILL");
    await exited;
    assert.equal(alive(rerun), true, "the rerun CLI is still working");
    const competing = spawnSync(process.execPath, [c.bin, "rollback"], { encoding: "utf8", env: c.env, timeout: 30_000 });
    assert.equal(competing.status, 1);
    assert.match(competing.stdout, new RegExp(`another t3blackout update is running \\(pid ${rerun}\\)`));
    // Let it finish: it refuses the FIFO as a record, and releases the lock as it exits.
    fs.writeFileSync(fifo, "{}");
    await until(() => !alive(rerun), "the rerun to finish");
    assert.equal(await free(c.lock), true);
    assert.equal(fs.existsSync(pidFile), false, "its pid file went with it");
  } finally {
    parent.kill("SIGKILL");
    try {
      if (rerun) process.kill(rerun, "SIGKILL");
    } catch {}
  }
});
