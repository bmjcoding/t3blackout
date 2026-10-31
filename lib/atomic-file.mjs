// Whole-file replacement for the CLI's records (state/*.json, state/install.json):
// a reader sees the old file or the new one, never a truncated one, and a crash
// mid-write leaves the old one in place. No imports from util.mjs, which reads
// the environment install-config.mjs sets up first.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Writes `content` to a temporary file beside `file`, flushes it, then renames it over `file`. */
export function writeFileAtomic(file, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  // Random: one a crash left behind never blocks the next write.
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  // The rename itself, so a power cut doesn't bring the old file back.
  try {
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {}
}

/** `value` as the CLI's JSON records are written (two-space indent), atomically. */
export const writeJsonAtomic = (file, value, options) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
