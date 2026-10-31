// Swapping the installed app, and telling whether its desktop is running, for
// both platforms.
//
// Installing a build and rolling back are transactions over the app folders
// (`slots`: installed, previous, outgoing scratch, and the staged build) and the
// CLI's records of what's in them (state/current.json, previous.json,
// pending.json). Before anything moves, a journal names the moves and holds the
// records to write: the records are prepared, not yet written. One rename puts
// the new build in place, which commits the transaction; after it, the journal
// is marked committed and the records are written (atomically, by the CLI's
// `commit`), then the rollback copy is tidied. A failure or crash at any point
// leaves the journal, and recoverActivation(), run under the update lock before
// the next install or rollback, finishes a committed transaction or undoes one
// that wasn't, so the folders and the records always end up agreeing.

import * as fs from "node:fs";
import * as path from "node:path";

import { writeJsonAtomic } from "../atomic-file.mjs";

const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** A journal's fields, per op, exactly as installBuild and rollBackBuild write them. */
const FIELDS = { install: ["v", "op", "slots", "staged", "origin", "records", "committed"], rollback: ["v", "op", "slots", "records", "committed"] };
const SLOTS = ["installed", "previous", "outgoing", "legacy"];
const RECORDS = ["current", "previous", "clearPending", "build"];

/**
 * The open transaction's journal, or null when there's none. Throws unless it's
 * one this install wrote: version 1, a known op with exactly its fields and
 * their types, records the CLI can write, and every path this install's own:
 * the slots `slots` (all of them, as configured now), a staged build in one of
 * the `staging` folders, an origin that's the installed or legacy slot. So
 * recovery never moves or deletes anything else.
 */
function readJournal(journal, { slots, staging }) {
  if (!plain(slots) || !Array.isArray(staging)) throw new TypeError("recovery needs this install's slots and staging folders");
  let text;
  try {
    text = fs.readFileSync(journal, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const damaged = (why) => new Error(`${journal} is damaged (${why}); compare the app folders with state/current.json by hand, then remove it`);
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    throw damaged("not JSON");
  }
  if (!plain(entry) || entry.v !== 1) throw damaged(`not a version 1 journal`);
  const fields = FIELDS[entry.op];
  if (!fields) throw damaged(`unknown op ${JSON.stringify(entry.op)}`);
  const keys = Object.keys(entry);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) throw damaged(`its fields aren't a ${entry.op}'s`);
  if (typeof entry.committed !== "boolean") throw damaged("committed isn't true or false");
  const given = entry.slots;
  if (!plain(given) || Object.keys(given).some((key) => !SLOTS.includes(key)) || SLOTS.some((key) => (given[key] ?? null) !== (slots[key] ?? null))) {
    throw damaged("its app folders aren't this install's");
  }
  if (entry.op === "install") {
    if (!staging.includes(entry.staged)) throw damaged("its staged build isn't in this install's staging folders");
    if (!(entry.origin === null || entry.origin === slots.installed || (slots.legacy && entry.origin === slots.legacy))) throw damaged("its origin isn't this install's app");
  }
  const { records } = entry;
  if (
    !plain(records) ||
    Object.keys(records).some((key) => !RECORDS.includes(key)) ||
    !plain(records.current) ||
    !plain(records.previous) ||
    !["undefined", "boolean"].includes(typeof records.clearPending) ||
    !(records.build === undefined || plain(records.build))
  ) {
    throw damaged("its records aren't what an install or rollback writes");
  }
  return entry;
}

/** An error from after the new build went in: the caller mustn't treat the staged build as still there. */
const afterCommit = (error, what) => Object.assign(new Error(`${what} is in place, but finishing it failed (${error.message}); the next update or rollback finishes it`), { committed: true });

/** Earlier rollback copies a tidy couldn't delete (see tidy). */
function sweepDiscards(previous) {
  const dir = path.dirname(previous);
  const prefix = `${path.basename(previous)}.discard-`;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {}
  for (const name of names) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * The outgoing build becomes the rollback copy. The old copy is renamed aside
 * first and deleted last, best effort: two renames can't leave a half-deleted
 * copy where `previous` should be, and a copy that won't delete is swept up by
 * a later install or recovery.
 */
function tidy({ previous, outgoing }) {
  if (exists(outgoing)) {
    if (exists(previous)) fs.renameSync(previous, `${previous}.discard-${process.pid}-${Date.now()}`);
    fs.renameSync(outgoing, previous);
  }
  sweepDiscards(previous);
}

/** Marks `entry` committed, writes its records, tidies, and closes the journal. */
function finish(journal, entry, commit, what) {
  try {
    if (!entry.committed) writeJsonAtomic(journal, { ...entry, committed: true });
    commit(entry.records, entry.op);
    tidy(entry.slots);
    fs.rmSync(journal, { force: true });
  } catch (error) {
    throw afterCommit(error, what);
  }
}

/** Throws if an earlier transaction is still open: recoverActivation() first. */
function begin(journal, entry) {
  if (exists(journal)) throw new Error(`an earlier install or rollback didn't finish (${journal}); run t3blackout update to finish it`);
  fs.rmSync(entry.slots.outgoing, { recursive: true, force: true });
  writeJsonAtomic(journal, entry);
}

/**
 * Installs the build at `staged`: what's installed (or, when nothing is,
 * `slots.legacy`, an install from before a move) becomes the rollback copy, and
 * `commit(records)` writes the CLI's records once the new build is in place. If
 * the new build can't go in, everything goes back as it was and the error is
 * rethrown: `installed` is never left missing and `staged` is still there. An
 * error with `committed` set came after the new build went in.
 */
export function installBuild({ journal, slots, staged, records, commit }) {
  if (!exists(staged)) throw new Error(`the staged build ${staged} is missing`);
  sweepDiscards(slots.previous);
  const origin = exists(slots.installed) ? slots.installed : slots.legacy && exists(slots.legacy) ? slots.legacy : null;
  const entry = { v: 1, op: "install", slots, staged, origin, records, committed: false };
  begin(journal, entry);
  try {
    if (origin) fs.renameSync(origin, slots.outgoing);
    try {
      fs.renameSync(staged, slots.installed);
    } catch (error) {
      if (origin) fs.renameSync(slots.outgoing, origin);
      throw error;
    }
  } catch (error) {
    // Back as it was: nothing to recover. Otherwise the journal stays for recoverActivation().
    if ((!origin || exists(origin)) && exists(staged)) fs.rmSync(journal, { force: true });
    throw error;
  }
  finish(journal, entry, commit, "the new build");
}

/**
 * Swaps the rollback copy back in as `installed`, and `installed` out as the
 * rollback copy; `commit(records)` then writes the records. Undone if the swap
 * fails halfway; an error with `committed` set came after the swap.
 */
export function rollBackBuild({ journal, slots, records, commit }) {
  if (!exists(slots.previous)) throw new Error("no previous build to roll back to");
  if (!exists(slots.installed)) throw new Error(`nothing is installed at ${slots.installed} to roll back from`);
  const entry = { v: 1, op: "rollback", slots, records, committed: false };
  begin(journal, entry);
  try {
    fs.renameSync(slots.installed, slots.outgoing);
    try {
      fs.renameSync(slots.previous, slots.installed);
    } catch (error) {
      fs.renameSync(slots.outgoing, slots.installed);
      throw error;
    }
  } catch (error) {
    if (exists(slots.installed) && exists(slots.previous)) fs.rmSync(journal, { force: true });
    throw error;
  }
  finish(journal, entry, commit, "the previous build");
}

/**
 * Finishes or undoes a transaction a failure or crash left open. Committed (the
 * journal says so, or the folders show the new build went in): its records are
 * written and the rollback copy tidied. Not committed: the build that was
 * installed goes back in place. `slots` and `staging` are this install's
 * (readJournal): a journal naming anything else is refused. Returns { op,
 * committed, staged, records }, or null when there was nothing to recover;
 * throws if it can't, leaving the journal.
 */
export function recoverActivation({ journal, commit, slots, staging }) {
  const entry = readJournal(journal, { slots, staging });
  if (!entry) return null;
  // Committed without the journal saying so: the new build is in place, and the
  // build it replaced is still aside (nothing tidies before the journal says committed).
  const committed =
    entry.committed ||
    (entry.op === "install"
      ? !exists(entry.staged) && exists(slots.installed) && (entry.origin === null || exists(slots.outgoing))
      : exists(slots.installed) && !exists(slots.previous) && exists(slots.outgoing));
  // Finishing writes records naming the installed build: there must be one.
  if (committed && !exists(slots.installed)) {
    throw new Error(`${journal} says its build went in, but nothing is installed at ${slots.installed}; compare the app folders with state/current.json by hand, then remove it`);
  }
  if (committed) {
    finish(journal, entry, commit, entry.op === "install" ? "an interrupted install's new build" : "an interrupted rollback's build");
  } else {
    const home = entry.op === "install" ? entry.origin : slots.installed;
    if (home && !exists(home) && exists(slots.outgoing)) fs.renameSync(slots.outgoing, home);
    fs.rmSync(journal, { force: true });
  }
  return { op: entry.op, committed, staged: entry.staged ?? null, records: entry.records };
}

/** In a server's command line: the app's own server entry (an SSH host's server, or the desktop's backend). */
const SERVER_ENTRY = /[/\\]app\.asar[/\\]apps[/\\]server[/\\]dist[/\\]bin\.mjs(\s|$)/;

/**
 * Whether a process's command line is the desktop app running from
 * `executableDir`, as opposed to a headless server run from the same app
 * (ELECTRON_RUN_AS_NODE on the server entry). Only the desktop holds an update
 * back: a server keeps running the build it started from after the swap, and the
 * next SSH connection replaces it with the installed one
 * (lib/files/ssh-runner-blackout.sh).
 */
export const isDesktopCommand = (commandLine, executableDir) =>
  commandLine.startsWith(executableDir) && !SERVER_ENTRY.test(commandLine);
