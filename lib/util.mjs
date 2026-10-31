// Paths and small helpers shared by the CLI and the platform modules.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { DEADLINES, UPSTREAM_URL, gitFailure, publicGit } from "./git.mjs";

// fileURLToPath, not URL.pathname: that stays percent-encoded (a clone path with a space).
export const ROOT = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
export const LAUNCHER = path.join(ROOT, "bin", "t3blackout");
export const T3B_HOME = process.env.T3BLACKOUT_HOME ?? path.join(os.homedir(), ".t3blackout");

// Upstream is fetched and built by a separate, unprivileged account when
// install.sh has set one up (lib/builder.mjs), so dependency install and build
// scripts never run as you. Without it, everything runs as you under build/.
export const BUILDER_USER = "_t3blackout";
export const BUILDER_HOME = process.platform === "darwin" ? "/private/var/t3blackout-build" : "/var/lib/t3blackout-build";
export const BUILDER_MARKER = path.join(BUILDER_HOME, ".t3blackout-builder");
export const IS_BUILDER = process.env.T3BLACKOUT_ROLE === "builder";
export const USE_BUILDER = !IS_BUILDER && fs.existsSync(BUILDER_MARKER);
const DATA = IS_BUILDER || USE_BUILDER ? BUILDER_HOME : path.join(ROOT, "build");
export const MIRROR = path.join(DATA, "upstream");
export const WORK = path.join(DATA, "work");
/** The finished, unsigned app the build hands over for signing and install. */
export const OUT = path.join(DATA, "out");
export const STATE = IS_BUILDER ? path.join(BUILDER_HOME, "state") : path.join(ROOT, "state");
/**
 * Where a T3 Blackout server on this machine drops a marker to ask for an update
 * (rule server/self-update-requests-host-build): "Update everything" from a
 * desktop reaching this host over SSH. The scheduled updater's launchd job
 * watches it (macOS).
 */
export const UPDATE_REQUESTS =
  process.env.T3BLACKOUT_UPDATE_REQUESTS ??
  (process.platform === "darwin" ? "/Users/Shared/t3blackout/update-requests" : "/var/tmp/t3blackout-update-requests");

fs.mkdirSync(STATE, { recursive: true });

export function log(message) {
  const line = `[t3blackout ${new Date().toISOString()}] ${message}`;
  console.log(line);
  // Owner-only: commands and their errors end up here.
  fs.appendFileSync(path.join(STATE, "t3blackout.log"), line + "\n", { mode: 0o600 });
}

/** `text` with every one of `secrets` (non-empty strings) masked, for errors and logs. */
export const redact = (text, secrets = []) =>
  secrets.filter((secret) => typeof secret === "string" && secret).reduce((out, secret) => out.split(secret).join("***"), String(text ?? ""));

/**
 * The command line an error names. `secrets`: values (passwords, tokens) that
 * must never reach an error message or the log, wherever they appear.
 */
const commandLine = (cmd, args, secrets) => redact([cmd, ...args].join(" "), secrets);

/** Runs a command; throws if it fails. `opts.secrets`: see commandLine. */
export function run(cmd, args, { secrets = [], ...opts } = {}) {
  const result = childProcess.spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${commandLine(cmd, args, secrets)} exited with ${result.status ?? result.signal}`);
  }
  return result;
}

/**
 * Like run, streaming the output, but a failure's message leads with the error
 * the output ended on, not just the exit code: `what` failed: <error>.
 */
export function runTail(cmd, args, opts = {}, what = path.basename(cmd)) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const relay = (from, to) =>
      from.on("data", (chunk) => {
        to.write(chunk);
        tail = (tail + chunk).slice(-30_000);
      });
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const lines = tail
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("at ") && !/^[│╭╰─\s]+$/.test(line));
      const errors = lines.filter((line) => /\[[A-Z][A-Z_]+\]|error TS\d+|\berror\b|Error:/i.test(line)).slice(-8);
      const headline = errors.find((line) => /\[[A-Z][A-Z_]+\]|error TS\d+/.test(line)) ?? errors.at(-1) ?? `exited with ${code ?? signal}`;
      reject(new Error([`${what} failed: ${headline}`, ...errors.filter((line) => line !== headline).map((line) => `  ${line}`)].join("\n")));
    });
  });
}

/** A command's trimmed stdout; throws if it fails. `opts.secrets`: see commandLine. */
export function capture(cmd, args, { secrets = [], ...opts } = {}) {
  const result = childProcess.spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) throw new Error(`${commandLine(cmd, args, secrets)}: ${redact(result.stderr ?? result.error?.message, secrets)}`);
  return result.stdout.trim();
}

export const commandExists = (cmd) =>
  childProcess.spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** `which node` (e.g. /opt/homebrew/bin/node) survives upgrades; execPath may be a versioned path. */
export function stableNodePath() {
  const found = childProcess.spawnSync("/bin/sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout?.trim();
  return found && fs.existsSync(found) ? found : process.execPath;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits `ms`, or less when the promise `early` settles first; leaves no timer running either way. */
export const sleepUnless = (ms, early) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    early.then(
      () => (clearTimeout(timer), resolve()),
      () => (clearTimeout(timer), resolve()),
    );
  });

/**
 * Upstream's build leaves the packaged app in $TMPDIR/t3code-desktop-<platform>-stage-*
 * when run with --keep-stage. Each build gets a private TMPDIR (`tmpdir`, mode
 * 0700, which the packager must run with), so every stage directory in it is
 * this build's: never another build's that shares the system's temp folder.
 * `cleanup` removes the whole of it.
 */
export function trackStageDirs(platformName) {
  const prefix = `t3code-desktop-${platformName}-stage-`;
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-build-"));
  const ours = () =>
    fs
      .readdirSync(tmpdir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(tmpdir, name));
  return { tmpdir, ours, cleanup: () => fs.rmSync(tmpdir, { recursive: true, force: true }) };
}

/** Breadth-limited directory search; `match(dirent, fullPath)` selects results. */
export function findPaths(roots, match, { maxDepth = 7 } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (match(entry, full)) found.push(full);
      else if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.endsWith(".app")) {
        walk(full, depth + 1);
      }
    }
  };
  for (const root of roots) if (fs.existsSync(root)) walk(root, 0);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * git against the upstream mirror, or `dir`, a checkout of it, as lib/git.mjs
 * runs git against upstream: no global or system configuration, nothing from
 * the environment, HTTPS only, a deadline. safe.directory: when the build
 * account owns the mirror, you only read it (tags, versions, commit titles),
 * never write. The mirror is blobless, so reading a file's contents (`fetch`)
 * fetches it from upstream: only the mirror's owner does that, after checking
 * the mirror's own configuration still sends it to upstream (lib/git.mjs
 * checkRepoTransport). Every other read has lazy fetching off, so a mirror the
 * build account controls never makes you run or reach anything (HOST3-01).
 * spawnSync's result.
 */
export function mirrorGit(args, { fetch = false, dir = MIRROR, timeout = DEADLINES.read, ...opts } = {}) {
  if (fetch && USE_BUILDER) throw new Error(`reading upstream's files from ${dir} needs the build account ${BUILDER_USER}, which owns it`);
  const base = { url: UPSTREAM_URL, timeout, config: [`safe.directory=${dir}`], ...opts };
  if (!fetch) return publicGit(["--no-lazy-fetch", "-C", dir, ...args], base);
  return publicGit(args, { ...base, repo: dir, remote: "origin" });
}

/** mirrorGit's output, trimmed; throws `what` failed: why. */
export function mirrorOut(args, opts = {}, what = `git ${args[0]} in the upstream mirror`) {
  const timeout = opts.timeout ?? DEADLINES.read;
  const result = mirrorGit(args, { ...opts, timeout });
  if (result.status !== 0) throw new Error(`${what} failed: ${gitFailure(result, timeout)}`);
  return (result.stdout ?? "").trim();
}

/** Copies a directory tree, keeping symlinks, modes and (on macOS) bundle metadata. */
export function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  if (process.platform === "darwin") run("ditto", [from, to]);
  else run("cp", ["-a", from, to]);
}
