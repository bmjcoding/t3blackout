// The build half of an update: checkout, strip, build, scan, smoke test. Runs as
// the build account when there is one (lib/builder.mjs), otherwise as you. The
// result is an unsigned app in OUT; signing and installing happen as you.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { collectDrift, driftSummary, renderDriftReport } from "./drift.mjs";
import { progress } from "./events.mjs";
import { featureIndex, skipDependents } from "./features.mjs";
import { forbiddenInBuild, makeRules } from "./rules.mjs";
import loopback from "./files/loopback.cjs";
import { smokeTest } from "./smoke.mjs";
import { verifySnapshot } from "./builder.mjs";
import { approvedToolLock, deviceToolLocks } from "./device-tools.mjs";
import { isRegistryVersion, parseLockfile, splitPackage } from "./lockfile.mjs";
import { nativeAssetsFor, readNativeAssets } from "./native-assets.mjs";
import { DEADLINES } from "./git.mjs";
import { applyRules, findHosts, scanForbidden } from "./strip-engine.mjs";
import { MIN_AGE_DAYS } from "./gates.mjs";
import { readOverrides } from "./overrides.mjs";
import { readPin } from "./pin.mjs";
import { checkLinksInTree, checkResolution, trackedTree } from "./resolution.mjs";
import { installedPackages, readStageRecords, shimEnv, stageChanges, stageContents, stageDigest } from "./stage-install.mjs";
import { previousTag, upstreamWebUrl } from "./upstream.mjs";
import { IS_BUILDER, LAUNCHER, MIRROR, OUT, STATE, WORK, copyTree, findPaths, log, mirrorGit, mirrorOut, run, runTail, stableNodePath } from "./util.mjs";

/** Whether WORK is a checkout of the current mirror (it moves when the build account is set up). */
function workBelongsToMirror() {
  if (!fs.existsSync(path.join(WORK, ".git"))) return false;
  const common = mirrorGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { dir: WORK });
  return common.status === 0 && fs.existsSync(path.join(MIRROR, ".git")) && common.stdout.trim() === fs.realpathSync(path.join(MIRROR, ".git"));
}

export function checkoutWork(ref) {
  // A checkout fetches file contents from upstream (the mirror is blobless):
  // HTTPS only, nothing that prompts, and a deadline (lib/util.mjs mirrorGit).
  const fetching = { fetch: true, timeout: DEADLINES.clone, stdio: ["ignore", "inherit", "pipe"] };
  if (workBelongsToMirror()) {
    // Reuse the checkout and its node_modules: deleting them took most of a
    // minute, and `pnpm install --frozen-lockfile` brings node_modules back in
    // line with the new lockfile. Everything else, build output included, goes.
    mirrorOut(["checkout", "--quiet", "--force", "--detach", ref], { ...fetching, dir: WORK }, `checking out ${ref}`);
    mirrorOut(["clean", "-fdxq", "-e", "node_modules"], { dir: WORK }, "cleaning the checkout");
  } else {
    fs.rmSync(WORK, { recursive: true, force: true });
    mirrorOut(["worktree", "prune"]);
    mirrorOut(["worktree", "add", "--quiet", "--detach", WORK, ref], fetching, `checking out ${ref}`);
  }
  // Upstream's .env.example holds production Clerk/relay values; a stray .env
  // would bake them in. The rules already force those constants empty.
  for (const name of [".env", ".env.local"]) fs.rmSync(path.join(WORK, name), { force: true });
}

/**
 * What the app's update button runs (BlackoutUpdater.ts): the CLI in your clone
 * with your node and PATH. The build account gets these from you via env.
 */
function updaterPaths() {
  return {
    node: process.env.T3BLACKOUT_APP_NODE ?? stableNodePath(),
    launcher: process.env.T3BLACKOUT_APP_LAUNCHER ?? LAUNCHER,
    path: process.env.T3BLACKOUT_APP_PATH ?? process.env.PATH ?? "/usr/bin:/bin",
  };
}

const KNOWN_HOSTS = new URL("./known-hosts.txt", import.meta.url);
const HOST_SCAN_DIRS = ["apps/desktop", "apps/server", "apps/web", "packages"];
const KNOWN_DEVICE_TOOLS = new URL("./known-device-tools.txt", import.meta.url);
const DEVICE_TOOL_PINS = "apps/server/src/device/deviceToolVersions.json";

/** A list file's entries, without comments and blank lines. */
const readList = (file) =>
  new Set(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean),
  );

/**
 * Hosts that can't be a phone-home: names under the TLDs reserved so they never
 * resolve (RFC 2606, RFC 6761; upstream uses them as fake origins and placeholder
 * text), and loopback addresses. Not example.com, .net or .org: those are real
 * domains that resolve, so a use of one is listed in lib/known-hosts.txt.
 */
export function isReservedHost(host) {
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(name)) return loopback.isLoopbackAddress(name);
  return ["invalid", "test", "localhost", "example"].includes(name.split(".").at(-1));
}

/** Hosts upstream's source names that lib/known-hosts.txt doesn't, with where each first appears. */
function unknownHosts() {
  const known = readList(KNOWN_HOSTS);
  return [...findHosts(WORK, HOST_SCAN_DIRS)].filter(([host]) => !known.has(host) && !isReservedHost(host));
}

/** Device tool versions read by hand (lib/known-device-tools.txt). */
export const knownDeviceTools = () => readList(KNOWN_DEVICE_TOOLS);

/** Device tool versions read by hand or cleared by the evaluator (pin.json), and the candidate's own provisional ones. */
export function reviewedDeviceTools() {
  return new Set([...knownDeviceTools(), ...(readPin()?.deviceTools ?? []), ...provisionalDeviceTools]);
}

/**
 * Versions the evaluator has just cleared for the one candidate it's checking,
 * and the dependency lockfiles it proposed for them ({ "name@version": { sha256,
 * lock } }), before it writes them to pin.json. Each call replaces the last
 * candidate's, so a held candidate's approvals never let another candidate through.
 */
let provisionalDeviceTools = [];
let provisionalToolLocks = {};
export const allowDeviceTools = (pins, locks = {}) => {
  provisionalDeviceTools = [...pins];
  provisionalToolLocks = { ...locks };
};

/** pin.json with the candidate's proposed tool locks under its own (which win): what a build installs from. */
function approvedPin() {
  const pin = readPin();
  return { ...pin, deviceToolLocks: { ...provisionalToolLocks, ...(pin?.deviceToolLocks ?? {}) } };
}

/** Every device tool `name@version` upstream pins in a checkout (WORK by default). */
export function deviceToolPins(root = WORK) {
  const file = path.join(root, DEVICE_TOOL_PINS);
  if (!fs.existsSync(file)) return null;
  return Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))).map(([name, version]) => `${name}@${version}`);
}

/**
 * Device tools upstream pins (`name@version`) that haven't been reviewed. The app
 * npm-installs them when device support is on, so a new pin is new code the host
 * scan never reads.
 */
function unreviewedDeviceTools() {
  const pins = deviceToolPins();
  if (!pins) return [`${DEVICE_TOOL_PINS} is gone; find where upstream pins device tools now`];
  const reviewed = reviewedDeviceTools();
  return pins.filter((pin) => !reviewed.has(pin));
}

/**
 * Why reviewed device tools upstream pins can't be installed as reviewed: no
 * kept dependency lockfile (pin.json deviceToolLocks, or the candidate's
 * proposed one), or a package in it with an install script that
 * lib/native-assets.json doesn't cover. Offline; the build checks each lock
 * against npm again (lib/device-tools.mjs deviceToolLocks).
 */
function unlockedDeviceTools() {
  const reviewed = reviewedDeviceTools();
  const problems = [];
  for (const pin of (deviceToolPins() ?? []).filter((tool) => reviewed.has(tool))) {
    try {
      nativeAssetsFor(approvedToolLock(pin, approvedPin()), readNativeAssets(), pin);
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

/** Whether the host scan would let `host` through. */
export const isKnownHost = (host) => readList(KNOWN_HOSTS).has(host) || isReservedHost(host);

/** A strict rule stopped the build; `drift` holds what upstream changed. */
export class StrictDrift extends Error {
  constructor(message, drift) {
    super(message);
    this.drift = drift;
  }
}

/**
 * Applies the strip rules to WORK, which holds upstream `sha`. A feature whose
 * rule no longer matches (lib/features.mjs) is left out, with every feature that
 * requires it, and the rules are reapplied to a fresh checkout without them; a
 * strict rule that no longer matches throws. `build`: { version, changes,
 * baseline, baselines } for a real build, absent for a dry run. `skipped` (Map of
 * feature -> why) carries over from an earlier pass, e.g. one that didn't compile.
 * Returns { skipped, drift, rules, featureOf }.
 */
export function strip({ sha, build, skipped = new Map(), baseline = null, version = null }) {
  // Before stripping, so it sees upstream's code and not ours.
  log("checking upstream for new network hosts");
  const hosts = unknownHosts();
  const tools = unreviewedDeviceTools();
  const locks = unlockedDeviceTools();
  const plain = makeRules({ updater: updaterPaths(), build: null });
  const featureOf = featureIndex(plain);
  const rulesById = new Map(plain.map((rule) => [rule.id, rule]));
  const describe = (strict = []) =>
    collectDrift({
      skipped,
      strict,
      rulesById,
      target: { sha, version: build?.version ?? version ?? sha.slice(0, 10), repo: upstreamWebUrl() },
      baselineFor: (name) => (name && build?.baselines?.[name]) || build?.baseline || baseline || previousTag(sha),
    });
  for (let pass = 1; ; pass++) {
    if (pass > 1) checkoutWork(sha);
    const drift = skipped.size ? describe() : null;
    const rules = makeRules({
      updater: updaterPaths(),
      build: build && { ...build, sha, skipped: driftSummary(drift), driftReport: drift ? renderDriftReport(drift) : null },
    });
    log(skipped.size ? `applying strip rules without: ${[...skipped.keys()].join(", ")}` : "applying strip rules");
    const failures = applyRules(WORK, rules.filter((rule) => !skipped.has(featureOf.get(rule.id))));
    const strict = leaveOutFailed(failures, featureOf, skipped);
    if (strict.length || hosts.length || tools.length || locks.length) {
      throw new StrictDrift(stopMessage({ strict, hosts, tools, locks }), strict.length ? describe(strict) : null);
    }
    if (!failures.length) {
      if (skipped.size) log(`left out: ${[...skipped.keys()].join(", ")}`);
      return { skipped, drift, rules, featureOf };
    }
    for (const failure of failures) log(`  leaving out ${featureOf.get(failure.id)}: ${failure.message.split("\n")[0]}`);
  }
}

/**
 * Files each failed optional rule's feature under `skipped`, with every feature
 * that requires it; returns the strict failures, which stop the build.
 */
function leaveOutFailed(failures, featureOf, skipped) {
  for (const failure of failures) {
    const name = featureOf.get(failure.id);
    if (!name) continue;
    if (!skipped.has(name)) skipped.set(name, { reason: "anchor", failures: [] });
    skipped.get(name).failures.push(failure);
  }
  skipDependents(skipped);
  return failures.filter((failure) => !featureOf.has(failure.id));
}

/** Why a build stops before anything is installed, and what to do about each reason. */
function stopMessage({ strict, hosts, tools, locks = [] }) {
  const reasons = [
    strict.length && `${strict.length} strict rule(s) no longer match upstream`,
    hosts.length && `upstream names ${hosts.length} new network host(s)`,
    tools.length && `upstream pins ${tools.length} unreviewed device tool(s)`,
    locks.length && `${locks.length} reviewed device tool(s) can't install as reviewed`,
  ].filter(Boolean);
  return [
    `${reasons.join(" and ")}. Nothing was installed.`,
    ...strict.map((failure) => `  - ${failure.message}`),
    ...hosts.map(([host, where]) => `  - new host ${host} (${where})`),
    ...tools.map((pin) => `  - device tool ${pin}`),
    ...locks.map((why) => `  - ${why}`),
    ...(strict.length ? ["Update lib/rules.mjs for the new upstream code, then rerun; `t3blackout drift` shows what upstream changed."] : []),
    ...(hosts.length ? ["Check what talks to each new host; add a strip rule or list it in lib/known-hosts.txt, then rerun."] : []),
    ...(tools.length ? ["Read each new device tool version for network calls (see lib/known-device-tools.txt), list it there, then rerun."] : []),
  ].join("\n");
}

/**
 * macOS: the app icon is an Icon Composer bundle, so it renders as Liquid Glass and
 * follows the system's light, dark, clear and tinted icon styles. electron-builder
 * compiles it with actool, which needs Xcode 26 or newer; Command Line Tools don't
 * have it. Use the selected developer directory if its actool is new enough, else
 * the newest /Applications/Xcode*.app that is. Without one the build keeps the flat
 * icns made from the fallback PNG.
 */
let liquidGlassIcon;
function liquidGlassIconEnv() {
  liquidGlassIcon ??= findLiquidGlassIcon();
  return liquidGlassIcon;
}

function findLiquidGlassIcon() {
  if (process.platform !== "darwin") return {};
  const icon = path.join(WORK, "assets", "blackout", "app-icon.icon");
  if (!fs.existsSync(icon)) return {};
  const actoolMajor = (developerDir) => {
    const env = { ...process.env };
    if (developerDir) env.DEVELOPER_DIR = developerDir;
    const result = spawnSync("actool", ["--version"], { env, encoding: "utf8" });
    const version = /<key>short-bundle-version<\/key>\s*<string>(\d+)/.exec(result.stdout ?? "");
    return result.status === 0 && version ? Number(version[1]) : 0;
  };
  const xcodes = fs.existsSync("/Applications")
    ? fs.readdirSync("/Applications").filter((name) => /^Xcode.*\.app$/.test(name)).sort().reverse()
    : [];
  const candidates = [process.env.DEVELOPER_DIR, null, ...xcodes.map((name) => `/Applications/${name}/Contents/Developer`)];
  for (const developerDir of candidates) {
    if (developerDir === undefined || actoolMajor(developerDir) < 26) continue;
    log(`app icon: Liquid Glass, compiled with ${developerDir ?? "the selected Xcode"}`);
    return { T3BLACKOUT_MAC_ICON: icon, ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}) };
  }
  log("app icon: no Xcode 26+ found, so it stays flat (no Liquid Glass)");
  return {};
}

/** Build-time env: no cloud keys, no publish tokens, nothing inherited by accident. */
function buildEnv() {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  // Upstream's build spawns `vp` by name; use the repo's own vite-plus so the
  // machine doesn't need it installed globally.
  env.PATH = [path.join(WORK, "node_modules", ".bin"), process.env.PATH ?? "/usr/bin:/bin"].join(":");
  return {
    ...env,
    CI: "1",
    // pnpm checks a lockfile's resolutions against the registry before it
    // installs from it; upstream's config must not turn that off (trustLockfile).
    pnpm_config_trust_lockfile: "false",
    T3CODE_DESKTOP_SIGNED: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    ...liquidGlassIconEnv(),
  };
}

/** Packages the strip rules edit, typechecked before every build. */
const TYPECHECKED = ["apps/desktop", "apps/server", "apps/web", "packages/client-runtime", "packages/contracts", "packages/shared"];

/**
 * The web app's routes are typed by routeTree.gen.ts, which upstream commits and
 * the router plugin rewrites during the build. Regenerate it the same way first,
 * or the routes the rules add (/settings/skills) fail the typecheck.
 */
const ROUTE_GENERATOR = `
import { createRequire } from "node:module";
const plugin = createRequire(process.cwd() + "/package.json").resolve("@tanstack/router-plugin/package.json");
const { Generator, getConfig } = await import(createRequire(plugin).resolve("@tanstack/router-generator"));
await new Generator({ config: getConfig({}, process.cwd()), root: process.cwd() }).run();
`;

function generateRoutes(opts) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", ROUTE_GENERATOR], { ...opts, cwd: path.join(WORK, "apps", "web"), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`couldn't regenerate the web app's routes; update lib/build.mjs:\n${(result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n")}`);
  }
}

/**
 * Type errors in TYPECHECKED, as { file (from the repo root), line, message }.
 * The Effect plugin's lint findings (ending "effect(rule)") are left to upstream's
 * CI: they're style, and dropping a feature over one would be out of proportion.
 */
function typecheck(opts) {
  generateRoutes(opts);
  const tsc = ["tsc-rs", "tsc"].map((name) => path.join(WORK, "node_modules", ".bin", name)).find((bin) => fs.existsSync(bin));
  if (!tsc) throw new Error("upstream has neither tsc-rs nor tsc anymore; update lib/build.mjs");
  const errors = [];
  for (const pkg of TYPECHECKED) {
    const cwd = path.join(WORK, pkg);
    if (!fs.existsSync(path.join(cwd, "tsconfig.json"))) throw new Error(`${pkg} has no tsconfig.json anymore; update lib/build.mjs`);
    const result = spawnSync(tsc, ["--noEmit"], { ...opts, cwd, encoding: "utf8", maxBuffer: 256 << 20 });
    if (result.status === 0) continue;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const all = [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/gm)].map(([, file, line, message]) => ({
      file: path.posix.join(pkg, file),
      line: Number(line),
      message,
    }));
    const found = all.filter((error) => !/ effect\([A-Za-z]+\)$/.test(error.message));
    if (all.length && !found.length) continue;
    if (!found.length) throw new Error(`typechecking ${pkg} failed:\n${output.trim().split("\n").slice(-15).join("\n")}`);
    errors.push(...found);
  }
  return errors;
}

/**
 * Typechecks the stripped checkout. A feature that wrote or edited a file with a
 * type error is left out and the rules are reapplied without it; an error
 * anywhere else stops the build, since it can't be pinned on a feature.
 */
function typecheckOrLeaveOut({ sha, build, stripped, opts }) {
  for (let attempt = 1; ; attempt++) {
    log("typechecking");
    const errors = typecheck(opts);
    if (!errors.length) return stripped;
    const owners = featureOwners(stripped);
    const blamed = errors.filter((error) => owners.has(error.file));
    if (!blamed.length || attempt > 3) {
      throw new Error(
        [
          `the app doesn't typecheck against upstream (${errors.length} error(s)). Nothing was installed.`,
          ...errors.slice(0, 15).map((error) => `  - ${error.file}(${error.line}): ${error.message}`),
        ].join("\n"),
      );
    }
    leaveOutUncompiled(blamed, owners, stripped.skipped);
    checkoutWork(sha);
    stripped = strip({ sha, build, skipped: stripped.skipped });
  }
}

/** The features (still in the build) that wrote or edited each file. */
function featureOwners({ rules, featureOf, skipped }) {
  const owners = new Map();
  for (const rule of rules) {
    const name = featureOf.get(rule.id);
    if (name && !skipped.has(name) && rule.file) owners.set(rule.file, [...(owners.get(rule.file) ?? []), name]);
  }
  return owners;
}

/** Files the features owning each blamed file under `skipped`, with every feature that requires one. */
function leaveOutUncompiled(blamed, owners, skipped) {
  for (const error of blamed) {
    for (const name of owners.get(error.file)) {
      if (!skipped.has(name)) skipped.set(name, { reason: "compile", errors: [] });
      skipped.get(name).errors?.push(error);
    }
  }
  skipDependents(skipped);
  for (const error of blamed) log(`  leaving out ${owners.get(error.file).join(", ")}: ${error.file}(${error.line}): ${error.message}`);
}

/**
 * Runs upstream's packager in the build's private TMPDIR (`stages.tmpdir`, where
 * it stages the app). Its lockfile-free production installs of the stage run
 * lib/stage-install.mjs's guard (rule desktop/stage-install-guarded): resolved,
 * checked against WORK's verified lockfile and installed frozen; vp, pnpm, npm
 * and yarn are shims that refuse any other install there. Returns the checked
 * staged lockfiles.
 */
async function packageApp(version, platform, opts, stages) {
  log(`building desktop app ${version} (${platform.name}, unsigned)`);
  const verifiedLock = path.join(stages.tmpdir, "verified-lock.yaml");
  fs.copyFileSync(path.join(WORK, "pnpm-lock.yaml"), verifiedLock);
  const record = path.join(stages.tmpdir, "stage-installs.jsonl");
  const env = shimEnv({ dir: path.join(stages.tmpdir, "shims"), env: { ...opts.env, TMPDIR: stages.tmpdir }, stageRoot: stages.tmpdir, verifiedLock, record });
  if (!env.T3BLACKOUT_REAL_VP.startsWith(path.join(WORK, "node_modules"))) {
    throw new Error(`upstream's vite-plus isn't at node_modules/.bin/vp anymore (found ${env.T3BLACKOUT_REAL_VP || "none"}); update lib/build.mjs`);
  }
  await runTail(process.execPath, ["scripts/build-desktop-artifact.ts", ...platform.buildArgs(), "--build-version", version], { ...opts, env }, "building the app");
  const { lines, locks } = verifyStageInstalls(stages, record);
  for (const line of lines) log(line);
  return locks;
}

/**
 * Every node_modules in the packager's stage folders (in the build's private
 * TMPDIR, `stages.tmpdir`) must be one lib/stage-install.mjs's guard checked and
 * installed, and still be what it installed: the same package.json, workspace
 * config and lockfile (the digest it recorded), no package the checked
 * lockfile doesn't have, and every file pnpm installed from it unchanged, with
 * nothing added but what packaging adds (lib/stage-install.mjs stageChanges).
 * Returns { lines (for the log), locks (the checked lockfiles' text) }.
 */
export function verifyStageInstalls(stages, record) {
  const records = readStageRecords(record);
  if (!records.length) throw new Error("upstream's packager staged the app without its checked production install (lib/stage-install.mjs never ran); update lib/stage-install.mjs");
  const byDir = new Map(records.map((done) => [done.dir, done]));
  const stageDirs = fs.readdirSync(stages.tmpdir).filter((name) => /^t3code-desktop-.+-stage-/.test(name)).map((name) => path.join(stages.tmpdir, name));
  const found = findPaths(stageDirs, (entry) => entry.isDirectory() && entry.name === "node_modules", { maxDepth: 3 });
  const unchecked = found.filter((dir) => !byDir.has(fs.realpathSync(path.dirname(dir))));
  if (unchecked.length) throw new Error(`upstream's packager installed dependencies nothing checked: ${unchecked.join(", ")}`);
  for (const done of records) {
    if (!fs.existsSync(done.dir) || stageDigest(done.dir) !== done.digest) throw new Error(`the staged install in ${done.dir} isn't the one checked: its package.json, workspace config or lockfile changed`);
    const extra = [...installedPackages(done.dir)].filter((pkg) => !inLock(done.lock).has(pkg) && !inLock(done.lock).has(`${splitPackage(pkg).name}@*`));
    if (extra.length) throw new Error(`the staged install in ${done.dir} has packages its checked lockfile doesn't: ${extra.sort().join(", ")}`);
    if (!done.files) throw new Error(`the staged install in ${done.dir} has no record of the files it installed; update lib/stage-install.mjs`);
    const changed = stageChanges(done.files, stageContents(done.dir));
    if (changed.length) throw new Error(`the staged install in ${done.dir} isn't what was installed from its checked lockfile: node_modules/${changed.slice(0, 10).join(", node_modules/")}${changed.length > 10 ? ` and ${changed.length - 10} more` : ""} changed, went or appeared`);
  }
  const root = fs.realpathSync(stages.tmpdir);
  return {
    lines: records.map(({ dir, packages, added }) => `staged install ${path.relative(root, dir)}: ${packages} packages checked, ${added.length} beyond WORK's lockfile${added.length ? ` (${added.join(", ")})` : ""}`),
    locks: records.map(({ lock }) => lock),
  };
}

/** A pnpm-lock.yaml's packages as name@version, a non-registry one (a tarball in upstream's tree) as name@*. Memoized per text. */
const lockSets = new Map();
function inLock(text) {
  if (!lockSets.has(text)) {
    const keys = [...parseLockfile(text).packages].map((pkg) => splitPackage(pkg)).map(({ name, version }) => `${name}@${isRegistryVersion(version) ? version.split("(")[0] : "*"}`);
    lockSets.set(text, new Set(keys));
  }
  return lockSets.get(text);
}

function scanDist() {
  log("scanning build output for forbidden endpoints");
  const hits = scanForbidden(
    ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"].map((dir) => path.join(WORK, dir)),
    forbiddenInBuild,
  );
  if (hits.length) {
    throw new Error(`forbidden endpoints found in build output:\n${hits.map((h) => `  - ${h}`).join("\n")}`);
  }
  const html = path.join(WORK, "apps", "web", "dist", "index.html");
  if (fs.existsSync(html) && !fs.readFileSync(html, "utf8").includes("Content-Security-Policy")) {
    throw new Error("built index.html is missing the t3blackout CSP");
  }
}

/**
 * Scans the collected app (`artifact`, from collect) for forbidden endpoints, so
 * a check --build verifies the artifact it produced: staged dependencies and
 * native sidecars, not just WORK's bundles. The install path scans its copy again.
 */
export function scanArtifact(platform, artifact) {
  log("scanning the packaged app for forbidden endpoints");
  const hits = scanForbidden(platform.scanRoots(typeof artifact === "string" ? artifact : artifact.dir), forbiddenInBuild);
  if (hits.length) throw new Error(`forbidden endpoints found in the packaged app:\n${hits.map((h) => `  - ${h}`).join("\n")}`);
}

/** Copies the packaged app out of upstream's temporary stage into OUT. */
function collect(found) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (typeof found === "string") {
    const app = path.join(OUT, path.basename(found));
    copyTree(found, app);
    return app;
  }
  const dir = path.join(OUT, "app");
  copyTree(found.dir, dir);
  const icon = found.icon ? path.join(OUT, "icon.png") : null;
  if (icon) fs.copyFileSync(found.icon, icon);
  return { dir, icon };
}

/** Weekly, and only in the build account's own store: yours is shared with your other projects. */
function pruneStore() {
  if (!IS_BUILDER) return;
  const stamp = path.join(STATE, "store-pruned");
  if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 7 * 24 * 3600 * 1000) return;
  log("pruning unused packages from the pnpm store");
  run("pnpm", ["store", "prune"], { cwd: WORK, env: buildEnv(), stdio: "ignore" });
  fs.writeFileSync(stamp, "");
}

/**
 * Builds `sha` into an unsigned, smoke-tested app; returns where it is in OUT.
 * `baseline`/`baselines`: the upstream commit installed, and per feature the last
 * one it built against, for the drift report. `onDrift(drift)` hears what was left
 * out, or what stopped the build. Returns { artifact, skipped, stageLocks (the
 * checked staged lockfiles, for the advisory inventory) }.
 */
export async function buildArtifact({ sha, version, platform, changes, baseline = null, baselines = {}, onDrift = () => {} }) {
  if (IS_BUILDER && !verifySnapshot({ sha }).pinnedBy) log(`building ${sha.slice(0, 10)}, which pin.json doesn't pin (an explicit --ref)`);
  const stages = platform.beginBuild();
  const build = { version, changes, baseline, baselines };
  try {
    if (!stages.tmpdir) throw new Error("the platform gave the build no private TMPDIR (lib/util.mjs trackStageDirs)");
    checkoutWork(sha);
    // The app installs each device tool from the closure reviewed for it (pin.json
    // deviceToolLocks), checked again here; an unreviewed tool stops the build in strip() instead.
    log("checking device tools' reviewed dependency closures");
    const tools = (deviceToolPins() ?? []).filter((pin) => reviewedDeviceTools().has(pin));
    build.deviceToolLocks = await deviceToolLocks(tools, { pinJson: approvedPin(), nativeAssets: readNativeAssets() });
    let stripped = reportingDrift(onDrift, () => strip({ sha, build }));
    progress(20);
    const opts = { cwd: WORK, env: buildEnv() };
    await installDependencies(opts, sha);
    progress(40);
    stripped = reportingDrift(onDrift, () => typecheckOrLeaveOut({ sha, build, stripped, opts }));
    if (stripped.drift) onDrift(stripped.drift);
    progress(50);
    const stageLocks = await packageApp(version, platform, opts, stages);
    progress(70);
    scanDist();
    const artifact = collect(stages.findArtifact());
    scanArtifact(platform, artifact);
    progress(80);
    await smokeTest();
    progress(90);
    pruneStore();
    return { artifact, skipped: [...stripped.skipped.keys()], stageLocks };
  } finally {
    stages.cleanup();
  }
}

/**
 * Re-resolves the checkout's lockfile (default WORK) for its pnpm-workspace.yaml as
 * stripped (security overrides included) without installing anything: lockfile
 * only, no lifecycle scripts. Returns the resolved pnpm-lock.yaml text.
 */
export function resolveLockfile(opts = { cwd: WORK, env: buildEnv() }) {
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile", "--no-trust-lockfile"], opts);
  return fs.readFileSync(path.join(opts.cwd, "pnpm-lock.yaml"), "utf8");
}

/**
 * pnpm install. With security overrides (lib/overrides.json) the lockfile must be
 * re-resolved first, with nothing installed and no scripts run; every overridden
 * version must be gone from the result, and any other version it added must be
 * at least MIN_AGE_DAYS old (lib/resolution.mjs). Only then is it installed,
 * frozen, once all it installs from the checkout is what commit `sha` has there.
 */
async function installDependencies(opts, sha) {
  const overrides = readOverrides();
  log("installing dependencies");
  if (overrides.length) {
    const baseText = fs.readFileSync(path.join(opts.cwd, "pnpm-lock.yaml"), "utf8");
    const { added } = await checkResolution(baseText, resolveLockfile(opts), { overrides, what: "the security-override resolution" });
    log(`security overrides applied: ${overrides.length} replaced, ${added.length} other version(s) added, all at least ${MIN_AGE_DAYS} days old`);
  }
  // Workspace projects, links and file: packages install from the checkout: each must be
  // something the pinned commit tracks, nothing else (SUPPLY3-04, SUPPLY4-01).
  const tree = trackedTree(mirrorOut(["ls-tree", "-r", "-t", "-z", sha], { dir: opts.cwd }, `listing ${sha.slice(0, 10)}'s files`));
  checkLinksInTree(fs.readFileSync(path.join(opts.cwd, "pnpm-lock.yaml"), "utf8"), opts.cwd, tree);
  run("pnpm", ["install", "--frozen-lockfile", "--no-trust-lockfile"], opts);
}

function reportingDrift(onDrift, step) {
  try {
    return step();
  } catch (error) {
    if (error instanceof StrictDrift && error.drift) onDrift(error.drift);
    throw error;
  }
}

/**
 * Dry run: checkout and strip only. Returns { ok, message, skipped, drift };
 * `ok` is false when a strict rule or a new host would stop the update.
 */
export function checkRules(ref, { baseline = null } = {}) {
  if (IS_BUILDER) verifySnapshot();
  log(`checking strip rules against ${ref}`);
  checkoutWork(ref);
  const sha = mirrorOut(["rev-parse", "HEAD"], { dir: WORK });
  try {
    const { skipped, drift } = strip({ sha, baseline, version: /^v\d/.test(ref) ? ref.slice(1) : null });
    log(skipped.size ? `rules apply, leaving out: ${[...skipped.keys()].join(", ")}` : "all rules apply cleanly");
    return { ok: true, sha, skipped: [...skipped.keys()], drift };
  } catch (error) {
    if (!(error instanceof StrictDrift)) throw error;
    log(error.message);
    return { ok: false, sha, message: error.message, skipped: [], drift: error.drift };
  }
}
