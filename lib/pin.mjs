// pin.json: the upstream release each channel builds, chosen by the evaluator
// (bin/t3blackout evaluate, run by .github/workflows/evaluate.yml) and committed
// with the bot key. Every machine builds exactly this, so a desktop and the hosts
// it connects to over SSH converge on the same version (each installs on its own
// schedule). Self-update accepts a bot-signed commit only when it changes this
// file alone, passes validatePin, moves forward to a real upstream release and
// passes the evaluator's gates again on the machine itself (lib/selfupdate.mjs).
// `deviceToolLocks` (optional) keeps each reviewed device tool's dependency
// lockfile with its SHA-256; once there, a lock never changes or disappears.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { DEADLINES, UPSTREAM_URL, gitFailure, publicGit } from "./git.mjs";
import { compareVersions, parseVersion } from "./semver.mjs";
import { ROOT } from "./util.mjs";

export const PIN = path.join(ROOT, "pin.json");
export const PIN_FILE = "pin.json";

const CHANNELS = ["nightly", "preview", "stable"];
// Canonical release tags only: no leading zeros, a real date, so two spellings
// can't name the same release (v0.1.6 and v00.1.6) and dodge the same-tag check.
const NUM = "(0|[1-9]\\d*)";
const REF = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}(?:-(nightly|preview)\\.(\\d{4})(\\d{2})(\\d{2})\\.${NUM})?$`);
const SHA = /^[0-9a-f]{40}$/;
const TOOL_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

/** Whether `ref` is a canonical upstream release tag, on `channel` when one is given. */
export function isReleaseTag(ref, channel = null) {
  const match = REF.exec(String(ref ?? ""));
  if (!match) return false;
  const [, , , , kind, year, month, day] = match;
  if (kind) {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return false;
  }
  return !channel || (kind ?? "stable") === channel;
}

/** Whether `tool` is name@version with a SemVer version. */
const isToolPin = (tool) => {
  const at = String(tool).lastIndexOf("@");
  return at > 0 && TOOL_NAME.test(tool.slice(0, at)) && parseVersion(tool.slice(at + 1)) !== null && !tool.slice(at + 1).startsWith("v");
};

/** Throws unless `pin` is exactly the shape described above; returns it. */
export function validatePin(pin) {
  const fail = (why) => {
    throw new Error(`pin.json is invalid: ${why}`);
  };
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) fail("not an object");
  const keys = Object.keys(pin).filter((key) => key !== "deviceToolLocks").sort().join(",");
  if (keys !== "channels,deviceTools,version") fail(`unexpected keys ${keys}`);
  if (pin.version !== 1) fail("version must be 1");
  if (!pin.channels || typeof pin.channels !== "object" || Array.isArray(pin.channels)) fail("channels must be an object");
  for (const [channel, entry] of Object.entries(pin.channels)) {
    if (!CHANNELS.includes(channel)) fail(`unknown channel ${channel}`);
    if (Object.keys(entry ?? {}).sort().join(",") !== "evaluatedAt,leftOut,ref,sha") fail(`${channel}: unexpected keys`);
    if (!isReleaseTag(entry.ref)) fail(`${channel}: ref ${entry.ref} isn't a release tag`);
    const refChannel = entry.ref.includes("-nightly.") ? "nightly" : entry.ref.includes("-preview.") ? "preview" : "stable";
    if (refChannel !== channel) fail(`${channel}: ref ${entry.ref} is a ${refChannel} release`);
    if (!SHA.test(entry.sha)) fail(`${channel}: sha must be a full commit id`);
    if (Number.isNaN(Date.parse(entry.evaluatedAt))) fail(`${channel}: evaluatedAt must be a date`);
    if (!Array.isArray(entry.leftOut) || entry.leftOut.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) fail(`${channel}: leftOut must list feature names`);
  }
  if (!Array.isArray(pin.deviceTools) || pin.deviceTools.some((tool) => typeof tool !== "string" || !isToolPin(tool))) fail("deviceTools must list name@version");
  if (new Set(pin.deviceTools).size !== pin.deviceTools.length) fail("deviceTools lists a version twice");
  if ("deviceToolLocks" in pin) {
    const locks = pin.deviceToolLocks;
    if (!locks || typeof locks !== "object" || Array.isArray(locks)) fail("deviceToolLocks must be an object");
    for (const [tool, entry] of Object.entries(locks)) {
      if (!isToolPin(tool)) fail(`deviceToolLocks: ${tool} isn't name@version`);
      if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "lock,sha256") fail(`deviceToolLocks: ${tool} must have exactly sha256 and lock`);
      if (typeof entry.lock !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`deviceToolLocks: ${tool} needs a lock and its sha256`);
      if (createHash("sha256").update(entry.lock, "utf8").digest("hex") !== entry.sha256) fail(`deviceToolLocks: ${tool}'s lock doesn't match its sha256`);
    }
  }
  return pin;
}

/** The pin in this clone, validated, or null when there is none. */
export function readPin(file = PIN) {
  if (!fs.existsSync(file)) return null;
  return validatePin(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writePin(pin, file = PIN) {
  validatePin(pin);
  fs.writeFileSync(file, `${JSON.stringify(pin, null, 2)}\n`);
}

export const emptyPin = () => ({ version: 1, channels: {}, deviceTools: [] });

/**
 * Negative, zero or positive as release `a` is older than, the same as, or newer
 * than `b`: by version, then a prerelease's date and build; a stable release sorts
 * after its prereleases. Only canonical tags compare, so zero means the same tag.
 */
export function compareRefs(a, b) {
  for (const ref of [a, b]) if (!isReleaseTag(ref)) throw new Error(`${ref} isn't a release tag`);
  const key = (ref) => ref.replace(/-(?:nightly|preview)\./, "-").slice(1);
  return compareVersions(key(a), key(b));
}

/**
 * Why `next` isn't a forward move from `previous`, or null. Every channel already
 * pinned must stay pinned and move to the same or a newer release; a stolen
 * evaluator key must not be able to roll a channel back to a release with known
 * holes, or drop it. Reviewed device tools may only be added.
 */
export function backwardMove(previous, next) {
  if (!previous) return null;
  for (const [channel, entry] of Object.entries(previous.channels)) {
    const moved = next.channels[channel];
    if (!moved) return `drops the ${channel} pin`;
    const order = compareRefs(moved.ref, entry.ref);
    if (order < 0) return `moves ${channel} back from ${entry.ref} to ${moved.ref}`;
    if (order === 0 && moved.sha !== entry.sha) return `changes ${entry.ref}'s commit`;
  }
  const kept = new Set(next.deviceTools);
  const dropped = previous.deviceTools.filter((tool) => !kept.has(tool));
  if (dropped.length) return `removes reviewed device tools ${dropped.join(", ")}`;
  // A reviewed tool's frozen closure is part of what was reviewed: another lock
  // for the same version is a substitution, and dropping one loses the review.
  for (const [tool, entry] of Object.entries(previous.deviceToolLocks ?? {})) {
    const now = next.deviceToolLocks?.[tool];
    if (!now) return `removes ${tool}'s reviewed dependency lock`;
    if (now.sha256 !== entry.sha256) return `replaces ${tool}'s reviewed dependency lock`;
  }
  return null;
}

/**
 * The commit upstream's release tag `ref` names, from `git ls-remote` (an
 * annotated tag peeled to its commit), or null when upstream has no such tag.
 * Only the exact ref names count: ls-remote also matches refs that merely end in
 * the pattern (refs/heads/refs/tags/<ref>). Throws when upstream can't be listed.
 */
export function upstreamTagCommit(ref, url = UPSTREAM_URL) {
  if (!isReleaseTag(ref)) throw new Error(`${ref} isn't a release tag`);
  const name = `refs/tags/${ref}`;
  const listing = publicGit(["ls-remote", "--tags", "--", url, name, `${name}^{}`], { url, timeout: DEADLINES.list });
  if (listing.status !== 0) throw new Error(`couldn't list upstream tag ${ref}: ${gitFailure(listing, DEADLINES.list)}`);
  const refs = new Map(listing.stdout.split("\n").filter(Boolean).map((line) => line.split("\t").reverse()));
  const sha = refs.get(`${name}^{}`) ?? refs.get(name) ?? null;
  if (sha !== null && !SHA.test(sha)) throw new Error(`upstream listed ${ref} as ${sha}`);
  return sha;
}

/**
 * Why `next` pins something other than real upstream releases, or null: every
 * channel `previous` doesn't pin the same way must name the commit its tag points
 * at upstream. Throws when upstream can't be reached (try again later).
 */
export function unreleasedPin(previous, next, url = UPSTREAM_URL) {
  for (const [channel, entry] of Object.entries(next.channels)) {
    const before = previous?.channels?.[channel];
    if (before && before.ref === entry.ref && before.sha === entry.sha) continue;
    const sha = upstreamTagCommit(entry.ref, url);
    if (sha !== entry.sha) return `pins ${channel} to ${entry.ref} at ${entry.sha.slice(0, 10)}, but upstream's ${entry.ref} is ${sha ? sha.slice(0, 10) : "missing"}`;
  }
  return null;
}
