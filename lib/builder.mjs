// Runs the upstream half of an update (fetch, build, smoke test) as the
// unprivileged BUILDER_USER, so dependency install and build scripts can't read
// your home, keys or credentials. install.sh creates the account and a sudo rule,
// "<you> ALL=(_t3blackout) NOPASSWD: ALL", which only lets you act as the
// less-privileged account, never the reverse.
//
// The account can't read your clone, so each run gets a fresh copy of bin/, lib/
// and pin.json. What comes back is an unsigned app in OUT, which you sign and install.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { parseEvent } from "./events.mjs";
import { PIN_FILE, validatePin } from "./pin.mjs";
import { BUILDER_HOME, BUILDER_USER, LAUNCHER, ROOT, STATE, readJson, stableNodePath } from "./util.mjs";

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

/** Beside the copied code: the upstream commit it was copied to build, and the pin.json it carries. */
export const SNAPSHOT_FILE = "snapshot.json";

const digest = (text) => createHash("sha256").update(text).digest("hex");

/**
 * What the build account unpacks as its code: bin/, lib/ and pin.json, whose
 * device tool approvals its build checks upstream's pins against. pin.json is
 * read once and validated, and those bytes are what ship, named (sha-256) in
 * snapshot.json with `sha`, the upstream commit chosen for this build.
 */
export function snapshotArchive({ root = ROOT, sha = null } = {}) {
  const pinFile = path.join(root, PIN_FILE);
  const pin = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, "utf8") : null;
  const parsed = pin === null ? null : validatePin(JSON.parse(pin));
  const pinnedBy = (sha && Object.entries(parsed?.channels ?? {}).find(([, entry]) => entry.sha === sha)?.[0]) || null;
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-snapshot-"));
  try {
    if (pin !== null) fs.writeFileSync(path.join(extra, PIN_FILE), pin);
    fs.writeFileSync(path.join(extra, SNAPSHOT_FILE), `${JSON.stringify({ sha, pin: pin === null ? null : digest(pin), pinnedBy })}\n`);
    const files = [...(pin === null ? [] : [PIN_FILE]), SNAPSHOT_FILE];
    const tar = spawnSync("tar", ["-C", root, "-cf", "-", "bin", "lib", "-C", extra, ...files], { maxBuffer: 64 << 20 });
    if (tar.status !== 0) throw new Error(`couldn't package bin/, lib/ and pin.json: ${tar.stderr}`);
    return tar.stdout;
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
  }
}

/**
 * In the build account: throws unless its code is the snapshot made for this
 * run, i.e. for upstream `sha` (when given) and still carrying the pin.json
 * that was validated and sent. Returns snapshot.json.
 */
export function verifySnapshot({ root = ROOT, sha = null } = {}) {
  const snapshot = readJson(path.join(root, SNAPSHOT_FILE), null);
  if (!snapshot) throw new Error(`the build account's code has no ${SNAPSHOT_FILE}; rerun the update`);
  if (sha && snapshot.sha !== sha) throw new Error(`the build account's code was copied to build ${snapshot.sha ?? "nothing in particular"}, not ${sha}`);
  const pinFile = path.join(root, PIN_FILE);
  const pin = fs.existsSync(pinFile) ? digest(fs.readFileSync(pinFile, "utf8")) : null;
  if (pin !== snapshot.pin) throw new Error(`the build account's ${PIN_FILE} isn't the one it was sent`);
  return snapshot;
}

function syncCode(sha) {
  const archive = snapshotArchive({ sha });
  const install = 'rm -rf "$1/code.new" && mkdir -p "$1/code.new" "$1/tmp" && tar -C "$1/code.new" -xf - && rm -rf "$1/code" && mv "$1/code.new" "$1/code"';
  const result = asBuilder(["/bin/sh", "-c", install, "sh", BUILDER_HOME], { input: archive });
  if (result.status !== 0) throw new Error(`couldn't copy the code to ${BUILDER_USER}: ${result.stderr}`);
}

/** What the app's update button runs; the build bakes it into BlackoutUpdater.ts. */
const appUpdaterEnv = () => ({
  T3BLACKOUT_APP_NODE: stableNodePath(),
  T3BLACKOUT_APP_LAUNCHER: LAUNCHER,
  T3BLACKOUT_APP_PATH: process.env.PATH ?? "/usr/bin:/bin",
});

/**
 * Runs `t3blackout <args> --json` as the build account; resolves when it exits
 * cleanly. A `--ref` that is a full commit id (build-artifact) is what the copied
 * code is bound to.
 */
export function runAsBuilder(args, { onEvent = () => {} } = {}) {
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : null;
  syncCode(/^[0-9a-f]{40}$/.test(ref ?? "") ? ref : null);
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
