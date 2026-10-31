// node --test test/: the SSH runner's server records and stale-server stop
// (lib/files/ssh-runner-blackout.sh, rule ssh/runner-installed-blackout-only),
// with a fake app whose "Electron" is Node itself (a symlink, so ps shows the
// command line the runner exec'd, as it does for the real app) and whose server
// entry is a script: `serve` runs until stopped, or fails at once, or ignores
// SIGTERM, as the test asks.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRules } from "../lib/rules.mjs";

const SOURCE = fs.readFileSync(new URL("../lib/files/ssh-runner-blackout.sh", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rendered = () => `#!/bin/sh\nset -eu\nT3_ARCHIVE_VERSION='9.9.9'\n${new Function(`return \`${SOURCE}\`;`)()}`;

const SERVER = `
if (process.argv[2] === "serve") {
  if (process.env.T3B_FAKE_FAIL) process.exit(3);
  if (process.env.T3B_FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  console.log(process.argv.slice(1).join(" "));
}
`;

/** A home with the runner, and an app whose app.asar is a folder holding the fake server. */
function host() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-runner-")));
  const home = path.join(dir, "home");
  const app = path.join(dir, "T3 Blackout.app");
  const asar = path.join(app, "Contents", "Resources", "app.asar");
  const build = (where) => {
    fs.mkdirSync(path.join(where, "apps", "server", "dist"), { recursive: true });
    fs.writeFileSync(path.join(where, "apps", "server", "dist", "bin.mjs"), SERVER);
  };
  build(asar);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "T3 Blackout"));
  fs.mkdirSync(home, { mode: 0o700 });
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, rendered(), { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_APP: app, T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "t3blackout", "update-requests") };
  const run = (args) => spawnSync(runner, args, { encoding: "utf8", env });
  const servers = [];
  const start = (extra = {}) => {
    const child = spawn(runner, ["serve", "--host", "127.0.0.1", "--port", "1", "--base-dir", path.join(home, ".t3blackout")], { env: { ...env, ...extra }, stdio: "ignore" });
    servers.push(child);
    return child;
  };
  // A new build replaces the whole app.asar, as an install replaces the bundle.
  const newBuild = () => {
    const next = `${asar}.next`;
    build(next);
    fs.rmSync(asar, { recursive: true });
    fs.renameSync(next, asar);
  };
  const records = path.join(home, ".t3blackout", "ssh-servers");
  const cleanup = () => servers.forEach((child) => child.kill("SIGKILL"));
  return { dir, home, app, runner, run, start, newBuild, records, cleanup };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ps = (field, pid) => spawnSync("ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout;
const startedOf = (pid) => ps("lstart", pid).trim().split(/\s+/).join(" ");

async function waitFor(condition, tries = 100) {
  for (let i = 0; i < tries && !condition(); i++) await sleep(50);
  return condition();
}

test("each server keeps its own record: its start time, build and command line", async () => {
  const h = host();
  try {
    const server = h.start();
    const record = path.join(h.records, String(server.pid));
    assert.ok(await waitFor(() => fs.existsSync(record)), "recorded");
    const [started, build, args] = fs.readFileSync(record, "utf8").split("\n");
    assert.equal(started, startedOf(server.pid));
    assert.match(build, /^\d+:\d+:\d+:\d+$/);
    assert.ok(await waitFor(() => ps("args", server.pid).includes(" serve ")), "running as the server");
    assert.equal(args, ps("args", server.pid).trim());
    assert.ok(args.startsWith(`${h.app}/Contents/MacOS/T3 Blackout ${h.app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs serve `));
    assert.equal(fs.statSync(h.records).mode & 0o077, 0, "records are private");
  } finally {
    h.cleanup();
  }
});

test("a failed second start doesn't erase the running server's record; the stale one still stops (HOST2-06)", async () => {
  const h = host();
  try {
    const first = h.start();
    assert.ok(await waitFor(() => fs.existsSync(path.join(h.records, String(first.pid)))));
    const failed = h.start({ T3B_FAKE_FAIL: "1" });
    await new Promise((resolve) => failed.once("exit", resolve));
    assert.ok(fs.existsSync(path.join(h.records, String(first.pid))), "the first server's record is intact");
    // Same build: nothing stops, and the dead start's record is cleared.
    assert.equal(h.run(["__blackout-stop-stale-server"]).status, 0);
    assert.equal(alive(first.pid), true);
    assert.equal(fs.existsSync(path.join(h.records, String(failed.pid))), false);
    h.newBuild();
    const stop = h.run(["__blackout-stop-stale-server"]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(await waitFor(() => first.exitCode !== null || first.signalCode !== null), "stale: stopped");
    assert.deepEqual(fs.readdirSync(h.records), []);
  } finally {
    h.cleanup();
  }
});

test("a stale server that ignores SIGTERM is killed, and its record goes only then (HOST2-07)", async () => {
  const h = host();
  try {
    const server = h.start({ T3B_FAKE_IGNORE_TERM: "1" });
    const record = path.join(h.records, String(server.pid));
    assert.ok(await waitFor(() => fs.existsSync(record)));
    assert.ok(await waitFor(() => ps("args", server.pid).includes(" serve ")));
    await sleep(200); // its SIGTERM handler is in place
    h.newBuild();
    const stop = h.run(["__blackout-stop-stale-server"]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(server.signalCode ?? (await new Promise((resolve) => server.once("exit", (code, signal) => resolve(signal)))), "SIGKILL");
    assert.equal(fs.existsSync(record), false);
  } finally {
    h.cleanup();
  }
});

test("a stale server that can't be stopped keeps its record and fails the connection (HOST2-07)", () => {
  // pid 1 (launchd or init) is a live process this account can't signal: a
  // stand-in for a server that won't exit. Its record matches it exactly.
  const h = host();
  fs.mkdirSync(h.records, { recursive: true, mode: 0o700 });
  const record = path.join(h.records, "1");
  fs.writeFileSync(record, `${startedOf(1)}\nold-build\n${ps("args", 1).trim()}\n`);
  const stop = h.run(["__blackout-stop-stale-server"]);
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /server 1 still runs a build this host has replaced and did not stop/);
  assert.equal(fs.existsSync(record), true, "kept until it's gone");
});

test("a reused pid is never taken for the recorded server (HOST2-14)", async () => {
  const h = host();
  const other = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await waitFor(() => ps("args", other.pid).includes("sleep"));
    fs.mkdirSync(h.records, { recursive: true, mode: 0o700 });
    const record = path.join(h.records, String(other.pid));
    // Same pid and command line, another start time: an earlier process with that pid.
    fs.writeFileSync(record, `Thu Jan  1 00:00:00 1970\nold-build\n${ps("args", other.pid).trim()}\n`);
    assert.equal(h.run(["__blackout-stop-stale-server"]).status, 0);
    // Same pid and start time, another command line (another server's base folder).
    fs.writeFileSync(record, `${startedOf(other.pid)}\nold-build\n${ps("args", other.pid).trim()} --base-dir /elsewhere\n`);
    assert.equal(h.run(["__blackout-stop-stale-server"]).status, 0);
    await sleep(100);
    assert.equal(alive(other.pid), true, "left alone");
    assert.equal(fs.existsSync(record), false, "the record no longer names a server");
  } finally {
    other.kill("SIGKILL");
  }
});

test("the launch rule lets a failed stop end the connection instead of reusing the server", () => {
  const rule = makeRules({ updater: { node: "n", launcher: "l", path: "p" }, build: null }).find((r) => r.id === "ssh/runner-installed-blackout-only");
  const edit = rule.edits.find((e) => typeof e.replace === "string" && e.replace.includes("__blackout-stop-stale-server"));
  assert.equal(edit.replace, '  "$RUNNER_FILE" __blackout-stop-stale-server\n  "$RUNNER_FILE" --version >/dev/null\n');
});
