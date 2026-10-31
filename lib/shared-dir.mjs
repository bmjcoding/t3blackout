// The folder a Mac's accounts share with its updater (/Users/Shared/t3blackout):
// update-requests/, where servers in agent accounts drop a request (mode 1733:
// any account may add one, only the owner may list or remove them), and the
// pricing table the updater publishes for those servers. Every other account is
// untrusted here.
//
// So every folder from / down to the shared folder must be one no other account
// can rename, replace or loosen: a real directory (no symlink) owned by root or
// this account, writable by no one else unless sticky (where no one can rename
// another's entries), with no ACL entry granting anyone writes. The shared
// folder itself is this account's. Then each operation runs inside the folder it
// checked, pinned by device and inode (inDir), never by looking its path up again.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OPEN_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const STICKY = 0o1000;
const uid = () => process.getuid();

/** An ACL permission that lets its holder add, rename or remove entries, or change ownership or permissions. */
const ACL_WRITE = /^(write|add_file|append|add_subdirectory|delete|delete_child|writesecurity|chown)$/;

/** `file`'s ACL entries that allow any write (macOS `ls -le`); none elsewhere, where host roles don't run. */
export function aclWriteGrants(file) {
  if (process.platform !== "darwin") return [];
  const listed = spawnSync("/bin/ls", ["-led", "--", file], { encoding: "utf8", env: {} });
  if (listed.status !== 0) throw new Error(`couldn't read the ACL of ${file}: ${(listed.stderr || listed.error?.message || "").trim()}`);
  return listed.stdout
    .split("\n")
    .map((line) => /^\s*\d+: (.+) allow (\S+)$/.exec(line))
    .filter((entry) => entry && entry[2].split(",").some((permission) => ACL_WRITE.test(permission)))
    .map((entry) => `${entry[1]} allow ${entry[2]}`);
}

const notAFolder = (dir) => new Error(`${dir} isn't a real folder (a symlink or a file); remove it and try again`);

function openDir(dir) {
  try {
    return fs.openSync(dir, OPEN_DIR);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "ENOTDIR") throw notAFolder(dir);
    throw error;
  }
}

/** Throws unless no account but root and this one can replace or add entries in `dir` (its `stat` given). */
function checkUnreplaceable(dir, stat) {
  if (!stat.isDirectory()) throw notAFolder(dir);
  if (stat.uid !== 0 && stat.uid !== uid()) throw new Error(`${dir} belongs to uid ${stat.uid}; the shared folder can't live under it`);
  if (stat.mode & 0o022 && !(stat.mode & STICKY)) throw new Error(`${dir} is writable by other accounts and not sticky; the shared folder can't live under it`);
  const grants = aclWriteGrants(dir);
  if (grants.length) throw new Error(`${dir} has ACL entries other accounts could write through (${grants.join("; ")}); the shared folder can't live under it`);
}

/**
 * Checks every folder from / down to `dir` (which exists) and returns its real
 * path. Each is looked at with lstat, below a folder already checked, so none of
 * them can be swapped by another account.
 */
function checkChain(dir) {
  const real = fs.realpathSync(dir);
  let at = path.parse(real).root;
  for (const part of ["", ...real.slice(at.length).split(path.sep).filter(Boolean)]) {
    at = path.join(at, part);
    checkUnreplaceable(at, fs.lstatSync(at));
  }
  return real;
}

/**
 * Runs `fn(stat)` with this process's working folder set to `dir`, after checking
 * it's the folder (same device and inode) a descriptor opened without following
 * symlinks found: names `fn` passes to fs are looked up in that folder, whatever
 * happens to the path to it meanwhile (Node has no openat(2) and friends). The
 * previous working folder comes back afterwards; nothing else runs in between.
 */
function inDir(dir, fn) {
  const fd = openDir(dir);
  let saved = "/";
  try {
    saved = process.cwd();
  } catch {}
  try {
    const stat = fs.fstatSync(fd);
    process.chdir(dir);
    const here = fs.statSync(".");
    if (here.dev !== stat.dev || here.ino !== stat.ino) throw new Error(`${dir} was replaced while it was being checked; try again`);
    return fn(stat);
  } finally {
    try {
      process.chdir(saved);
    } catch {
      process.chdir("/");
    }
    fs.closeSync(fd);
  }
}

/** This account's own folder, writable by no one else: its ACL entries are removed, as its mode says. */
function checkOwn(dir, stat) {
  if (!stat.isDirectory()) throw notAFolder(dir);
  if (stat.uid !== uid()) throw new Error(`${dir} belongs to uid ${stat.uid}, not you; remove it (sudo rm -rf '${dir}') and try again`);
  if (stat.mode & 0o022 && !(stat.mode & STICKY)) throw new Error(`${dir} is writable by other accounts; run: chmod go-w '${dir}'`);
}

function dropAcl(dir) {
  if (process.platform !== "darwin" || !aclWriteGrants(dir).length) return;
  const cleared = spawnSync("/bin/chmod", ["-N", dir], { encoding: "utf8", env: {} });
  if (cleared.status !== 0 || aclWriteGrants(dir).length) throw new Error(`couldn't remove the ACL entries on ${dir}; run: chmod -N '${dir}'`);
}

const mkdirIfMissing = (dir, mode) => {
  try {
    fs.mkdirSync(dir, { mode });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};

/** Creates (if needed) and checks the shared folder `root`; returns its real path. */
export function ensureSharedDir(root) {
  const parent = checkChain(path.dirname(root));
  const name = path.basename(root);
  inDir(parent, (stat) => {
    checkUnreplaceable(parent, stat);
    mkdirIfMissing(name, 0o755);
    const fd = openDir(name);
    try {
      checkOwn(path.join(parent, name), fs.fstatSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  });
  const real = path.join(parent, name);
  dropAcl(real);
  return real;
}

/**
 * Creates (if needed) and checks the request folder `dir`, inside the shared
 * folder, and sets it to 1733 through its descriptor. Throws if another account
 * made it or anything on the way. Returns its real path.
 */
export function ensureRequestDir(dir) {
  const root = ensureSharedDir(path.dirname(dir));
  const name = path.basename(dir);
  const real = path.join(root, name);
  inDir(root, (stat) => {
    checkOwn(root, stat);
    mkdirIfMissing(name, 0o700);
    const fd = openDir(name);
    try {
      const own = fs.fstatSync(fd);
      if (own.uid !== uid()) throw new Error(`${real} belongs to uid ${own.uid}, not you; remove it (sudo rm -rf '${real}') and try again`);
      fs.fchmodSync(fd, 0o1733);
    } finally {
      fs.closeSync(fd);
    }
  });
  dropAcl(real);
  return real;
}

/**
 * Removes every request in `dir`, one entry at a time, and never fails the
 * update over one: a symlink is unlinked (never followed), an empty directory
 * removed, anything else (a directory another account filled) left in place and
 * logged. Nothing is deleted recursively, and only inside the folder checked.
 * Returns how many requests there were.
 */
export function clearRequests(dir, { log = () => {} } = {}) {
  let count = 0;
  try {
    const root = checkChain(path.dirname(dir));
    const real = path.join(root, path.basename(dir));
    inDir(real, (stat) => {
      if (stat.uid !== uid()) throw new Error(`${real} belongs to uid ${stat.uid}, not you`);
      checkUnreplaceable(real, stat);
      for (const name of fs.readdirSync(".")) {
        count++;
        try {
          fs.unlinkSync(name);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          try {
            // A directory: unlink gives EPERM on macOS, EISDIR on Linux.
            if (error.code === "EPERM" || error.code === "EISDIR") {
              fs.rmdirSync(name);
              continue;
            }
          } catch (inner) {
            error = inner;
          }
          log(`left ${path.join(real, name)} in the update requests (${error.code ?? error.message})`);
        }
      }
    });
  } catch (error) {
    if (error.code !== "ENOENT") log(`not reading update requests: ${error.message}`);
  }
  return count;
}

/** Writes `content` to `name` in the shared folder (mode 644, replaced atomically). Returns its path. */
export function publishShared(root, name, content) {
  const real = ensureSharedDir(root);
  const temp = `.${name}.${process.pid}`;
  inDir(real, (stat) => {
    checkOwn(real, stat);
    fs.rmSync(temp, { force: true });
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, 0o644);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, name);
  });
  return path.join(real, name);
}
