// The build half of an update: checkout, strip, build, scan, smoke test. Runs as
// the build account when there is one (lib/builder.mjs), otherwise as you. The
// result is an unsigned app in OUT; signing and installing happen as you.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { collectDrift, driftSummary, renderDriftReport } from "./drift.mjs";
import { progress } from "./events.mjs";
import { featureIndex, skipDependents } from "./features.mjs";
import { forbiddenInBuild, makeRules } from "./rules.mjs";
import { smokeTest } from "./smoke.mjs";
import { applyRules, findHosts, scanForbidden } from "./strip-engine.mjs";
import { previousTag, upstreamWebUrl } from "./upstream.mjs";
import { IS_BUILDER, LAUNCHER, MIRROR, OUT, STATE, WORK, copyTree, gitMirror, log, run, runTail, stableNodePath } from "./util.mjs";

/** Whether WORK is a checkout of the current mirror (it moves when the build account is set up). */
function workBelongsToMirror() {
  if (!fs.existsSync(path.join(WORK, ".git"))) return false;
  const common = spawnSync("git", ["-C", WORK, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return common.status === 0 && fs.existsSync(path.join(MIRROR, ".git")) && common.stdout.trim() === fs.realpathSync(path.join(MIRROR, ".git"));
}

export function checkoutWork(ref) {
  if (workBelongsToMirror()) {
    // Reuse the checkout and its node_modules: deleting them took most of a
    // minute, and `pnpm install --frozen-lockfile` brings node_modules back in
    // line with the new lockfile. Everything else, build output included, goes.
    run("git", ["-C", WORK, "checkout", "--quiet", "--force", "--detach", ref]);
    run("git", ["-C", WORK, "clean", "-fdxq", "-e", "node_modules"]);
  } else {
    fs.rmSync(WORK, { recursive: true, force: true });
    run("git", gitMirror(["worktree", "prune"]));
    run("git", gitMirror(["worktree", "add", "--quiet", "--detach", WORK, ref]));
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

/** Hosts upstream's source names that lib/known-hosts.txt doesn't, with where each first appears. */
function unknownHosts() {
  const known = new Set(
    fs
      .readFileSync(KNOWN_HOSTS, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean),
  );
  return [...findHosts(WORK, HOST_SCAN_DIRS)].filter(([host]) => !known.has(host));
}

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
    const strict = failures.filter((failure) => !featureOf.has(failure.id));
    for (const failure of failures) {
      const name = featureOf.get(failure.id);
      if (!name) continue;
      if (!skipped.has(name)) skipped.set(name, { reason: "anchor", failures: [] });
      skipped.get(name).failures.push(failure);
    }
    skipDependents(skipped);
    if (strict.length || hosts.length) {
      const reasons = [];
      if (strict.length) reasons.push(`${strict.length} strict rule(s) no longer match upstream`);
      if (hosts.length) reasons.push(`upstream names ${hosts.length} new network host(s)`);
      const lines = [
        `${reasons.join(" and ")}. Nothing was installed.`,
        ...strict.map((failure) => `  - ${failure.message}`),
        ...hosts.map(([host, where]) => `  - new host ${host} (${where})`),
      ];
      if (strict.length) lines.push("Update lib/rules.mjs for the new upstream code, then rerun; `t3blackout drift` shows what upstream changed.");
      if (hosts.length) lines.push("Check what talks to each new host; add a strip rule or list it in lib/known-hosts.txt, then rerun.");
      throw new StrictDrift(lines.join("\n"), strict.length ? describe(strict) : null);
    }
    if (!failures.length) {
      if (skipped.size) log(`left out: ${[...skipped.keys()].join(", ")}`);
      return { skipped, drift, rules, featureOf };
    }
    for (const failure of failures) log(`  leaving out ${featureOf.get(failure.id)}: ${failure.message.split("\n")[0]}`);
  }
}

/** Build-time env: no cloud keys, no publish tokens, nothing inherited by accident. */
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

function buildEnv() {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  // Upstream's build spawns `vp` by name; use the repo's own vite-plus so the
  // machine doesn't need it installed globally.
  env.PATH = [path.join(WORK, "node_modules", ".bin"), process.env.PATH ?? "/usr/bin:/bin"].join(":");
  return {
    ...env,
    CI: "1",
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
    const owners = new Map();
    for (const rule of stripped.rules) {
      const name = stripped.featureOf.get(rule.id);
      if (name && !stripped.skipped.has(name) && rule.file) owners.set(rule.file, [...(owners.get(rule.file) ?? []), name]);
    }
    const blamed = errors.filter((error) => owners.has(error.file));
    if (!blamed.length || attempt > 3) {
      throw new Error(
        [
          `the app doesn't typecheck against upstream (${errors.length} error(s)). Nothing was installed.`,
          ...errors.slice(0, 15).map((error) => `  - ${error.file}(${error.line}): ${error.message}`),
        ].join("\n"),
      );
    }
    for (const error of blamed) {
      for (const name of owners.get(error.file)) {
        if (!stripped.skipped.has(name)) stripped.skipped.set(name, { reason: "compile", errors: [] });
        stripped.skipped.get(name).errors?.push(error);
      }
    }
    skipDependents(stripped.skipped);
    for (const error of blamed) log(`  leaving out ${owners.get(error.file).join(", ")}: ${error.file}(${error.line}): ${error.message}`);
    checkoutWork(sha);
    stripped = strip({ sha, build, skipped: stripped.skipped });
  }
}

function packageApp(version, platform, opts) {
  log(`building desktop app ${version} (${platform.name}, unsigned)`);
  return runTail(process.execPath, ["scripts/build-desktop-artifact.ts", ...platform.buildArgs(), "--build-version", version], opts, "building the app");
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
 * out, or what stopped the build.
 */
export async function buildArtifact({ sha, version, platform, changes, baseline = null, baselines = {}, onDrift = () => {} }) {
  const stages = platform.beginBuild();
  const build = { version, changes, baseline, baselines };
  try {
    checkoutWork(sha);
    let stripped = reportingDrift(onDrift, () => strip({ sha, build }));
    progress(20);
    const opts = { cwd: WORK, env: buildEnv() };
    log("installing dependencies");
    run("pnpm", ["install", "--frozen-lockfile"], opts);
    progress(40);
    stripped = reportingDrift(onDrift, () => typecheckOrLeaveOut({ sha, build, stripped, opts }));
    if (stripped.drift) onDrift(stripped.drift);
    progress(50);
    await packageApp(version, platform, opts);
    progress(70);
    scanDist();
    const artifact = collect(stages.findArtifact());
    progress(80);
    await smokeTest();
    progress(90);
    pruneStore();
    return { artifact, skipped: [...stripped.skipped.keys()] };
  } finally {
    stages.cleanup();
  }
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
  log(`checking strip rules against ${ref}`);
  checkoutWork(ref);
  const sha = spawnSync("git", ["-C", WORK, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
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
