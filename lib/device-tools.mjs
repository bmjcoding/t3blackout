// Device tools (apps/server/src/device/deviceToolVersions.json) are npm packages
// the app installs itself, outside the lockfile, when device support is on.
// Each tool's own code is reviewed (lib/gates.mjs reviewDeviceTool); this is its
// dependency closure, which a plain `npm install name@version` would resolve
// fresh, from whatever was published that day:
//
//   - The closure is proposed once, as npm resolves it as of the tool's own
//     publish time (--before), and kept: pin.json's deviceToolLocks holds the
//     exact package-lock.json reviewed for each tool version, with its SHA-256.
//     Resolving again later isn't the same closure (dist-tags and registry
//     metadata change), so nothing re-resolves it after review.
//   - Every check on it is re-derived from npm wherever it's used (the commit
//     job, each Mac's self-update and build), on those exact bytes: each
//     package is the registry's own tarball with the registry's integrity hash,
//     at least MIN_AGE_DAYS old, and sits in the folder npm's own resolution
//     from the tool down would put it in (verifyToolLock), and each package the
//     previous reviewed version's lock didn't have is scanned like the tool
//     (reviewToolClosure).
//   - The build bakes each checked lock into the app (rule
//     server/device-tools-frozen), which installs it with `npm ci
//     --ignore-scripts`; native files a package's install script would have
//     fetched come from lib/native-assets.json, hash-checked. Which packages
//     have one is read from the packages themselves (installScriptPackages),
//     not from the lock.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MIN_AGE_DAYS, fetchPackage, npmMeta, pool, publishedTime, scanPackage } from "./gates.mjs";
import { MODULE_PATH, PACKAGE_NAME, lockInstallScripts, nativeAssetsFor } from "./native-assets.mjs";
import { parseRange, satisfies } from "./semver.mjs";

const REGISTRY = "https://registry.npmjs.org/";

/**
 * The npm release the app falls back to (through `pnpm dlx`) when a machine has
 * no npm of its own: one exact, older release instead of whatever npm@11 is newest.
 */
export const NPM_FALLBACK = "npm@11.21.1";

export const splitPin = (pin) => {
  const at = pin.lastIndexOf("@");
  return { name: pin.slice(0, at), version: pin.slice(at + 1) };
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The package.json each closure of `pin` is resolved and installed with. */
export function toolManifest(pin) {
  const { name, version } = splitPin(pin);
  return `${JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", private: true, dependencies: { [name]: version } }, null, 2)}\n`;
}

/** How pin.json's deviceToolLocks keeps a package-lock.json: { sha256, lock }. */
export const lockEntry = (lock) => ({ sha256: sha256(lock), lock });

/** `pin`'s reviewed package-lock.json text from `pinJson` (pin.json), its SHA-256 checked. Throws when there's none. */
export function approvedToolLock(pin, pinJson) {
  const entry = pinJson?.deviceToolLocks?.[pin];
  if (!entry) {
    throw new Error(
      `pin.json has no reviewed dependency lockfile for device tool ${pin} (deviceToolLocks). ` +
        "The evaluator proposes one when it clears the tool; for a version you reviewed by hand, run `t3blackout device-tool-lock` and commit pin.json, signed.",
    );
  }
  if (typeof entry.lock !== "string" || sha256(entry.lock) !== entry.sha256) throw new Error(`pin.json's lockfile for ${pin} doesn't match its sha256`);
  return entry.lock;
}

/** When npm published `pin` (an ISO time): its closure's cutoff. Throws when npm doesn't say. */
export async function toolPublishedAt(pin) {
  const { name, version } = splitPin(pin);
  const at = (await npmMeta(name))?.time?.[version];
  if (publishedTime(at) === null) throw new Error(`npm has no publish time for ${pin}`);
  return at;
}

/**
 * The package.json and package-lock.json for `pin` alone, as npm resolves it as
 * of `before`: lockfile only, scripts off, nothing installed. Returns { manifest, lock }.
 */
export function resolveToolClosure(pin, { before, npm = "npm", registry = REGISTRY } = {}) {
  // The real path: npm keys the lockfile by paths relative to it (/var vs /private/var on macOS).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-tool-closure-")));
  try {
    const manifest = toolManifest(pin);
    fs.writeFileSync(path.join(dir, "package.json"), manifest);
    const args = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${before}`, `--registry=${registry}`];
    const result = spawnSync(npm, args, { cwd: dir, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_update_notifier: "false" } });
    if (result.status !== 0) {
      const why = (result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim().split("\n").slice(-3).join(" ");
      throw new Error(`npm couldn't resolve ${pin}'s dependencies as of ${before}: ${why}`);
    }
    return { manifest, lock: fs.readFileSync(path.join(dir, "package-lock.json"), "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Each package in a package-lock.json, as { key, name, version, integrity,
 * resolved }. Throws on anything `npm ci` couldn't check: a folder that isn't a
 * plain one inside node_modules (SUPPLY3-03), a link, a package without a
 * version or integrity hash, or a tarball other than the registry's own.
 */
function closureEntries(lockText, registry = REGISTRY) {
  const lock = JSON.parse(lockText);
  if (![2, 3].includes(lock.lockfileVersion)) throw new Error(`unexpected package-lock.json version ${lock.lockfileVersion}`);
  const entries = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue;
    if (!MODULE_PATH.test(key)) throw new Error(`${key} in the device tool's closure is outside its node_modules, or isn't a plain package folder there`);
    const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    const tarball = `${registry}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${entry.version}.tgz`;
    if (!PACKAGE_NAME.test(name) || entry.link || !entry.version || !/^sha(256|384|512)-/.test(entry.integrity ?? "") || entry.resolved !== tarball) {
      throw new Error(`${key} in the device tool's closure isn't a registry package with an integrity hash`);
    }
    entries.push({ key, name, version: entry.version, integrity: entry.integrity, resolved: entry.resolved });
  }
  return entries;
}

/** The folder that installs the package `key` holds (node_modules/a/node_modules/b -> node_modules/a), "" for the root. */
const parentOf = (key) => {
  const at = key.lastIndexOf("/node_modules/");
  return at === -1 ? "" : key.slice(0, at);
};

/**
 * Why `entries` (closureEntries) don't install as npm resolves `pin` from its
 * registry manifests (`manifests`: key -> npm's metadata for that version):
 * starting from the tool at node_modules/<name>, each package's dependencies,
 * optional and peer ones too, are found as Node finds them (its own
 * node_modules, then each one above), and each folder found must hold the
 * package asked for (an `npm:` alias names its real one) at a version in range.
 * Every package in the lock must be reached so, or it's a decoy: a lock could
 * otherwise list the tool somewhere npm never installs it and put another
 * package in its place (SUPPLY3-01). Returns problems.
 */
function bindingProblems(pin, entries, manifests) {
  const { name, version } = splitPin(pin);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const problems = [];
  const find = (from, dep) => {
    for (let base = from; ; base = parentOf(base)) {
      const found = byKey.get(base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`);
      if (found || !base) return found ?? null;
    }
  };
  const tool = byKey.get(`node_modules/${name}`);
  if (!tool || tool.name !== name || tool.version !== version) return [`it doesn't contain ${pin} as the package npm installs for it`];
  const reached = new Set([tool.key]);
  const queue = [tool];
  while (queue.length) {
    const at = queue.shift();
    const info = manifests.get(at.key) ?? {};
    const optional = new Set([...Object.keys(info.optionalDependencies ?? {}), ...Object.entries(info.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([dep]) => dep)]);
    const wanted = { ...(info.peerDependencies ?? {}), ...(info.dependencies ?? {}), ...(info.optionalDependencies ?? {}) };
    for (const [dep, spec] of Object.entries(wanted)) {
      const found = find(at.key, dep);
      if (!found) {
        if (!optional.has(dep)) problems.push(`${at.name}@${at.version} needs ${dep}@${spec}, which isn't where npm looks from ${at.key}`);
        continue;
      }
      const alias = /^npm:((?:@[^@/]+\/)?[^@/]+)@(.*)$/.exec(String(spec));
      const [wantName, range] = alias ? [alias[1], alias[2]] : [dep, String(spec)];
      let inRange = true;
      try {
        parseRange(range || "*");
        inRange = satisfies(found.version, range || "*");
      } catch {
        // Not a version range (a dist-tag): the name alone binds it.
      }
      if (found.name !== wantName || !inRange) problems.push(`${found.key} holds ${found.name}@${found.version}, but ${at.name}@${at.version} asks for ${dep}@${spec}`);
      else if (!reached.has(found.key)) {
        reached.add(found.key);
        queue.push(found);
      }
    }
  }
  for (const e of entries) if (!reached.has(e.key)) problems.push(`${e.key} (${e.name}@${e.version}) is nothing npm installs from ${pin}`);
  return problems;
}

/** The closure in a package-lock.json, as Map name@version -> integrity (closureEntries' checks apply). */
export function closurePackages(lockText, registry = REGISTRY) {
  return new Map(closureEntries(lockText, registry).map(({ name, version, integrity }) => [`${name}@${version}`, integrity]));
}

/**
 * Checks `entry` ({ sha256, lock }, from pin.json's deviceToolLocks or just
 * proposed) as `pin`'s closure, without resolving anything: the SHA-256 matches;
 * its root is exactly toolManifest(pin); every package is a registry tarball
 * whose URL and integrity are the ones npm publishes for that version now, and
 * at least `minDays` old by npm's publish times; and each sits where npm puts
 * what the tool and its dependencies ask for, nothing else in it
 * (bindingProblems). Returns { pin, packages (name@version, sorted) }; throws
 * otherwise. `meta` is npm's metadata (lib/gates.mjs npmMeta), for tests.
 */
export async function verifyToolLock(pin, entry, { minDays = MIN_AGE_DAYS, now = Date.now(), meta = npmMeta } = {}) {
  if (!entry || typeof entry.lock !== "string" || sha256(entry.lock) !== entry.sha256) throw new Error(`${pin}'s dependency lockfile doesn't match its sha256`);
  const root = JSON.parse(entry.lock).packages?.[""];
  const { name, version } = splitPin(pin);
  const expected = { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [name]: version } };
  if (JSON.stringify(root) !== JSON.stringify(expected)) throw new Error(`${pin}'s dependency lockfile isn't for ${pin} alone (its root is ${JSON.stringify(root)})`);
  const entries = closureEntries(entry.lock);
  const packages = entries.map((e) => `${e.name}@${e.version}`);
  if (!packages.includes(pin)) throw new Error(`${pin}'s dependency lockfile doesn't contain ${pin}`);
  const problems = [];
  const manifests = new Map();
  for (const e of entries) {
    const info = await meta(e.name);
    const dist = info?.versions?.[e.version]?.dist;
    const time = dist ? publishedTime(info?.time?.[e.version]) : null;
    if (!dist) problems.push(`${e.name}@${e.version} (not on npm)`);
    else if (dist.integrity !== e.integrity || dist.tarball !== e.resolved) problems.push(`${e.name}@${e.version} (its tarball or integrity isn't npm's)`);
    else if (time === null) problems.push(`${e.name}@${e.version} (no publish time on npm)`);
    else if ((now - time) / 86_400_000 < minDays) problems.push(`${e.name}@${e.version} (published ${info.time[e.version]}, under ${minDays} days ago)`);
    if (dist) manifests.set(e.key, info.versions[e.version]);
  }
  if (problems.length) throw new Error(`${pin}'s dependency lockfile fails its checks: ${problems.join(", ")}`);
  const unbound = bindingProblems(pin, entries, manifests);
  if (unbound.length) throw new Error(`${pin}'s dependency lockfile doesn't install as npm resolves ${pin}: ${unbound.join("; ")}`);
  return { pin, packages: [...new Set(packages)].sort() };
}

/**
 * `pin`'s closure proposed for review: resolved as of the tool's publish time,
 * then checked as verifyToolLock does. Returns { pin, before, entry, packages }.
 * `resolve`, `publishedAt` and `verify` are the network steps, for tests.
 */
export async function checkToolClosure(pin, { minDays = MIN_AGE_DAYS, now = Date.now(), resolve = resolveToolClosure, publishedAt = toolPublishedAt, verify = verifyToolLock } = {}) {
  const before = await publishedAt(pin);
  const entry = lockEntry(resolve(pin, { before }).lock);
  const { packages } = await verify(pin, entry, { minDays, now });
  return { pin, before, entry, packages };
}

/** A proposed { sha256, lock } for `pin`, for pin.json's deviceToolLocks (checkToolClosure's checks pass). */
export const proposeToolLock = async (pin, opts) => (await checkToolClosure(pin, opts)).entry;

/**
 * Reviews `pin`'s closure against `previous`'s (the last reviewed version of the
 * same tool, or null). `lock` ({ sha256, lock }): the closure to review, as kept
 * in pin.json; without it one is proposed (checkToolClosure). It must pass
 * verifyToolLock, and each package in it that `previousLock` (previous's kept
 * lock; none means nothing is taken as reviewed) didn't have, the tool itself
 * aside (reviewDeviceTool covers it), must reach no network host or analytics
 * name that the same package's version there didn't. Returns { ok, pin,
 * reasons, notes, lock }, `lock` being the reviewed { sha256, lock }.
 */
export async function reviewToolClosure(pin, previous, { isKnownHost, lock = null, previousLock = null, minDays = MIN_AGE_DAYS, now = Date.now(), check = checkToolClosure, verify = verifyToolLock, fetch = fetchPackage, scan = scanPackage } = {}) {
  if (typeof isKnownHost !== "function") throw new Error("reviewToolClosure needs isKnownHost");
  let next;
  let before = [];
  try {
    next = lock ? { entry: lock, ...(await verify(pin, lock, { minDays, now })) } : await check(pin, { minDays, now });
    if (previous && previousLock) before = (await verify(previous, previousLock, { minDays: 0, now })).packages;
  } catch (error) {
    // npm or the registry unavailable, or a closure that doesn't pass: held, never cleared.
    return { ok: false, pin, reasons: [error.message], notes: [], lock: null };
  }
  const had = new Set(before);
  const added = next.packages.filter((pkg) => pkg !== pin && !had.has(pkg));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-tool-closure-"));
  const reasons = [];
  try {
    const scanOf = async (pkg, into) => {
      const { name, version } = splitPin(pkg);
      return scan((await fetch(name, version, path.join(work, into))).dir);
    };
    for (const [i, pkg] of added.entries()) {
      const { name } = splitPin(pkg);
      const old = before.find((other) => splitPin(other).name === name);
      const was = old ? await scanOf(old, `old-${i}`) : { hosts: new Set(), analytics: new Set() };
      const found = await scanOf(pkg, `new-${i}`);
      const hosts = [...found.hosts].filter((host) => !was.hosts.has(host) && !isKnownHost(host)).sort();
      const analytics = [...found.analytics].filter((tag) => !was.analytics.has(tag)).sort();
      if (hosts.length) reasons.push(`dependency ${pkg}: new network hosts: ${hosts.join(", ")}`);
      if (analytics.length) reasons.push(`dependency ${pkg}: new analytics names: ${analytics.join(", ")}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const since = previous && previousLock ? previous : "nothing reviewed";
  const notes = [`closure ${next.entry.sha256.slice(0, 12)}: ${next.packages.length} packages, ${added.length} new since ${since}, all at least ${minDays} days old`];
  return { ok: reasons.length === 0, pin, reasons, notes, lock: next.entry };
}

/**
 * Each package in the closure `lockText` whose install script npm would run, as
 * [{ path, package }]: read from the package itself (its registry tarball,
 * checked against the integrity hash: lib/gates.mjs fetchPackage), never from
 * the lock's hasInstallScript flags, which a proposed lock could leave out
 * (SUPPLY3-07). A preinstall, install or postinstall script counts, and so does
 * a binding.gyp npm would build with node-gyp. `fetch` is for tests.
 */
export async function installScriptPackages(lockText, { fetch = fetchPackage } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-tool-scripts-"));
  try {
    const entries = closureEntries(lockText);
    const scripted = await pool([...entries.keys()], 6, async (i) => {
      const e = entries[i];
      const into = path.join(work, String(i));
      let { dir } = await fetch(e.name, e.version, into);
      // npm takes a tarball's one top folder as the package, whatever it's called.
      if (!fs.existsSync(path.join(dir, "package.json"))) {
        const tops = fs.readdirSync(into, { withFileTypes: true }).filter((d) => d.isDirectory());
        if (tops.length !== 1) throw new Error(`${e.name}@${e.version}'s tarball has no package.json`);
        dir = path.join(into, tops[0].name);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const scripts = manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
      const gyp = !scripts.install && !scripts.preinstall && manifest.gypfile !== false && fs.existsSync(path.join(dir, "binding.gyp"));
      return gyp || ["preinstall", "install", "postinstall"].some((script) => scripts[script]);
    });
    return entries.filter((_, i) => scripted[i]).map((e) => ({ path: e.key, package: `${e.name}@${e.version}` }));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * For a build: each pinned tool's reviewed closure from `pinJson` (pin.json),
 * checked again here (verifyToolLock), with the native files it needs from
 * `nativeAssets` (lib/native-assets.json), as the map the app is built with:
 * { "name@version": { manifest, lock, digest, needs, assets } }. `digest` names
 * the exact closure and files, for the app's completion markers. Throws if any
 * lock is missing or fails, or needs a native file that isn't listed. What
 * needs one is what installScriptPackages finds, and anything the lock's own
 * flags add. `fetch` is for tests.
 */
export async function deviceToolLocks(pins, { pinJson, nativeAssets, fetch = fetchPackage, ...opts }) {
  const locks = {};
  for (const pin of pins) {
    const lock = approvedToolLock(pin, pinJson);
    await verifyToolLock(pin, pinJson.deviceToolLocks[pin], opts);
    const scripted = new Map([...lockInstallScripts(lock), ...(await installScriptPackages(lock, { fetch }))].map((found) => [found.path, found]));
    const { needs, assets } = nativeAssetsFor([...scripted.values()], nativeAssets, pin);
    const digest = sha256(JSON.stringify({ lock: sha256(lock), assets: assets.map((asset) => [asset.path, asset.platform, asset.arch, asset.sha256, asset.files]) }));
    locks[pin] = { manifest: toolManifest(pin), lock, digest, needs, assets };
  }
  return locks;
}
