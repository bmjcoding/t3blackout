// The evaluator's gates beyond the strip rules (bin/t3blackout evaluate): new
// dependency versions must have been public for a while, and a new device tool
// version must be old enough, carry npm provenance when its predecessor did, and
// reach no network host or analytics library its predecessor didn't.
//
// Hijacked npm packages are usually caught and pulled within days, so holding
// back only what's new keeps builds close to upstream without taking that risk.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { request } from "./http.mjs";
import { inTree, parseLockfile, splitPackage } from "./lockfile.mjs";
import { compareVersions, parseVersion } from "./semver.mjs";
import { hostsIn } from "./strip-engine.mjs";

/** A minimum age in days: a finite, non-negative number, or this throws (an unreadable setting must not turn a gate off). */
export function ageSetting(value, what = "minimum age") {
  const days = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
  // Finite after conversion too: 400 digits of "9" is a numeric string, and Infinity.
  if (!Number.isFinite(days) || days < 0) throw new Error(`${what} must be a non-negative number of days, not ${typeof value === "number" ? value : JSON.stringify(value)}`);
  return days;
}

export const MIN_AGE_DAYS = ageSetting(process.env.T3BLACKOUT_MIN_AGE_DAYS ?? 3, "T3BLACKOUT_MIN_AGE_DAYS");

const REGISTRY = "https://registry.npmjs.org";
const NPM_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9_][\w.~-]*$/i;
const metaCache = new Map();

/** A package's npm metadata (the full packument, which has publish times), or null when npm has no such package. */
export function npmMeta(name) {
  if (!NPM_NAME.test(name)) throw new Error(`${name} isn't an npm package name`);
  if (!metaCache.has(name)) {
    metaCache.set(
      name,
      request(`${REGISTRY}/${name.replace("/", "%2f")}`, { headers: { accept: "application/json" }, notFound: "null", label: `npm registry (${name})` }).then((meta) => {
        if (meta !== null && (typeof meta !== "object" || Array.isArray(meta) || typeof (meta.versions ?? {}) !== "object")) throw new Error(`npm registry sent unreadable metadata for ${name}`);
        return meta;
      }),
    );
  }
  return metaCache.get(name);
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * A registry publish time in ms, or null when it's missing or not a real ISO
 * timestamp (counted as unknown, never as old). Date.parse would roll
 * 2026-02-30 over to March 2, so every field must survive the round trip.
 */
export function publishedTime(value) {
  const match = typeof value === "string" ? ISO_TIME.exec(value) : null;
  if (!match) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const fields = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  return fields.every((field, i) => field === Number(match[i + 1])) ? time : null;
}

const ageDays = (time, now) => (now - time) / 86_400_000;

/** Versions that live in upstream's own tree (workspace packages, vendored tarballs), not on a registry. */
const LOCAL = /^(?:link|file|workspace):/;
const INTEGRITY = /^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+={0,2}$/;

const KNOWN_RESOLUTIONS = new URL("./known-resolutions.txt", import.meta.url);

/** lib/known-resolutions.txt: lockfile packages the owner allows from outside the registry, as Map key -> integrity. */
export function knownResolutions(text = fs.existsSync(KNOWN_RESOLUTIONS) ? fs.readFileSync(KNOWN_RESOLUTIONS, "utf8") : "") {
  const known = new Map();
  for (const line of text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)) {
    const [key, integrity, extra] = line.split(/\s+/);
    if (extra !== undefined || !INTEGRITY.test(integrity ?? "")) throw new Error(`lib/known-resolutions.txt: "${line}" isn't "<lockfile package> <integrity>"`);
    known.set(key, integrity);
  }
  return known;
}

/**
 * Where a lockfile package comes from: "registry" (an exact npm version whose
 * resolution is only its integrity, so pnpm fetches it from the registry and the
 * registry's own tarball must match), "local" (upstream's own tree, which the
 * pinned commit fixes), or "known" (lib/known-resolutions.txt lists it with this
 * integrity). Anything else, a tarball URL, git or a changed form, throws: the
 * gates couldn't vouch for its contents.
 */
export function resolutionKind(key, resolution, known = knownResolutions()) {
  const { version } = splitPackage(key);
  const fields = resolution && typeof resolution === "object" && !Array.isArray(resolution) ? Object.keys(resolution).sort().join(",") : "";
  if (LOCAL.test(version)) {
    // pnpm writes file: paths from the lockfile's directory, and links only for
    // importers (lib/lockfile.mjs); a link here is held to the same rule. The
    // build checks each is in the pinned commit (lib/resolution.mjs checkLinksInTree).
    const where = version.replace(LOCAL, "");
    const local = typeof resolution?.directory === "string" ? resolution.directory : /^file:/.test(resolution?.tarball ?? "") ? resolution.tarball.slice(5) : null;
    const plain = fields.split(",").every((field) => ["directory", "integrity", "tarball", "type"].includes(field)) && (resolution.type ?? "directory") === "directory";
    if (plain && local === where && where !== "." && inTree(where)) return "local";
    throw new Error(`pnpm-lock.yaml: ${key} isn't resolved inside upstream's tree (${JSON.stringify(resolution)})`);
  }
  if (known.has(key) && known.get(key) === resolution?.integrity) return "known";
  if (fields !== "integrity" || !INTEGRITY.test(resolution.integrity)) {
    const from = resolution?.tarball ?? resolution?.repo ?? JSON.stringify(resolution);
    throw new Error(`pnpm-lock.yaml: ${key} is resolved from ${from}, not the npm registry; list it in lib/known-resolutions.txt if it's meant to be`);
  }
  if (!parseVersion(version) || version.startsWith("v")) throw new Error(`pnpm-lock.yaml: ${key} isn't a registry version the gates can check`);
  return "registry";
}

/**
 * A pnpm-lock.yaml's registry packages as Map name@version -> integrity: what a
 * package is includes where it comes from and its exact bytes, so the same
 * version resolved anew is a substitution, not "nothing new". Every document is
 * read (pnpm puts its own toolchain in a first one), structurally
 * (lib/lockfile.mjs); upstream's own packages and owner-listed ones are left out
 * (resolutionKind). Anything else, or no registry packages at all, throws.
 */
export function lockIdentities(text, known = knownResolutions()) {
  const lock = typeof text === "string" ? parseLockfile(text) : text;
  const out = new Map();
  for (const key of lock.packages) {
    if (resolutionKind(key, lock.resolutions.get(key), known) === "registry") out.set(key, lock.resolutions.get(key).integrity);
  }
  if (!out.size) throw new Error("pnpm-lock.yaml lists no registry packages");
  return out;
}

/** `name@version` for every registry package in a pnpm-lock.yaml (lockIdentities). */
export const lockPackages = (text) => new Set(lockIdentities(text).keys());

/** The integrity npm's registry states for a version (sha1 from its shasum when it states nothing stronger), or null. */
export function registryIntegrity(dist) {
  if (typeof dist?.integrity === "string" && INTEGRITY.test(dist.integrity)) return dist.integrity;
  return typeof dist?.shasum === "string" && /^[0-9a-f]{40}$/.test(dist.shasum) ? `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}` : null;
}

/**
 * Versions in both `base` and `next` (Maps name@version -> integrity) whose
 * integrity changed: [{ pkg, why }].
 */
export function substitutions(base, next) {
  return [...next]
    .filter(([pkg, integrity]) => base.has(pkg) && base.get(pkg) !== integrity)
    .map(([pkg, integrity]) => ({ pkg, why: `resolved to ${integrity}, not ${base.get(pkg)} as before` }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** A lockfile's text, or name@version entries, as Map name@version -> integrity (null: not stated). */
function inventory(lock) {
  if (typeof lock === "string") return lockIdentities(lock);
  const out = new Map([...lock].map((pkg) => [pkg, null]));
  for (const pkg of out.keys()) {
    const at = typeof pkg === "string" ? pkg.lastIndexOf("@") : -1;
    if (at <= 0 || !NPM_NAME.test(pkg.slice(0, at)) || !parseVersion(pkg.slice(at + 1))) throw new Error(`${pkg} isn't name@version`);
  }
  return out;
}

/** Runs `worker` over `items`, `limit` at a time; its results, in order. */
export async function pool(items, limit, worker) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Package versions in `newLock` that `baseLock` doesn't have and that were published
 * less than `minDays` ago: { ok, added, young: [{ pkg, publishedAt }], waived:
 * [{ pkg, publishedAt, reason }], unknown, substituted: [{ pkg, why }] }. Each side
 * is a pnpm-lock.yaml's text or name@version entries. A version without a readable
 * publish time is unknown, which fails the gate too. Where lockfiles state
 * integrity, a version both have must keep its integrity and a new one must have
 * the registry's (else substituted, which fails). `waive(pkg)` (lib/fastlane.mjs)
 * may let a young version through with a reason: a security fix.
 */
export async function dependencyAgeGate(baseLock, newLock, { minDays = MIN_AGE_DAYS, now = Date.now(), waive = null } = {}) {
  ageSetting(minDays);
  if (!Number.isFinite(now)) throw new Error("dependencyAgeGate needs a time to measure ages from");
  const base = inventory(baseLock);
  const next = inventory(newLock);
  const added = [...next.keys()].filter((pkg) => !base.has(pkg)).sort();
  const substituted = substitutions(
    new Map([...base].filter(([, integrity]) => integrity !== null)),
    new Map([...next].filter(([, integrity]) => integrity !== null)),
  );
  const young = [];
  const waived = [];
  const unknown = [];
  await pool(added, 8, async (pkg) => {
    const at = pkg.lastIndexOf("@");
    const meta = await npmMeta(pkg.slice(0, at));
    const info = meta?.versions?.[pkg.slice(at + 1)];
    const publishedAt = meta?.time?.[pkg.slice(at + 1)];
    const time = info ? publishedTime(publishedAt) : null;
    const locked = next.get(pkg);
    if (info && locked !== null && registryIntegrity(info.dist) !== locked) {
      substituted.push({ pkg, why: `locked as ${locked}, but the registry's tarball is ${registryIntegrity(info.dist) ?? "unstated"}` });
    }
    if (time === null) unknown.push(pkg);
    else if (ageDays(time, now) < minDays) {
      const reason = waive ? await waive(pkg) : null;
      if (reason) waived.push({ pkg, publishedAt, reason });
      else young.push({ pkg, publishedAt });
    }
  });
  for (const list of [young, waived, substituted]) list.sort((a, b) => a.pkg.localeCompare(b.pkg));
  unknown.sort();
  return { ok: young.length === 0 && unknown.length === 0 && substituted.length === 0, added: added.length, young, waived, unknown, substituted };
}

/** One line per version a dependencyAgeGate result holds back: young, unknown and substituted. */
export const heldDependencies = (gate) => [
  ...gate.young.map(({ pkg, publishedAt }) => `${pkg} (published ${publishedAt}, under the minimum age)`),
  ...gate.unknown.map((pkg) => `${pkg} (no publish time on npm)`),
  ...(gate.substituted ?? []).map(({ pkg, why }) => `${pkg} (${why})`),
];

const ANALYTICS = ["posthog", "sentry", "segment.io", "segment.com", "amplitude", "mixpanel", "datadog", "bugsnag", "rollbar", "statsig", "launchdarkly"];

/** Hosts written as URLs (their real authority, lib/strip-engine.mjs hostsIn), and analytics names, in a package's shipped code. */
export function scanPackage(dir) {
  const hosts = new Set();
  const analytics = new Set();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(m?js|cjs|json|node)$/.test(entry.name) && !/\.map$/.test(entry.name)) {
        const text = fs.readFileSync(full, "latin1");
        for (const { host } of hostsIn(text)) hosts.add(host);
        const lower = text.toLowerCase();
        for (const name of ANALYTICS) if (lower.includes(name)) analytics.add(name);
      }
    }
  };
  walk(dir);
  return { hosts, analytics };
}

/** Downloads `name@version` from npm, checks it against the registry's integrity hash and unpacks it under `into`: { dir, meta, publishedAt }. */
export async function fetchPackage(name, version, into) {
  const meta = await npmMeta(name);
  const dist = meta?.versions?.[version]?.dist;
  if (!dist?.tarball) throw new Error(`npm has no ${name}@${version}`);
  if (!/^https:\/\//.test(dist.tarball)) throw new Error(`${name}@${version}'s tarball isn't served over https`);
  const bytes = await request(dist.tarball, { as: "bytes", label: `${name}@${version} tarball` });
  const [algorithm, expected] = String(dist.integrity ?? "").split("-");
  if (!["sha512", "sha384", "sha256"].includes(algorithm) || createHash(algorithm).update(bytes).digest("base64") !== expected) {
    throw new Error(`${name}@${version} doesn't match the registry's integrity hash`);
  }
  fs.mkdirSync(into, { recursive: true });
  const tarball = path.join(into, "package.tgz");
  fs.writeFileSync(tarball, bytes);
  const result = spawnSync("tar", ["-xzf", tarball, "-C", into], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`couldn't unpack ${name}@${version}: ${result.stderr.trim()}`);
  return { dir: path.join(into, "package"), meta: meta.versions[version], publishedAt: meta.time?.[version] };
}

/**
 * Reviews `pin` (name@version) against `previous` (the last reviewed version of the
 * same tool): { ok, pin, reasons, notes }. `isKnownHost` says whether a host is
 * already accounted for (lib/known-hosts.txt, reserved names).
 */
export async function reviewDeviceTool(pin, previous, { isKnownHost, minDays = MIN_AGE_DAYS, now = Date.now() }) {
  ageSetting(minDays);
  if (typeof isKnownHost !== "function") throw new Error("reviewDeviceTool needs isKnownHost");
  const at = pin.lastIndexOf("@");
  const name = pin.slice(0, at);
  const version = pin.slice(at + 1);
  const reasons = [];
  const notes = [];
  if (!previous) return { ok: false, pin, reasons: [`${name} has no reviewed version to compare against; review it by hand (lib/known-device-tools.txt)`], notes };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-tool-"));
  try {
    const next = await fetchPackage(name, version, path.join(work, "next"));
    const prev = await fetchPackage(name, previous.slice(previous.lastIndexOf("@") + 1), path.join(work, "prev"));
    const published = publishedTime(next.publishedAt);
    if (published === null || !(ageDays(published, now) >= minDays)) {
      reasons.push(`published ${next.publishedAt ?? "at an unknown time"}, under ${minDays} days ago`);
    }
    if (prev.meta?.dist?.attestations && !next.meta?.dist?.attestations) {
      reasons.push(`no npm provenance, though ${previous} had it`);
    }
    const before = scanPackage(prev.dir);
    const after = scanPackage(next.dir);
    const newHosts = [...after.hosts].filter((host) => !before.hosts.has(host) && !isKnownHost(host)).sort();
    const newAnalytics = [...after.analytics].filter((tag) => !before.analytics.has(tag)).sort();
    if (newHosts.length) reasons.push(`new network hosts: ${newHosts.join(", ")}`);
    if (newAnalytics.length) reasons.push(`new analytics names: ${newAnalytics.join(", ")}`);
    notes.push(`compared with ${previous}; ${after.hosts.size} hosts, provenance ${next.meta?.dist?.attestations ? "yes" : "no"}`);
    return { ok: reasons.length === 0, pin, reasons, notes };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The newest reviewed version of each tool in `reviewed` (name@version entries), by npm's publish order (then version). */
export async function latestReviewed(name, reviewed) {
  const versions = [...reviewed].filter((pin) => pin.slice(0, pin.lastIndexOf("@")) === name).map((pin) => pin.slice(pin.lastIndexOf("@") + 1));
  if (!versions.length) return null;
  const meta = await npmMeta(name);
  const time = (version) => publishedTime(meta?.time?.[version]) ?? -Infinity;
  return `${name}@${versions.sort((a, b) => time(b) - time(a) || compareVersions(b, a))[0]}`;
}

/**
 * Reviews each device tool version `nextTools` approves that neither `previousTools`
 * nor lib/known-device-tools.txt (`knownDeviceTools`) did, against the newest
 * version approved before: its own code (reviewDeviceTool) and its npm dependency
 * closure (lib/device-tools.mjs reviewToolClosure; `closure` replaces it, for
 * tests). Returns [{ tool, ok, reasons, lock }]. The evaluator's commit job and
 * every machine's self-update run it on a bot-signed pin, so the evaluator's key
 * alone can't approve a tool.
 *
 * `locks` / `previousLocks`: the pins' deviceToolLocks ({ "name@version":
 * { sha256, lock } }). Given `locks`, the closures reviewed are exactly those
 * kept bytes (nothing is resolved): an added tool without one fails, and a lock
 * new to this pin for a tool reviewed before has its closure reviewed too.
 * Without `locks` (the evaluate job proposing a pin) each closure is resolved
 * and the result's `lock` is the one to keep.
 */
export async function reviewAddedDeviceTools(previousTools, nextTools, { knownDeviceTools = [], isKnownHost, minDays = MIN_AGE_DAYS, now = Date.now(), closure, review = reviewDeviceTool, latest = latestReviewed, locks, previousLocks = {} }) {
  // Loaded here, not at the top: lib/device-tools.mjs builds on this module.
  const reviewClosure = closure ?? (await import("./device-tools.mjs")).reviewToolClosure;
  const reviewed = new Set([...knownDeviceTools, ...previousTools]);
  const added = [...new Set(nextTools)].filter((t) => !reviewed.has(t));
  const sameLock = (a, b) => a?.sha256 === b?.sha256 && a?.lock === b?.lock;
  const relocked = locks ? Object.keys(locks).filter((t) => !added.includes(t) && !sameLock(locks[t], previousLocks[t])) : [];
  const results = [];
  for (const tool of [...added, ...relocked].sort()) {
    const name = tool.slice(0, tool.lastIndexOf("@"));
    const previous = await latest(name, [...reviewed].filter((t) => t !== tool));
    const own = added.includes(tool) ? await review(tool, previous, { isKnownHost, minDays, now }) : { ok: true, reasons: [] };
    let deps = { ok: true, reasons: [], lock: null };
    if (own.ok && locks && !locks[tool]) deps = { ok: false, reasons: [`pin.json keeps no reviewed dependency lockfile for ${tool}`], lock: null };
    else if (own.ok) {
      // The baseline is only a lock kept before this pin: one added alongside proves nothing.
      const kept = locks ? { lock: locks[tool], previousLock: (previous && previousLocks[previous]) || null } : { previousLock: (previous && previousLocks[previous]) || null };
      deps = await reviewClosure(tool, previous, { isKnownHost, minDays, now, ...kept });
    }
    results.push({ tool, ok: own.ok && deps.ok, reasons: [...own.reasons, ...deps.reasons], lock: deps.lock ?? null });
  }
  return results;
}
