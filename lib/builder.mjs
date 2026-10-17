// Runs the upstream half of an update (fetch, build, smoke test) as the
// unprivileged BUILDER_USER, so dependency install and build scripts can't read
// your home, keys or credentials. install.sh creates the account and a sudo rule,
// "<you> ALL=(_t3blackout) NOPASSWD: ALL", which only lets you act as the
// less-privileged account, never the reverse.
//
// The account can't read your clone, so each run gets a fresh copy of bin/ and
// lib/. What comes back is an unsigned app in OUT, which you sign and install.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { parseEvent } from "./events.mjs";
import { BUILDER_HOME, BUILDER_USER, LAUNCHER, ROOT, STATE, stableNodePath } from "./util.mjs";

export const builderReachable = () => spawnSync("sudo", ["-n", "-u", BUILDER_USER, "true"], { stdio: "ignore" }).status === 0;

/** Node, pnpm and Rust the account can run: its own (Linux), or shared ones outside your home (Homebrew). */
function builderPath() {
  const own = ["node/bin", ".local/bin", ".cargo/bin"].map((dir) => path.join(BUILDER_HOME, dir));
  const shared = (process.env.PATH ?? "").split(":").filter((dir) => dir && !dir.startsWith(os.homedir()));
  return [...own, ...shared, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

function builderNode() {
  const own = path.join(BUILDER_HOME, "node", "bin", "node");
  return fs.existsSync(own) ? own : stableNodePath();
}

function asBuilder(command, opts = {}) {
  return spawnSync("sudo", ["-n", "-u", BUILDER_USER, "-H", ...command], { encoding: "utf8", ...opts });
}

function syncCode() {
  const tar = spawnSync("tar", ["-C", ROOT, "-cf", "-", "bin", "lib"], { maxBuffer: 64 << 20 });
  if (tar.status !== 0) throw new Error(`couldn't package bin/ and lib/: ${tar.stderr}`);
  const install = 'rm -rf "$1/code.new" && mkdir -p "$1/code.new" "$1/tmp" && tar -C "$1/code.new" -xf - && rm -rf "$1/code" && mv "$1/code.new" "$1/code"';
  const result = asBuilder(["/bin/sh", "-c", install, "sh", BUILDER_HOME], { input: tar.stdout });
  if (result.status !== 0) throw new Error(`couldn't copy the code to ${BUILDER_USER}: ${result.stderr}`);
}

/** What the app's update button runs; the build bakes it into BlackoutUpdater.ts. */
const appUpdaterEnv = () => ({
  T3BLACKOUT_APP_NODE: stableNodePath(),
  T3BLACKOUT_APP_LAUNCHER: LAUNCHER,
  T3BLACKOUT_APP_PATH: process.env.PATH ?? "/usr/bin:/bin",
});

/** Runs `t3blackout <args> --json` as the build account; resolves when it exits cleanly. */
export function runAsBuilder(args, { onEvent = () => {} } = {}) {
  syncCode();
  const env = {
    PATH: builderPath(),
    HOME: BUILDER_HOME,
    TMPDIR: path.join(BUILDER_HOME, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    T3BLACKOUT_ROLE: "builder",
    ...appUpdaterEnv(),
  };
  const command = [
    "sudo", "-n", "-u", BUILDER_USER, "-H",
    "/usr/bin/env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    builderNode(), path.join(BUILDER_HOME, "code", "bin", "t3blackout"), ...args, "--json",
  ];
  const logFile = path.join(STATE, "t3blackout.log");
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
    let failure = null;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const event = parseEvent(line);
      if (!event) {
        console.log(line);
        if (line.startsWith("[t3blackout ")) fs.appendFileSync(logFile, line.replace("[t3blackout ", "[t3blackout build ") + "\n");
        return;
      }
      if (event.type === "error") failure = event.message;
      onEvent(event);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(failure ?? `the build account's ${args[0]} exited with ${code}`));
    });
  });
}
