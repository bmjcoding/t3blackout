// node --test test/: what runs the CLI later (lib/platform/jobs.mjs) and the
// install's saved locations (lib/install-config.mjs).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyInstallConfig, readInstallConfig, saveInstallConfig } from "../lib/install-config.mjs";
import { cliShim, launchdUpdateJob, parseSchedule, systemdArg, systemdEnv, systemdUpdateUnits } from "../lib/platform/jobs.mjs";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-jobs-")));
const isMac = process.platform === "darwin";

const job = (extra = {}) =>
  launchdUpdateJob({
    label: "dev.t3blackout.update",
    node: "/opt/R&D <tools>/bin/node",
    launcher: "/Users/me/R&D's \"clone\"/bin/t3blackout",
    pathEnv: "/opt/R&D <tools>/bin:/usr/bin:/bin",
    state: "/Users/me/R&D/state",
    requests: "/Users/Shared/t3blackout/update-requests",
    hour: 4,
    weekday: "hourly",
    ...extra,
  });

/** The plist as JSON, through macOS's own parser. */
function parsePlist(text) {
  const file = path.join(tmp(), "job.plist");
  fs.writeFileSync(file, text);
  const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  return JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);
}

test("the launchd job keeps paths with XML characters intact", { skip: !isMac && "plutil is macOS's" }, () => {
  const parsed = parsePlist(job());
  assert.deepEqual(parsed.ProgramArguments, ["/opt/R&D <tools>/bin/node", "/Users/me/R&D's \"clone\"/bin/t3blackout", "update"]);
  assert.equal(parsed.EnvironmentVariables.PATH, "/opt/R&D <tools>/bin:/usr/bin:/bin");
  assert.equal(parsed.StartInterval, 3600);
  assert.deepEqual(parsed.WatchPaths, ["/Users/Shared/t3blackout/update-requests"]);
  assert.equal(parsed.StandardOutPath, "/Users/me/R&D/state/update.out.log");
  assert.equal(parsed.UserName, undefined);
});

test("the host role's job is a daemon that runs as you, with no login", { skip: !isMac && "plutil is macOS's" }, () => {
  const parsed = parsePlist(job({ weekday: 1, hour: 6, daemon: { user: "me", home: "/Users/me" } }));
  assert.equal(parsed.UserName, "me");
  assert.equal(parsed.InitGroups, true);
  assert.deepEqual(parsed.StartCalendarInterval, { Weekday: 1, Hour: 6, Minute: 0 });
  assert.equal(parsed.EnvironmentVariables.HOME, "/Users/me");
  assert.equal(parsed.EnvironmentVariables.T3BLACKOUT_HEADLESS, "1");
  assert.equal(parsed.ProcessType, "Background");
  assert.deepEqual(parsePlist(job({ weekday: null, hour: 0 })).StartCalendarInterval, { Hour: 0, Minute: 0 });
});

test("systemd units quote paths and escape specifiers and variables", () => {
  assert.equal(systemdArg('/home/me/R&D 100%/"x"/$HOME\\bin'), '"/home/me/R&D 100%%/\\"x\\"/$$HOME\\\\bin"');
  assert.equal(systemdEnv("PATH", "/a b/%h:/c"), '"PATH=/a b/%%h:/c"');
  assert.throws(() => systemdArg("/a\nb"), /line break/);
  const { service, timer } = systemdUpdateUnits({ node: "/home/me/my node/bin/node", launcher: "/home/me/t3b 100%/bin/t3blackout", pathEnv: "/usr/bin:/bin", hour: 6, weekday: 1 });
  assert.match(service, /^Environment="PATH=\/usr\/bin:\/bin"$/m);
  assert.match(service, /^ExecStart="\/home\/me\/my node\/bin\/node" "\/home\/me\/t3b 100%%\/bin\/t3blackout" update$/m);
  assert.match(timer, /^OnCalendar=Mon \*-\*-\* 06:00:00$/m);
  assert.match(systemdUpdateUnits({ node: "n", launcher: "l", pathEnv: "p", hour: 4, weekday: "hourly" }).timer, /^OnCalendar=hourly$/m);
});

test("the CLI shim runs exactly the clone's path, whatever is in it", () => {
  const dir = tmp();
  const clone = path.join(dir, "$HOME it's `x`");
  fs.mkdirSync(path.join(clone, "bin"), { recursive: true });
  const launcher = path.join(clone, "bin", "t3blackout");
  fs.writeFileSync(launcher, "console.log(JSON.stringify(process.argv.slice(2)))\n");
  const shim = path.join(dir, "shim");
  fs.writeFileSync(shim, cliShim({ node: process.execPath, launcher }), { mode: 0o755 });
  const result = spawnSync(shim, ["status", "a b"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["status", "a b"]);
});

test("schedules take whole hours and known days only", () => {
  assert.deepEqual(parseSchedule({}), { hour: 4, weekday: "hourly" });
  assert.deepEqual(parseSchedule({ day: "daily", hour: "6" }), { hour: 6, weekday: null });
  assert.deepEqual(parseSchedule({ day: "Monday", hour: "23" }), { hour: 23, weekday: 1 });
  for (const bad of [{ hour: "4.5" }, { hour: "24" }, { hour: "-1" }, { hour: "1e1" }, { hour: "" }, { day: "someday" }]) {
    assert.throws(() => parseSchedule(bad), /usage/, JSON.stringify(bad));
  }
});

test("an install's locations apply to every later run, whatever its environment", () => {
  const file = path.join(tmp(), "state", "install.json");
  saveInstallConfig({ role: "ui", env: { T3BLACKOUT_APPS: "/Volumes/Apps", XDG_DATA_HOME: undefined }, file });
  const config = readInstallConfig(file);
  assert.equal(config.role, "ui");
  // A scheduled run: nothing set. A manual one from another shell: set differently.
  const scheduled = {};
  assert.deepEqual(applyInstallConfig(config, scheduled), []);
  assert.equal(scheduled.T3BLACKOUT_APPS, "/Volumes/Apps");
  const manual = { T3BLACKOUT_APPS: "/Applications", XDG_DATA_HOME: "/elsewhere", PATH: "/bin" };
  assert.deepEqual(applyInstallConfig(config, manual).sort(), ["T3BLACKOUT_APPS", "XDG_DATA_HOME"]);
  assert.deepEqual(manual, { T3BLACKOUT_APPS: "/Volumes/Apps", PATH: "/bin" });
  // The role stays unless a new one is given; bad roles are refused.
  saveInstallConfig({ role: "host", env: {}, file });
  assert.equal(saveInstallConfig({ env: {}, file }).role, "host");
  assert.throws(() => saveInstallConfig({ role: "server", env: {}, file }), /unknown role/);
  assert.deepEqual(applyInstallConfig(null, manual), []);
});
