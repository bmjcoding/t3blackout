// One update at a time on a machine: the hourly job, the app's update button and
// a manual run can each start one. The lock is an OS file lock (flock(2)) on a
// descriptor this process opened and keeps open, so it lasts exactly as long as
// the holder: when it exits, crashes or is killed, the kernel closes the
// descriptor and the lock goes with it. So a lock is never stale, nothing is
// deleted to recover one, releasing can only ever give up the holder's own lock,
// and no helper process holds it that could die (or fail to start) and drop it
// while the holder carries on.
//
// The lock file is the owner's alone (0600, no symlink): BSD and Linux both let
// a read-only descriptor take an exclusive flock, so a file anyone could open
// would let any account hold updates back.
//
// A holder can hand its lock to a child that carries on under it (the
// self-update rerun, bin/t3blackout): the child gets the locked descriptor
// itself (runHoldingLock) and adopts it (adoptLock). The lock belongs to the
// open file they then share, and the parent closes its copy once the child has
// started, so the lock is the child's alone: it holds however the parent ends,
// and goes when the child releases it or exits.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";

/** flock(1)'s exit status for "someone else holds it" (-E), EX_TEMPFAIL. */
const BUSY = 75;
/** macOS's open(2) flag for an flock-style exclusive lock taken on open (<fcntl.h>). */
const O_EXLOCK = 0x20;
/** util-linux flock(1), by absolute path: never whatever PATH finds. */
const FLOCK = ["/usr/bin/flock", "/bin/flock"];
/** The descriptor a handed lock arrives on in the child, and the variable that says so. */
export const HANDED_FD = 3;
export const HANDED_ENV = "T3BLACKOUT_LOCK_FD";

/** Opens `file` for the lock: created owner-only, never through a symlink, refused if it's another account's. */
function openLockFile(file, extraFlags) {
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | extraFlags, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${file} isn't a regular file`);
    if (stat.uid !== process.getuid()) throw new Error(`${file} belongs to uid ${stat.uid}, not you; remove it and try again`);
    if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** macOS: open(2) takes the lock itself (O_EXLOCK | O_NONBLOCK). Returns the fd, or null when it's held. */
function lockDarwin(file) {
  try {
    return openLockFile(file, O_EXLOCK | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") return null;
    throw error;
  }
}

/**
 * Linux: flock(1) with `options` on this process's descriptor `fd`, handed to
 * it as its fd 3; the lock belongs to the open file both share, so it stays
 * with this process's copy. Resolves true, or false when someone else holds it.
 */
function flockLinux(fd, options) {
  const flock = FLOCK.find((candidate) => fs.existsSync(candidate));
  if (!flock) throw new Error(`couldn't take the update lock: flock (util-linux) isn't installed at ${FLOCK.join(" or ")}`);
  const result = spawnSync(flock, [...options, "-E", String(BUSY), "3"], { stdio: ["ignore", "ignore", "pipe", fd], env: {} });
  if (result.status === 0) return true;
  if (result.status === BUSY) return false;
  throw new Error(`couldn't take the update lock: ${flock} exited with ${result.status ?? result.signal ?? result.error?.message}`);
}

/** Linux: locks a descriptor of its own on `file`. Returns the fd, or null when it's held. */
function lockLinux(file) {
  const fd = openLockFile(file, 0);
  try {
    if (flockLinux(fd, ["-n"])) return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  fs.closeSync(fd);
  return null;
}

/**
 * The release() for the lock on `fd`. `unlock`: release unlocks the open file
 * before closing, for a descriptor others may share (adoptLock, Linux).
 * release.fd and release.handOff() are for runHoldingLock.
 */
function holding(fd, { unlock = false } = {}) {
  let open = true;
  const release = async () => {
    if (!open) return;
    open = false;
    try {
      if (unlock) flockLinux(fd, ["-u"]);
    } finally {
      fs.closeSync(fd);
    }
  };
  release.fd = fd;
  // Closes only this process's copy: the child it was handed to keeps the lock.
  release.handOff = async () => {
    if (!open) return;
    open = false;
    fs.closeSync(fd);
  };
  return release;
}

/**
 * Takes the lock at `file` if it's free. Resolves to an async `release()`, which
 * resolves once the lock is given up (calling it again is harmless), or to null
 * when another process holds the lock.
 */
export async function tryLock(file) {
  const fd = process.platform === "darwin" ? lockDarwin(file) : lockLinux(file);
  return fd === null ? null : holding(fd);
}

/**
 * The lock a parent handed this process on descriptor `fd` (runHoldingLock), as
 * tryLock's release(); null when `fd` isn't open on the lock file at `file`, or
 * the lock is someone else's. The descriptor must be that very file (same
 * device and inode, a regular file, yours). Linux then locks it again, which
 * succeeds only if it holds the lock (or it was free). Node can't flock a
 * descriptor on macOS, so there the lock must be held, refusing a fresh take:
 * by the parent's open file, the only holder that hands it over. A fresh take
 * that succeeds means nobody held it, and that lock is used instead.
 */
export async function adoptLock(file, fd) {
  let held;
  let named;
  try {
    held = fs.fstatSync(fd);
    named = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino || held.uid !== process.getuid()) return null;
  // Linux: an inherited descriptor isn't close-on-exec, so what this process
  // starts shares it; release unlocks the open file, for all of them.
  if (process.platform !== "darwin") return flockLinux(fd, ["-n"]) ? holding(fd, { unlock: true }) : null;
  const fresh = lockDarwin(file);
  if (fresh !== null) {
    fs.closeSync(fd);
    return holding(fresh);
  }
  // macOS: opening /dev/fd/N duplicates descriptor N (one open file, one lock),
  // close-on-exec as Node opens everything, so nothing this process starts shares it.
  const own = fs.openSync(`/dev/fd/${fd}`, fs.constants.O_RDWR);
  const same = fs.fstatSync(own);
  fs.closeSync(fd);
  if (same.dev !== named.dev || same.ino !== named.ino) {
    fs.closeSync(own);
    return null;
  }
  return holding(own);
}

/**
 * Runs `command` under this lock (a release() from tryLock or adoptLock): the
 * child gets the locked descriptor as its fd 3 and HANDED_ENV in its
 * environment, for adoptLock. Once it has started, this process's copy is
 * closed, so the lock is the child's to release, and stays held if this
 * process dies first. If it can't start, the lock stays here. Resolves to its
 * exit code (1 when a signal ended it).
 */
export async function runHoldingLock(release, command, args, { env = process.env } = {}) {
  const child = spawn(command, args, { stdio: ["inherit", "inherit", "inherit", release.fd], env: { ...env, [HANDED_ENV]: String(HANDED_FD) } });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (child.pid !== undefined) await release.handOff();
  return exited;
}
