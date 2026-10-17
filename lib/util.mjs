// Paths and small helpers shared by the CLI and the platform modules.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export const ROOT = path.dirname(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)));
export const LAUNCHER = path.join(ROOT, "bin", "t3blackout");
export const MIRROR = path.join(ROOT, "upstream");
export const WORK = path.join(ROOT, "build", "work");
export const STATE = path.join(ROOT, "state");
export const T3B_HOME = process.env.T3BLACKOUT_HOME ?? path.join(os.homedir(), ".t3blackout");

fs.mkdirSync(STATE, { recursive: true });

export function log(message) {
  const line = `[t3blackout ${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(path.join(STATE, "t3blackout.log"), line + "\n");
}

export function run(cmd, args, opts = {}) {
  const result = childProcess.spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
  return result;
}

export function capture(cmd, args, opts = {}) {
  const result = childProcess.spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`);
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

/**
 * Upstream's build leaves the packaged app in $TMPDIR/t3code-desktop-<platform>-stage-*
 * when run with --keep-stage. Other builds on the machine may use the same prefix,
 * so only ever touch the directories created after this snapshot.
 */
export function trackStageDirs(platformName) {
  const prefix = `t3code-desktop-${platformName}-stage-`;
  const list = () =>
    fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(os.tmpdir(), name));
  const before = new Set(list());
  const ours = () => list().filter((dir) => !before.has(dir));
  return { ours, cleanup: () => ours().forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })) };
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

/** Fills `__KEY__` placeholders in a template file from this repo. */
export function renderTemplate(relativePath, values) {
  let content = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  for (const [key, value] of Object.entries(values)) content = content.replaceAll(key, value);
  return content;
}
