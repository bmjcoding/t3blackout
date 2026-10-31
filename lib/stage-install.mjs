// The packager's staged production install (lib/build.mjs packageApp). Upstream
// stages the app with `vp install --prod` from a package.json it writes and no
// lockfile: left alone, pnpm would pick whatever the ranges allow (a version
// published an hour ago, never in the evaluated lockfile) and run its install
// scripts. A strict rule (desktop/stage-install-guarded) replaces both of
// upstream's calls with this file's guard, run explicitly before anything is
// installed: resolved with scripts off and a MIN_AGE_DAYS minimum release age
// (versions the verified lockfile already has are exempt), checked
// (lib/resolution.mjs), then installed frozen from that lockfile.
//
// vp, pnpm, npm and yarn on the packager's PATH are shims: any command aimed at
// the build's private temp folder (by working directory, a destination option or
// a destination setting) is refused unless it only reads what's installed (pnpm
// or npm list/why, or a version); everything else runs the real tool. A tool
// started by absolute path gets past the shims, so after the packager is done
// verifyStageInstalls checks every staged node_modules against the record the
// guard made: same package.json, workspace config and lockfile, and the same
// files, byte for byte, that pnpm installed from the checked lockfile (a name
// and version say nothing about the bytes behind them).
//
//   node lib/stage-install.mjs guard install --prod   (the rule's call, in the stage)
//   node lib/stage-install.mjs <tool> <args...>        (a shim)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MIN_AGE_DAYS, lockPackages } from "./gates.mjs";
import { parseLockfile } from "./lockfile.mjs";
import { checkResolution, localSources } from "./resolution.mjs";

export const SHIMMED = ["vp", "pnpm", "npm", "yarn"];

/** The packager's staged install, exactly (scripts/build-desktop-artifact.ts STAGE_INSTALL_ARGS). */
const STAGE_INSTALL = ["install", "--prod"];

/**
 * All a package manager may do in the stage: read what's installed (electron-builder
 * lists the stage's dependencies), or print its version. Anything else (an alias, an
 * implicit script, `yarn` alone, which installs) is refused.
 */
const READ_ONLY = { pnpm: ["list", "ls", "ll", "la", "why"], npm: ["list", "ls", "ll", "la", "why", "explain"], vp: [], yarn: [] };
const VERSION = ["--version", "-v"];

/** npm/pnpm settings that point an install somewhere, read from the environment too. */
const DESTINATION_ENV = /^npm_config_(?:prefix|dir|cwd|global_dir|modules_dir|lockfile_dir|virtual_store_dir)$/i;

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/** `dir`'s real path, or its resolved path when it doesn't exist (yet). */
const real = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** Whether `dir` (resolved from `cwd`) is `root` or inside it. */
const inside = (root, dir, cwd = process.cwd()) => {
  const full = real(path.resolve(cwd, dir));
  return full === root || full.startsWith(root + path.sep);
};

/** The first `name` on `PATH` outside `skip`, or null. */
export function findOnPath(name, pathValue, skip) {
  for (const dir of (pathValue ?? "").split(":")) {
    if (!dir || path.resolve(dir) === path.resolve(skip)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Writes the shims into `dir` and returns the env the packager runs with: PATH
 * leading with them, the guard command the rule runs (T3BLACKOUT_STAGE_GUARD),
 * and where the real tools, the stage folder, the verified lockfile and the
 * install record are. `stageRoot`: the build's private TMPDIR.
 */
export function shimEnv({ dir, env, stageRoot, verifiedLock, record, node = process.execPath }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = fileURLToPath(import.meta.url);
  const realTools = {};
  for (const tool of SHIMMED) {
    realTools[`T3BLACKOUT_REAL_${tool.toUpperCase()}`] = findOnPath(tool, env.PATH, dir) ?? "";
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} ${tool} "$@"\n`, { mode: 0o755 });
  }
  return {
    ...env,
    ...realTools,
    PATH: `${dir}:${env.PATH ?? ""}`,
    T3BLACKOUT_STAGE_GUARD: JSON.stringify([node, script, "guard"]),
    T3BLACKOUT_SHIM_DIR: dir,
    T3BLACKOUT_STAGE_ROOT: stageRoot,
    T3BLACKOUT_VERIFIED_LOCK: verifiedLock,
    T3BLACKOUT_STAGE_RECORD: record,
  };
}

/**
 * What `tool args` (from `cwd`, with `env`) is: "refuse" when it's aimed at the
 * stage, by working directory, a destination option's value before `--` or a
 * destination setting in the environment, and isn't READ_ONLY's command first
 * or a lone version flag; else "pass".
 */
export function classify(tool, args, cwd, stageRoot, env = {}) {
  const root = real(stageRoot);
  const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
  const values = options.flatMap((arg) => (arg.startsWith("-") && arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [arg]));
  // Every value is tried as a path from cwd: a bare word only lands in the stage when cwd is in it already.
  const aimed =
    inside(root, cwd) ||
    values.some((value) => inside(root, value, cwd)) ||
    Object.entries(env).some(([key, value]) => DESTINATION_ENV.test(key) && value && inside(root, value, cwd));
  const readOnly = (READ_ONLY[tool] ?? []).includes(args[0]) || (args.length === 1 && VERSION.includes(args[0]));
  return aimed && !readOnly ? "refuse" : "pass";
}

/**
 * The pnpm-workspace.yaml lines that hold the resolution to MIN_AGE_DAYS,
 * strictly, exempting the exact versions in `verified` (name@version): the
 * evaluator or WORK's own check already cleared those, fast-laned fixes included.
 */
export function releaseAgeConfig(verified, minDays = MIN_AGE_DAYS) {
  const byName = new Map();
  for (const pkg of verified) {
    const at = pkg.lastIndexOf("@");
    byName.set(pkg.slice(0, at), [...(byName.get(pkg.slice(0, at)) ?? []), pkg.slice(at + 1)]);
  }
  const exclude = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, versions]) => `  - ${JSON.stringify(`${name}@${versions.join(" || ")}`)}`);
  return [
    "",
    "# t3blackout (lib/stage-install.mjs): nothing younger than the minimum age but versions already checked.",
    `minimumReleaseAge: ${Math.ceil(minDays * 1440)}`,
    "minimumReleaseAgeStrict: true",
    ...(exclude.length ? ["minimumReleaseAgeExclude:", ...exclude] : []),
    "",
  ].join("\n");
}

/** What a staged install is bound to: the SHA-256 of its package.json, pnpm-workspace.yaml and pnpm-lock.yaml. */
export function stageDigest(dir) {
  const hash = createHash("sha256");
  for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    const file = path.join(dir, name);
    hash.update(`${name}\0${fs.existsSync(file) ? fs.readFileSync(file) : "(none)"}\0`);
  }
  return hash.digest("hex");
}

/**
 * Everything in `dir`/node_modules, by path below it: "dir", "link <target>",
 * "file <mode> <sha256>" or "other". The guard records it right after pnpm has
 * installed the checked lockfile (verifying each package's integrity), so the
 * build can tell afterwards whether those exact bytes are still what's staged.
 */
export function stageContents(dir) {
  const entries = Object.create(null);
  const walk = (full, rel) => {
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const at = path.join(full, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        entries[key] = `link ${fs.readlinkSync(at)}`;
      } else if (entry.isDirectory()) {
        entries[key] = "dir";
        walk(at, key);
      } else if (entry.isFile()) {
        entries[key] = `file ${(fs.lstatSync(at).mode & 0o777).toString(8)} ${createHash("sha256").update(fs.readFileSync(at)).digest("hex")}`;
      } else {
        entries[key] = "other";
      }
    }
  };
  if (fs.existsSync(path.join(dir, "node_modules"))) walk(path.join(dir, "node_modules"), "");
  return entries;
}

/**
 * Where packaging itself adds files to a stage (`before`: its stageContents):
 * electron-builder rebuilds each native package (one with a binding.gyp) for
 * Electron, writing its build/ folder, and node-gyp's scratch files for the
 * package's dependencies in new folders named like `node-addon-api@7.1.1`
 * somewhere in the package's pnpm store entry (beside the package or inside it,
 * run to run). As [{ build, scope }].
 */
function rebuildAreas(before) {
  const areas = [];
  for (const key of Object.keys(before)) {
    const pkg = path.posix.dirname(key);
    if (path.posix.basename(key) !== "binding.gyp" || !Object.hasOwn(before, `${pkg}/package.json`)) continue;
    areas.push({ build: `${pkg}/build`, scope: /^(\.pnpm\/[^/]+)\/node_modules\//.exec(pkg)?.[1] ?? pkg });
  }
  return areas;
}

/**
 * What differs between the staged node_modules the guard recorded (`before`) and
 * what's there now (`after`), both stageContents, other than what packaging
 * does: upstream copying a platform binary (*.node) it installed beside its
 * loader, and rebuildAreas: anything in a native package's build/, or in a new
 * name@version folder in its scope (no require() resolves through one; a new
 * node_modules or file beside existing code is a change). Every recorded entry
 * must still be there unchanged. Returns the paths, sorted.
 */
export function stageChanges(before, after) {
  const installed = new Set(Object.values(before).filter((value) => value.startsWith("file ")).map((value) => value.split(" ")[2]));
  const areas = rebuildAreas(before);
  const under = (key, dir) => key === dir || key.startsWith(`${dir}/`);
  // The first folder on the way from `scope` to `key` that the guard didn't record.
  const newRoot = (key, scope) => {
    const parts = key.split("/");
    for (let n = scope.split("/").length + 1; n <= parts.length; n++) if (!Object.hasOwn(before, parts.slice(0, n).join("/"))) return parts[n - 1];
    return null;
  };
  const scratch = (key, scope) => under(key, scope) && /^[^/]+@\d[^/]*$/.test(newRoot(key, scope) ?? "");
  const packaging = (key, value) =>
    (value.startsWith("file ") && key.endsWith(".node") && installed.has(value.split(" ")[2])) ||
    ((value === "dir" || value.startsWith("file ")) && areas.some(({ build, scope }) => under(key, build) || scratch(key, scope)));
  const changed = Object.keys(before).filter((key) => !Object.hasOwn(after, key) || after[key] !== before[key]);
  const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key) && !packaging(key, after[key]));
  return [...changed, ...added].sort();
}

/** Runs the real `tool` (`file`, found when the shims were written). */
function runReal(tool, file, args, opts) {
  if (!file) throw new Error(`no ${tool} on PATH`);
  return spawnSync(file, args, { stdio: "inherit", ...opts });
}

/** The install records so far, as [{ dir, digest, packages, added, lock, files }]. */
export const readStageRecords = (record) =>
  fs.existsSync(record)
    ? fs
        .readFileSync(record, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

/** Resolves, checks and installs the staged production dependencies in `dir`. */
export async function guardedInstall(dir, env = process.env) {
  const root = real(env.T3BLACKOUT_STAGE_ROOT ?? "/nonexistent");
  if (!inside(root, dir)) throw new Error(`the staged install in ${dir} isn't in the build's private temp folder`);
  if (readStageRecords(env.T3BLACKOUT_STAGE_RECORD).some((done) => done.dir === real(dir))) throw new Error(`${dir} was already installed once; upstream changed how it stages the app`);
  if (fs.existsSync(path.join(dir, "node_modules")) || fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) throw new Error(`${dir} already has dependencies or a lockfile before its checked install`);
  const yaml = path.join(dir, "pnpm-workspace.yaml");
  const config = fs.existsSync(yaml) ? fs.readFileSync(yaml, "utf8") : "";
  // Settings that would loosen the check: upstream setting them itself means it changed how it stages.
  const loosening = /^(?:minimumReleaseAge\w*|trustLockfile|ignoreScripts|dangerouslyAllowAllBuilds|registry|registries)\s*:/m.exec(config);
  if (loosening) throw new Error(`upstream's staged pnpm-workspace.yaml now sets ${loosening[0].replace(/\s*:$/, "")}; update lib/stage-install.mjs`);
  const verified = fs.readFileSync(env.T3BLACKOUT_VERIFIED_LOCK, "utf8");
  fs.writeFileSync(yaml, `${config.replace(/\n*$/, "\n")}${releaseAgeConfig(lockPackages(verified))}`);
  // The real vp, and whatever it runs, without these shims in the way.
  const childEnv = { ...env, PATH: (env.PATH ?? "").split(":").filter((p) => path.resolve(p) !== path.resolve(env.T3BLACKOUT_SHIM_DIR)).join(":") };
  const vp = env.T3BLACKOUT_REAL_VP;
  const step = (args, what) => {
    const result = runReal("vp", vp, args, { cwd: dir, env: childEnv });
    if (result.status !== 0) throw new Error(`${what} failed (${result.status ?? result.signal})`);
  };
  step(["install", "--prod", "--lockfile-only", "--ignore-scripts"], "resolving the staged production install");
  const lock = fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8");
  const { packages, added } = await checkResolution(verified, lock, { what: "the staged production install" });
  // The stage is the packager's scratch folder, no commit's tree: nothing may install from it (SUPPLY4-01).
  const local = localSources(parseLockfile(lock)).filter(({ where }) => where !== ".");
  if (local.length) throw new Error(`the staged production install would install ${local.map(({ what }) => what).join(", ")} from the stage itself, which no check covers`);
  step(["install", "--prod", "--frozen-lockfile"], "installing the checked staged lockfile");
  if (fs.readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8") !== lock) throw new Error(`installing ${dir} changed the lockfile it checked`);
  const digest = stageDigest(dir);
  fs.appendFileSync(env.T3BLACKOUT_STAGE_RECORD, `${JSON.stringify({ dir: real(dir), digest, packages: packages.size, added, lock, files: stageContents(dir) })}\n`);
  console.log(`t3blackout: staged production install checked: ${packages.size} packages, ${added.length} not in the verified lockfile, all at least ${MIN_AGE_DAYS} days old`);
}

/**
 * Each package installed under `dir`/node_modules, as name@version, read from
 * the package.json of every real (not symlinked) package folder: top level,
 * nested, and in pnpm's .pnpm store. A package's bundled dependencies came in
 * its own tarball and aren't counted. Throws on a package folder it can't read.
 */
export function installedPackages(dir) {
  const found = new Set();
  const isDir = (full) => {
    try {
      return fs.lstatSync(full).isDirectory();
    } catch (error) {
      // Gone, or under a file (.pnpm/lock.yaml/node_modules).
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  };
  const visitModules = (modules, skip = new Set()) => {
    for (const name of fs.readdirSync(modules)) {
      const full = path.join(modules, name);
      if (name === ".pnpm") {
        for (const id of fs.readdirSync(full)) if (isDir(path.join(full, id, "node_modules"))) visitModules(path.join(full, id, "node_modules"));
      } else if (name.startsWith(".") || skip.has(name) || !isDir(full)) {
        continue;
      } else if (name.startsWith("@")) {
        for (const scoped of fs.readdirSync(full)) if (!skip.has(`${name}/${scoped}`) && isDir(path.join(full, scoped))) visitPackage(path.join(full, scoped));
      } else {
        visitPackage(full);
      }
    }
  };
  const visitPackage = (full) => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(full, "package.json"), "utf8"));
    } catch {
      throw new Error(`${full} is in node_modules without a readable package.json`);
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error(`${full}/package.json has no name and version`);
    found.add(`${manifest.name}@${manifest.version}`);
    const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
    if (isDir(path.join(full, "node_modules"))) visitModules(path.join(full, "node_modules"), new Set(Array.isArray(bundled) ? bundled : bundled === true ? Object.keys(manifest.dependencies ?? {}) : []));
  };
  if (isDir(path.join(dir, "node_modules"))) visitModules(path.join(dir, "node_modules"));
  return found;
}

/** The shim's (or the guard's) entry point: returns the exit code (or throws a signal's name). */
export async function main(tool, args, { cwd = process.cwd(), env = process.env } = {}) {
  if (tool === "guard") {
    if (args.length !== STAGE_INSTALL.length || args.some((arg, i) => arg !== STAGE_INSTALL[i])) throw new Error(`the guard runs \`vp ${STAGE_INSTALL.join(" ")}\` only, not \`${args.join(" ")}\`; update lib/stage-install.mjs`);
    await guardedInstall(cwd, env);
    return 0;
  }
  if (!SHIMMED.includes(tool)) throw new Error(`no shim for ${tool}`);
  if (classify(tool, args, cwd, env.T3BLACKOUT_STAGE_ROOT ?? "/nonexistent", env) === "refuse") {
    console.error(`Error: t3blackout refused \`${tool} ${args.join(" ")}\` in the packager's stage: its only install is the checked one (lib/stage-install.mjs). Upstream changed how it stages the app; update lib/stage-install.mjs and the rule desktop/stage-install-guarded.`);
    return 1;
  }
  const result = runReal(tool, env[`T3BLACKOUT_REAL_${tool.toUpperCase()}`], args, { env });
  if (result.error) throw result.error;
  if (result.signal) throw Object.assign(new Error(`${tool} was killed by ${result.signal}`), { signal: result.signal });
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [tool, ...args] = process.argv.slice(2);
  main(tool, args).then(
    (code) => process.exit(code),
    (error) => {
      if (error.signal) process.kill(process.pid, error.signal);
      console.error(`Error: t3blackout: ${error.message}`);
      process.exit(1);
    },
  );
}
