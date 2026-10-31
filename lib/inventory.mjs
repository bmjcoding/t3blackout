// What a pinned release installs, for advisories: the dependency graph a build
// resolves with the security overrides (lib/overrides.json) and the device tool
// versions the release itself pins, not every version ever approved.
//
// Resolving runs pnpm and upstream's pnpmfile, so only the evaluate job does it;
// the jobs that publish the pin and file issues never run upstream code. They
// take its resolved lockfile as a proposal and check it against upstream's own
// lockfile at the pinned commit (git): the same importers, the same version and
// dependencies for every package no override touches, each override's fix in
// place of what it replaces, the same bytes for every version both have, and for
// what the overrides bring in, only versions their dependents ask for (npm). (Its
// age is held to the dependency gate by lib/resolution.mjs, as a build does.)
//
// That proposal only ever feeds alerts. What a security fix is measured against
// (the fast lane's advisories and usual publishers) is trustedInventory: upstream's
// lockfile and device tool pins at the pinned commit and the owner's overrides,
// nothing the evaluate job wrote, so an extra entry it slipped into its lockfile
// can't vouch for anything.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { approvedToolLock, closurePackages } from "./device-tools.mjs";
import { lockIdentities, npmMeta, substitutions } from "./gates.mjs";
import { parseLockfile, reachablePackages, registryPackages, splitPackage, withoutPeers } from "./lockfile.mjs";
import { overrideFor, readOverrides } from "./overrides.mjs";
import { parseVersion, satisfies } from "./semver.mjs";
import { parseYaml } from "./yaml.mjs";

/** Where upstream pins the device tool versions the app npm-installs. */
export const DEVICE_TOOL_PINS = "apps/server/src/device/deviceToolVersions.json";

/** `name@version` for each device tool a release pins (the file's text); throws when it isn't name -> version. */
export function deviceToolsInUse(text) {
  if (text == null) throw new Error(`upstream no longer pins device tools in ${DEVICE_TOOL_PINS}`);
  const tools = JSON.parse(text);
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) throw new Error(`${DEVICE_TOOL_PINS} isn't an object`);
  return Object.entries(tools).map(([name, version]) => {
    if (typeof version !== "string" || !/^\d/.test(version)) throw new Error(`${DEVICE_TOOL_PINS}: ${name} has no exact version`);
    return `${name}@${version}`;
  });
}

/** The override's fix for `pkg` (name@version) as name@version, or null when no override covers it. */
function fixFor(pkg, overrides) {
  const { name, version } = splitPackage(pkg);
  if (!parseVersion(version)) return null;
  const span = overrideFor(pkg, overrides);
  return span ? `${span.name}@${span.to}` : null;
}

/**
 * Each override fix that replaces something a build of upstream's lockfile still
 * reaches, as name@version: an overridden version reached only through another
 * overridden one goes with it (its replacement decides what it needs instead,
 * which addedPackageProblems checks against npm).
 */
function fixesIn(upstream, overrides) {
  const fixes = new Set();
  reachablePackages(upstream, (pkg) => {
    const fix = fixFor(pkg, overrides);
    if (fix) fixes.add(fix);
    return fix !== null;
  });
  return [...fixes].sort();
}

/**
 * What the pinned release with lockfile `upstreamLock` (git, at the pinned
 * commit) installs, from sources nothing but upstream and the owner wrote: its
 * registry packages a build keeps (the overridden ones' subtrees cut), the
 * override fixes that replace the rest (lib/overrides.json), and its device tools
 * (name@version, from the same commit). A build also installs the fixes' own
 * dependencies, which only a resolution knows, so this is a floor: the fast lane
 * built on it can only ever waive less.
 */
export function trustedInventory({ upstreamLock, deviceTools, overrides = readOverrides() }) {
  if (upstreamLock == null) throw new Error("upstream's pnpm-lock.yaml is missing at the pinned commit");
  const upstream = parseLockfile(upstreamLock);
  lockIdentities(upstream);
  const kept = registryPackages(reachablePackages(upstream, (pkg) => fixFor(pkg, overrides) !== null));
  return [...new Set([...kept, ...fixesIn(upstream, overrides), ...deviceTools])].sort();
}

/** For each package (name@version) with snapshots in `lock`, among `keys`: Set of "field name=name@version" edges, through `map`. */
function edgesByPackage(lock, keys, map) {
  const out = new Map();
  for (const key of keys) {
    const pkg = withoutPeers(key);
    if (!out.has(pkg)) out.set(pkg, new Set());
    for (const [dep, target] of lock.edges.get(key) ?? []) out.get(pkg).add(`${dep}=${map(target)}`);
  }
  return out;
}

/** Snapshot keys reachable from a lockfile's importers. */
function reachableKeys(lock) {
  const seen = new Set();
  const stack = [...lock.roots];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push(...(lock.deps.get(key) ?? []));
  }
  return seen;
}

const listed = (items) => `${items.slice(0, 10).join(", ")}${items.length > 10 ? `, and ${items.length - 10} more` : ""}`;

/**
 * Checks `resolvedLock` (what the evaluate job resolved for a release, overrides
 * applied) against `upstreamLock` (the release's own pnpm-lock.yaml, from git):
 * { packages: registry name@version a build installs, added: those upstream's
 * lockfile doesn't have (the overrides' fixes and what they bring in), problems:
 * why the resolved lockfile can't be that release's }. Every package an override
 * doesn't touch must keep its version, dependencies and bytes; every importer
 * must ask for the same packages; every override must have put its fix in; an
 * added package may only hang off a fix. addedPackageProblems checks the added
 * packages' own dependencies against npm.
 */
export function checkResolvedLock({ upstreamLock, resolvedLock, overrides = readOverrides() }) {
  const upstream = parseLockfile(upstreamLock);
  const resolved = parseLockfile(resolvedLock);
  const expected = (key) => fixFor(withoutPeers(key), overrides) ?? withoutPeers(key);
  const problems = [];
  try {
    const swapped = substitutions(lockIdentities(upstream), lockIdentities(resolved));
    if (swapped.length) problems.push(`resolves ${swapped.length} version(s) to other bytes than upstream's lockfile: ${listed(swapped.map(({ pkg, why }) => `${pkg} ${why}`))}`);
  } catch (error) {
    problems.push(error.message);
  }
  // The importers: the same projects, asking for the same packages, at upstream's versions or an override's fix.
  for (const where of new Set([...upstream.importers.keys(), ...resolved.importers.keys()])) {
    const [want, got] = [upstream.importers.get(where), resolved.importers.get(where)];
    if (!want || !got) {
      problems.push(`${want ? "lacks" : "adds"} importer ${where.replace(/^\d+\//, "")}`);
      continue;
    }
    const wrong = [...new Set([...want.keys(), ...got.keys()])].filter((dep) => {
      const [a, b] = [want.get(dep), got.get(dep)];
      if (a === undefined || b === undefined || (a === null) !== (b === null)) return true;
      return a !== null && withoutPeers(b) !== expected(a);
    });
    if (wrong.length) problems.push(`importer ${where.replace(/^\d+\//, "")} asks for other packages than upstream's: ${listed(wrong)}`);
  }
  // Every package no override touches: present, with upstream's dependencies (each overridden one at its fix).
  const keep = (pkg) => fixFor(pkg, overrides) === null;
  const resolvedKeys = [...reachableKeys(resolved)];
  const wanted = edgesByPackage(upstream, [...upstream.edges.keys()].filter((key) => keep(withoutPeers(key))), expected);
  const have = edgesByPackage(resolved, resolvedKeys, withoutPeers);
  const required = registryPackages(reachablePackages(upstream, (pkg) => !keep(pkg)));
  const reachable = new Set(registryPackages(reachablePackages(resolved)));
  const missing = required.filter((pkg) => !reachable.has(pkg));
  if (missing.length) problems.push(`lacks ${missing.length} package version(s) upstream's lockfile installs and no override replaces: ${listed(missing)}`);
  const rewired = [...wanted].filter(([pkg, edges]) => have.has(pkg) && (have.get(pkg).size !== edges.size || [...edges].some((edge) => !have.get(pkg).has(edge)))).map(([pkg]) => pkg);
  if (rewired.length) problems.push(`gives ${rewired.length} package(s) other dependencies than upstream's lockfile: ${listed(rewired.sort())}`);
  const fixes = fixesIn(upstream, overrides);
  const unfixed = fixes.filter((pkg) => !reachable.has(pkg));
  if (unfixed.length) problems.push(`lacks the security override fix(es) ${unfixed.join(", ")}`);
  const survived = [...resolved.packages].filter((pkg) => !keep(pkg));
  if (survived.length) problems.push(`still has overridden versions: ${survived.join(", ")}`);
  // The rest is new: an override's fix, or what one brings in (a package upstream
  // has can't point at it, or its dependencies would differ above).
  const added = [...reachable].filter((pkg) => !upstream.packages.has(pkg) || !keep(pkg)).sort();
  return { packages: [...reachable].sort(), added, problems };
}

/**
 * The added packages' own dependencies (checkResolvedLock `added`), against what
 * each one's package.json on npm asks for: every dependency it needs is there,
 * nothing it doesn't ask for is, and each version satisfies its range (or is an
 * override's fix). Returns problems; npm unreachable throws. A resolution may
 * still pick another version in range than pnpm would: only re-resolving knows.
 */
export async function addedPackageProblems({ resolvedLock, added, overrides = readOverrides() }, { meta = npmMeta } = {}) {
  const resolved = parseLockfile(resolvedLock);
  const fixes = new Set(overrides.map((o) => `${splitPackage(o.selector).name}@${o.version}`));
  const keys = [...reachableKeys(resolved)];
  const problems = [];
  for (const pkg of added) {
    const { name, version } = splitPackage(pkg);
    const info = (await meta(name))?.versions?.[version];
    if (!info) {
      problems.push(`${pkg} isn't on npm`);
      continue;
    }
    const optional = info.optionalDependencies ?? {};
    const declared = { ...(info.peerDependencies ?? {}), ...(info.dependencies ?? {}), ...optional };
    const bundled = new Set([...(info.bundleDependencies ?? []), ...(info.bundledDependencies ?? [])].filter((dep) => typeof dep === "string"));
    for (const key of keys.filter((k) => withoutPeers(k) === pkg)) {
      const edges = resolved.edges.get(key) ?? new Map();
      const deps = new Map([...edges].map(([field, target]) => [field.slice(field.indexOf(" ") + 1), withoutPeers(target)]));
      for (const dep of Object.keys(info.dependencies ?? {})) {
        if (!deps.has(dep) && !Object.hasOwn(optional, dep) && !bundled.has(dep)) problems.push(`${pkg} needs ${dep}, which the resolved lockfile doesn't give it`);
      }
      for (const [dep, target] of deps) {
        const range = Object.hasOwn(declared, dep) ? declared[dep] : null;
        if (typeof range !== "string") {
          problems.push(`${pkg} gets ${target}, which its package.json doesn't ask for`);
          continue;
        }
        const alias = /^npm:((?:@[^@/]+\/)?[^@/]+)@(.*)$/.exec(range);
        const [wantName, wantRange] = alias ? [alias[1], alias[2]] : [dep, range];
        const got = splitPackage(target);
        let ok = false;
        try {
          ok = got.name === wantName && (fixes.has(target) || satisfies(got.version, wantRange || "*"));
        } catch {}
        if (!ok) problems.push(`${pkg} asks for ${dep}@${range}, not ${target}`);
      }
    }
  }
  return [...new Set(problems)];
}

// ------------------------------------------------- the alert job's inventory --
// Beyond WORK's lockfile a build installs two more things, and advisories in
// either reach every Mac: each device tool's frozen closure (pin.json's
// deviceToolLocks, signed with the pin; lib/device-tools.mjs) and the packager's
// staged production install (lib/stage-install.mjs), resolved during the build
// itself. The second exists only where upstream's packager ran, so the evaluate
// job keeps each one it checked as a stage record, bound to what it was made
// from: the upstream commit, this repo's build code and the platform.
//
// What the evaluate job hands over counts only once it's checked against what
// it must describe; otherwise it's a gap. WORK's resolved lockfile: against
// upstream's lockfile and npm (checkedResolvedLock); without it, upstream's
// lockfile with the overrides applied stands in (trustedInventory). A stage
// lockfile: against the dependencies upstream's packager stages at that commit,
// read from its source (stagedDependencies), WORK's checked lockfile, and npm for
// whatever differs from that (stageLockProblems). Which versions a resolution
// picked inside the ranges it was given no check here can tell: only resolving
// again could, and that would run npm's resolver in the job that files issues.

/** `tool`'s frozen closure (name@version, sorted) from `pinJson`'s deviceToolLocks; throws when it has none or it doesn't match its SHA-256. */
export const toolClosurePackages = (tool, pinJson) => [...closurePackages(approvedToolLock(tool, pinJson)).keys()].sort();

/**
 * WORK's resolved lockfile checked as the commit job checks it: against
 * upstream's lockfile (checkResolvedLock), then what the overrides brought in
 * against npm (addedPackageProblems; npm unreachable is a problem too).
 * Returns { packages, problems }.
 */
export async function checkedResolvedLock({ upstreamLock, resolvedLock, overrides = readOverrides() }, { meta = npmMeta } = {}) {
  try {
    const { packages, added, problems } = checkResolvedLock({ upstreamLock, resolvedLock, overrides });
    if (!problems.length) problems.push(...(await addedPackageProblems({ resolvedLock, added, overrides }, { meta })));
    return { packages, problems };
  } catch (error) {
    return { packages: [], problems: [error.message] };
  }
}

/** The version of the stage record format below. */
export const STAGE_RECORD_VERSION = 2;

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * SHA-256 over this repo's build code, every file under bin/ and lib/ (the
 * build, its strip rules, injected files and the security overrides): which
 * Blackout made a stage record. `root`: the repo.
 */
export function blackoutDigest(root = REPO) {
  const hash = createHash("sha256");
  const walk = (rel) => {
    const full = path.join(root, rel);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) if (!name.startsWith(".")) walk(path.posix.join(rel, name));
      return;
    }
    const content = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
    hash.update(`${rel}\0${content.length}\0`).update(content);
  };
  for (const dir of ["bin", "lib"]) walk(dir);
  return hash.digest("hex");
}

/** The platform a stage record is made on, as `${process.platform}-${process.arch}`. */
export const stagePlatform = () => `${process.platform}-${process.arch}`;

/** The platforms Blackout builds on, as stagePlatform names them: [, os, arch]. */
const PLATFORM = /^(darwin|linux)-(arm64|x64)$/;

/**
 * A stage record for the build of `sha`: the checked staged lockfiles (`locks`,
 * pnpm-lock.yaml texts, as lib/build.mjs buildArtifact returns them) and what
 * binds them: the commit, the build code (`blackout`, blackoutDigest) and the platform.
 */
export function stageRecord({ sha, locks, blackout = blackoutDigest(), platform = stagePlatform(), builtAt = new Date().toISOString() }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`a stage record needs the upstream commit, not ${sha}`);
  if (!Array.isArray(locks) || !locks.length || !locks.every((lock) => typeof lock === "string")) throw new Error(`the build of ${sha.slice(0, 10)} returned no staged lockfiles`);
  return { v: STAGE_RECORD_VERSION, sha, blackout, platform, builtAt, locks };
}

/**
 * Reads a stage record (JSON text) for the build of `sha` by the build code
 * whose digest is `blackout` (and, when given, on `platform`): { locks,
 * platform, builtAt }. Throws when it's for another commit, other build code
 * (rules, overrides or the build changed since) or another platform. Whether
 * its lockfiles are that build's is checkStageRecord's to say.
 */
export function readStageRecord(text, { sha, blackout = blackoutDigest(), platform = null }) {
  const record = JSON.parse(text);
  if (record?.v !== STAGE_RECORD_VERSION) throw new Error(`stage record version ${record?.v} isn't ${STAGE_RECORD_VERSION}`);
  if (record.sha !== sha) throw new Error(`the stage record is for ${String(record.sha).slice(0, 10)}, not ${sha.slice(0, 10)}`);
  if (record.blackout !== blackout) throw new Error("the stage record was made by other Blackout build code (lib/ or bin/ changed since: rules, overrides or the build)");
  if (!PLATFORM.test(record.platform ?? "")) throw new Error(`the stage record was made on ${String(record.platform).slice(0, 40)}, which Blackout doesn't build on`);
  if (platform && record.platform !== platform) throw new Error(`the stage record was made on ${record.platform}, not ${platform}`);
  if (!Array.isArray(record.locks) || !record.locks.length || !record.locks.every((lock) => typeof lock === "string")) throw new Error("the stage record has no lockfiles");
  return { locks: record.locks, platform: record.platform, builtAt: String(record.builtAt).slice(0, 40) };
}

const CLI_EXTERNALS = "scripts/lib/cli-external-packages.ts";
const DESKTOP_EXTERNALS = "scripts/lib/desktop-external-packages.ts";

/** The strings in `const NAME = [...]` in `source` (`file`'s text); throws unless it's a plain list of them. */
function stringList(source, name, file) {
  const match = new RegExp(`\\bconst ${name} = \\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`${file} doesn't list ${name} anymore`);
  const body = match[1].replace(/\/\/[^\n]*/g, "");
  const quoted = /"([^"\\\n]*)"/g;
  if (body.replace(quoted, "").replace(/[\s,]/g, "")) throw new Error(`${file}: ${name} isn't a plain list of names anymore`);
  return [...body.matchAll(quoted)].map((m) => m[1]);
}

/** A package.json range, with `catalog:` ones looked up in pnpm-workspace.yaml (`workspace`, parsed). */
function catalogRange(workspace, name, range) {
  if (typeof range !== "string" || !range.startsWith("catalog:")) return range;
  const which = range.slice("catalog:".length);
  const found = !which || which === "default" ? workspace.catalog?.[name] : workspace.catalogs?.[which]?.[name];
  if (typeof found !== "string") throw new Error(`pnpm-workspace.yaml has no ${range} entry for ${name}`);
  return found;
}

/**
 * What a build of `sha` on `platform` (stagePlatform) stages, as upstream's
 * packager picks it (scripts/build-desktop-artifact.ts
 * resolveMergedStageDependencies): { dependencies (Map name -> range: the
 * server's and desktop's runtime externals, scripts/lib/{cli,desktop}-external-
 * packages.ts, and fff's native binaries for the platform), forced (name@version
 * the overrides put in whatever a dependent asks for: lib/overrides.json's fixes
 * and upstream's pnpm-workspace.yaml overrides) }. Read from upstream's source at
 * that commit as text (`show`, git), so none of it runs; throws when it can't be.
 * A stage lockfile that stages anything else is a gap: upstream changed how it
 * stages the app (update this), or the lockfile isn't from its build.
 */
export function stagedDependencies(show, sha, platform, overrides = readOverrides()) {
  const [, os, arch] = PLATFORM.exec(platform) ?? [];
  if (!os) throw new Error(`Blackout doesn't build on ${platform}`);
  const read = (file) => {
    const text = show(sha, file);
    if (text == null) throw new Error(`${file} is missing at ${sha.slice(0, 10)}`);
    return text;
  };
  const manifest = (file) => JSON.parse(read(file)).dependencies ?? {};
  const [server, desktop] = [manifest("apps/server/package.json"), manifest("apps/desktop/package.json")];
  const workspace = parseYaml(read("pnpm-workspace.yaml"))[0] ?? {};
  const cli = read(CLI_EXTERNALS);
  const prefixes = stringList(cli, "CLI_RUNTIME_EXTERNAL_PREFIXES", CLI_EXTERNALS);
  const cursor = stringList(cli, "CURSOR_RUNTIME_DEPENDENCIES", CLI_EXTERNALS);
  const desktopPrefixes = stringList(read(DESKTOP_EXTERNALS), "DESKTOP_RUNTIME_EXTERNAL_PREFIXES", DESKTOP_EXTERNALS);
  const picked = [
    ...Object.entries(server).filter(([name]) => prefixes.some((p) => name.startsWith(p)) || cursor.some((n) => name === n || name.startsWith(`${n}/`))),
    ...Object.entries(desktop).filter(([name]) => desktopPrefixes.some((p) => name.startsWith(p))),
  ];
  const fff = server["@ff-labs/fff-node"];
  if (fff) for (const bin of os === "linux" ? [`linux-${arch}-gnu`, `linux-${arch}-musl`] : [`darwin-${arch}`]) picked.push([`@ff-labs/fff-bin-${bin}`, fff]);
  const forced = new Set(overrides.map((o) => `${splitPackage(o.selector).name}@${o.version}`));
  for (const [selector, value] of Object.entries(workspace.overrides ?? {})) {
    const name = String(selector.split(">").pop()).replace(/^(@?[^@]+)@.*$/, "$1");
    const version = typeof value === "string" && value.startsWith("catalog:") ? workspace.catalog?.[name] : value;
    if (typeof version === "string" && parseVersion(version)) forced.add(`${name}@${version}`);
  }
  return { dependencies: new Map(picked.map(([name, range]) => [name, catalogRange(workspace, name, range)])), forced };
}

/** Whether `pkg` (name@version) is what `range` asks for, or one of the `forced` versions. */
function fits(pkg, range, forced) {
  try {
    return forced.has(pkg) || satisfies(splitPackage(pkg).version, range);
  } catch {
    return false;
  }
}

/**
 * Why `lock` (a lockfile from a stage record) can't be the staged install of the
 * release whose checked lockfile is `workLock`, with `staged` (stagedDependencies)
 * what upstream's packager stages for it: other dependencies or versions out of
 * their ranges; other bytes for a version than WORK's lockfile, or a version an
 * override replaces; a package whose dependencies are neither what WORK's
 * lockfile gives that version nor what its package.json on npm asks for (`meta`;
 * npm unreachable throws).
 */
export async function stageLockProblems({ lock, workLock, staged, overrides = readOverrides() }, { meta = npmMeta } = {}) {
  const stage = parseLockfile(lock);
  const work = parseLockfile(workLock);
  const problems = [];
  // The staged app asks for exactly what upstream's packager gives it, each in its
  // range; besides that only its Electron (a devDependency the install skips) and pnpm.
  const direct = new Map();
  for (const [where, deps] of stage.importers) {
    if (where.replace(/^\d+\//, "") !== ".") problems.push(`has a project besides the staged app: ${where.replace(/^\d+\//, "")}`);
    for (const [field, key] of deps) {
      const name = field.slice(field.indexOf(" ") + 1);
      if (/^(?:optionalD|d)ependencies /.test(field)) direct.set(name, key);
      else if (field !== "devDependencies electron" && field !== "packageManagerDependencies pnpm") problems.push(`its staged app has ${field}`);
    }
  }
  const { dependencies, forced } = staged;
  const other = [...new Set([...dependencies.keys(), ...direct.keys()])].filter((name) => !dependencies.has(name) || !direct.has(name)).sort();
  if (other.length) problems.push(`stages other dependencies than upstream's packager does: ${listed(other.map((name) => `${direct.has(name) ? "adds" : "lacks"} ${name}`))}`);
  for (const [name, key] of direct) {
    const pkg = key && withoutPeers(key);
    if (dependencies.has(name) && (!pkg || splitPackage(pkg).name !== name || !fits(pkg, dependencies.get(name), forced))) problems.push(`stages ${pkg ?? `a link for ${name}`}, not ${name}@${dependencies.get(name)}`);
  }
  // The same bytes as WORK's checked lockfile, from the registry, and nothing an override replaces.
  try {
    const swapped = substitutions(lockIdentities(work), lockIdentities(stage));
    if (swapped.length) problems.push(`resolves ${swapped.length} version(s) to other bytes than WORK's lockfile: ${listed(swapped.map(({ pkg, why }) => `${pkg} ${why}`))}`);
  } catch (error) {
    problems.push(error.message);
  }
  const survived = [...stage.packages].filter((pkg) => overrideFor(pkg, overrides));
  if (survived.length) problems.push(`still has versions the security overrides replace: ${listed(survived)}`);
  // Each package's dependencies: as WORK's checked lockfile gives that version, or what npm says it asks for.
  const known = edgesByPackage(work, [...work.edges.keys()], withoutPeers);
  const names = (edges) => new Set([...edges].map((edge) => edge.slice(edge.indexOf(" ") + 1, edge.indexOf("="))));
  for (const key of reachableKeys(stage)) {
    const pkg = withoutPeers(key);
    const own = new Set([...(stage.edges.get(key) ?? [])].map(([field, target]) => `${field}=${withoutPeers(target)}`));
    const same = known.get(pkg);
    if (same && [...own].every((edge) => same.has(edge)) && names(own).size === names(same).size) continue;
    const { name, version } = splitPackage(pkg);
    const info = (await meta(name))?.versions?.[version];
    if (!info) {
      problems.push(`${pkg} isn't on npm`);
      continue;
    }
    const optional = info.optionalDependencies ?? {};
    const declared = { ...(info.peerDependencies ?? {}), ...(info.dependencies ?? {}), ...optional };
    const bundled = new Set([...(info.bundleDependencies ?? []), ...(info.bundledDependencies ?? [])].filter((dep) => typeof dep === "string"));
    const have = names(own);
    // WORK's lockfile lacking it too is an override removing it.
    for (const dep of Object.keys(info.dependencies ?? {})) {
      if (!have.has(dep) && !Object.hasOwn(optional, dep) && !bundled.has(dep) && (!same || names(same).has(dep))) problems.push(`${pkg} needs ${dep}, which the staged lockfile doesn't give it`);
    }
    for (const edge of own) {
      if (same?.has(edge)) continue;
      const dep = edge.slice(edge.indexOf(" ") + 1, edge.indexOf("="));
      const target = edge.slice(edge.indexOf("=") + 1);
      const range = Object.hasOwn(declared, dep) ? declared[dep] : null;
      // A dependency its package.json doesn't name only adds packages, which are checked anyway.
      if (typeof range !== "string") continue;
      const alias = /^npm:((?:@[^@/]+\/)?[^@/]+)@(.*)$/.exec(range);
      const [wantName, wantRange] = alias ? [alias[1], alias[2]] : [dep, range];
      if (splitPackage(target).name !== wantName || !fits(target, wantRange || "*", forced)) problems.push(`${pkg} asks for ${dep}@${range}, not ${target}`);
    }
  }
  return [...new Set(problems)];
}

/**
 * A stage record (JSON text) checked as the staged install of the build of
 * `sha`: bound to it, this build code and (when given) `platform`
 * (readStageRecord), and each lockfile what that build stages (stageLockProblems,
 * against upstream's source at `sha` through `show` and WORK's checked lockfile
 * `workLock`). Returns { packages (registry name@version), platform, builtAt };
 * throws why it can't be that build's.
 */
export async function checkStageRecord(text, { sha, show, workLock, blackout, platform = null, overrides = readOverrides() }, { meta = npmMeta } = {}) {
  const record = readStageRecord(text, { sha, blackout, platform });
  const staged = stagedDependencies(show, sha, record.platform, overrides);
  const packages = new Set();
  for (const [i, lock] of record.locks.entries()) {
    const which = record.locks.length > 1 ? `lockfile ${i + 1}` : "lockfile";
    let problems;
    try {
      problems = await stageLockProblems({ lock, workLock, staged, overrides }, { meta });
    } catch (error) {
      problems = [error.message];
    }
    if (problems.length) throw new Error(`its ${which} isn't what a build of ${sha.slice(0, 10)} stages: ${problems.join("; ")}`);
    for (const pkg of registryPackages(reachablePackages(parseLockfile(lock)))) packages.add(pkg);
  }
  return { packages: [...packages].sort(), platform: record.platform, builtAt: record.builtAt };
}

/**
 * Everything the alert job checks for advisories against the build of `sha`,
 * as far as it can be known: { packages (sorted), gaps (what couldn't be
 * covered, and why), notes }. From upstream at that commit (`show`, git):
 *   - WORK's resolved graph, the evaluate job's `resolvedLock` checked
 *     (checkedResolvedLock); missing or not checking out, upstream's lockfile
 *     with the overrides applied (trustedInventory) and a gap for what the
 *     overrides' fixes bring in;
 *   - the device tools the release pins and each one's frozen closure,
 *     `toolPackages(pin)` (pin.json's deviceToolLocks), or a gap;
 *   - the staged production install, `stage` (a stage record's text, or null),
 *     checked (checkStageRecord) against WORK's checked graph, or a gap.
 * With a gap, packages it may hold are unknown, so nothing may be called fixed.
 */
export async function alertInventory({ sha, show, resolvedLock, toolPackages, stage, overrides = readOverrides(), blackout = blackoutDigest() }, { meta = npmMeta } = {}) {
  const at = sha.slice(0, 10);
  const packages = new Set();
  const gaps = [];
  const notes = [];
  let tools = [];
  try {
    tools = deviceToolsInUse(show(sha, DEVICE_TOOL_PINS));
  } catch (error) {
    gaps.push(`the device tools: ${error.message}`);
  }
  const upstreamLock = show(sha, "pnpm-lock.yaml");
  const work = resolvedLock == null ? { problems: [`the evaluate job left no resolved lockfile for ${at}`] } : await checkedResolvedLock({ upstreamLock, resolvedLock, overrides }, { meta });
  const workLock = work.problems.length ? null : resolvedLock;
  if (workLock) for (const pkg of work.packages) packages.add(pkg);
  else {
    gaps.push(`what the security overrides bring in: ${listed(work.problems)}; upstream's lockfile with the overrides applied stands in for it`);
    try {
      for (const pkg of trustedInventory({ upstreamLock, deviceTools: [], overrides })) packages.add(pkg);
    } catch (error) {
      gaps.push(`WORK's dependencies: ${error.message}`);
    }
  }
  for (const pin of tools) {
    packages.add(pin);
    try {
      const closure = toolPackages(pin);
      if (!closure.includes(pin)) throw new Error(`its closure doesn't contain ${pin}`);
      for (const pkg of closure) packages.add(pkg);
      notes.push(`device tool ${pin}: ${closure.length} packages in its frozen closure`);
    } catch (error) {
      gaps.push(`device tool ${pin}'s dependencies: ${error.message}`);
    }
  }
  if (stage == null) gaps.push(`the staged production install: the evaluate job left no stage record for ${at}`);
  else if (!workLock) gaps.push("the staged production install: its stage record can't be checked without WORK's checked lockfile");
  else {
    try {
      const read = await checkStageRecord(stage, { sha, show, workLock, blackout, overrides }, { meta });
      for (const pkg of read.packages) packages.add(pkg);
      notes.push(`staged production install: ${read.packages.length} packages, as resolved on ${read.platform} at ${read.builtAt}`);
    } catch (error) {
      gaps.push(`the staged production install: ${error.message}`);
    }
  }
  return { packages: [...packages].sort(), gaps, notes };
}
