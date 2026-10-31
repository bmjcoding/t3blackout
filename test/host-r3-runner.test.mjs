// node --test test/: a server's record names the runner while it starts the
// server, then the server (lib/files/ssh-runner-blackout.sh): a reconnect in
// between keeps it, and stops it if its build was replaced, instead of
// deleting the record of a server that then runs untracked (HOST3-04). The
// launch is paused right after the record is published, by a `mv` on PATH that
// waits once it has moved a record into place.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeTemplate } from "../.github/scripts/render-runner.mjs";

const SOURCE = fs.readFileSync(new URL("../lib/files/ssh-runner-blackout.sh", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MV = spawnSync("/bin/sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
const SERVER = `if (process.argv[2] === "serve") setInterval(() => {}, 1000);`;

function host() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-runner-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const app = path.join(dir, "T3 Blackout.app");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  const build = (where) => {
    fs.mkdirSync(path.join(where, "apps", "server", "dist"), { recursive: true });
    fs.writeFileSync(path.join(where, "apps", "server", "dist", "bin.mjs"), SERVER);
  };
  build(asar);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "T3 Blackout"));
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, `#!/bin/sh\nset -eu\n${decodeTemplate(SOURCE)}`, { mode: 0o700 });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh\n${JSON.stringify(MV)} "$@" || exit\ncase "$*" in\n  *ssh-servers*) : >"$HOME/published"; while [ ! -f "$HOME/continue" ]; do sleep 0.05; done ;;\nesac\n`, { mode: 0o700 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, T3BLACKOUT_APP: app, T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "update-requests") };
  const child = spawn(runner, ["serve", "--host", "127.0.0.1", "--port", "1", "--base-dir", path.join(home, ".t3blackout")], { env, stdio: "ignore" });
  const record = path.join(home, ".t3blackout", "ssh-servers", String(child.pid));
  const stopStale = () => spawnSync(runner, ["__blackout-stop-stale-server"], { encoding: "utf8", env, timeout: 30_000 });
  const resume = () => fs.writeFileSync(path.join(home, "continue"), "");
  const newBuild = () => {
    build(`${asar}.next`);
    fs.rmSync(asar, { recursive: true });
    fs.renameSync(`${asar}.next`, asar);
  };
  return { home, runner, child, record, stopStale, resume, newBuild, cleanup: () => (resume(), child.kill("SIGKILL")) };
}

const argsOf = (pid) => spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();
const gone = (child) => child.exitCode !== null || child.signalCode !== null;

async function until(condition, what, ms = 20_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) if (condition()) return;
  assert.fail(`timed out waiting for ${what}`);
}

test("a reconnect while a server starts keeps its record, and the server is stopped once its build is replaced (HOST3-04)", async () => {
  const h = host();
  try {
    await until(() => fs.existsSync(path.join(h.home, "published")), "the record");
    const [, , server, starting] = fs.readFileSync(h.record, "utf8").split("\n");
    assert.equal(starting, argsOf(h.child.pid), "the record names the runner while it starts the server");
    const during = h.stopStale();
    assert.equal(during.status, 0, during.stderr);
    assert.equal(fs.existsSync(h.record), true, "kept: it's this server's");
    assert.equal(gone(h.child), false, "same build: left to start");
    h.resume();
    await until(() => argsOf(h.child.pid) === server, "the exec into the server");
    h.newBuild();
    const after = h.stopStale();
    assert.equal(after.status, 0, after.stderr);
    await until(() => gone(h.child), "the stale server to stop");
    assert.equal(fs.existsSync(h.record), false);
  } finally {
    h.cleanup();
  }
});

test("a runner still starting a build that's been replaced is stopped like its server (HOST3-04)", async () => {
  const h = host();
  try {
    await until(() => fs.existsSync(path.join(h.home, "published")), "the record");
    h.newBuild();
    const stop = h.stopStale();
    assert.equal(stop.status, 0, stop.stderr);
    await until(() => gone(h.child), "the runner to stop");
    assert.equal(fs.existsSync(h.record), false);
  } finally {
    h.cleanup();
  }
});

test("the runner, rendered, is POSIX sh: sh, bash --posix, dash and ShellCheck as CI runs them (HOST3-04)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-runner-lint-"));
  const file = path.join(dir, "runner.sh");
  fs.writeFileSync(file, `#!/bin/sh\n${decodeTemplate(SOURCE)}`);
  const checks = [
    ["sh", ["-n", file]],
    ["bash", ["--posix", "-n", file]],
    ["dash", ["-n", file]],
    ["shellcheck", ["-s", "sh", "-S", "warning", "-e", "SC1090,SC3067", file]],
  ];
  for (const [tool, args] of checks) {
    const result = spawnSync(tool, args, { encoding: "utf8" });
    if (result.error?.code === "ENOENT" && tool !== "sh") continue; // CI runs every one of them
    assert.equal(result.status, 0, `${tool}: ${result.stdout}${result.stderr}`);
  }
});
