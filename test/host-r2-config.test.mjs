// node --test test/: state/install.json fails closed (lib/install-config.mjs):
// absent is "no config", anything unreadable or invalid is an error; it's
// written whole; and the host roles can't move what agent accounts rely on.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { HOST_LOCATIONS, hostLocationProblem, readInstallConfig, saveInstallConfig } from "../lib/install-config.mjs";

const configFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-config-")), "state", "install.json");

test("a missing config is none; a truncated or malformed one is an error, never the defaults (HOST2-10)", () => {
  const file = configFile();
  assert.equal(readInstallConfig(file), null);
  saveInstallConfig({ role: "ui", env: { T3BLACKOUT_HOME: "/Volumes/t3b" }, file });
  const whole = fs.readFileSync(file, "utf8");
  for (const [label, text] of [
    ["truncated", whole.slice(0, 20)],
    ["empty", ""],
    ["not an object", "[]"],
    ["unknown role", JSON.stringify({ role: "server", env: {} })],
    ["no env", JSON.stringify({ role: "ui" })],
    ["unknown setting", JSON.stringify({ role: "ui", env: { PATH: "/bin" } })],
    ["relative path", JSON.stringify({ role: "ui", env: { T3BLACKOUT_HOME: "t3b" } })],
    ["not a string", JSON.stringify({ role: "ui", env: { T3BLACKOUT_HOME: 7 } })],
    ["host role, moved apps", JSON.stringify({ role: "host", env: { T3BLACKOUT_APPS: "/Volumes/Apps" } })],
  ]) {
    fs.writeFileSync(file, text);
    assert.throws(() => readInstallConfig(file), /install\.json (is invalid|isn't valid JSON)/, label);
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => readInstallConfig(file), /can't read .*install\.json/, "a folder");
});

test("saving replaces the file whole, owner-only, and repairs an invalid one only given a role (HOST2-10)", () => {
  const file = configFile();
  saveInstallConfig({ role: "both", env: {}, file });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["install.json"], "no temporary left behind");
  fs.writeFileSync(file, "{\"role\":");
  assert.throws(() => saveInstallConfig({ env: {}, file }), /give the role/);
  assert.equal(saveInstallConfig({ role: "ui", env: {}, file }).role, "ui");
  assert.equal(readInstallConfig(file).role, "ui");
  // Empty is unset; relative paths are refused.
  assert.equal(saveInstallConfig({ role: "ui", env: { T3BLACKOUT_APPS: "" }, file }).env.T3BLACKOUT_APPS, null);
  assert.throws(() => saveInstallConfig({ role: "ui", env: { T3BLACKOUT_HOME: "./t3b" }, file }), /isn't an absolute path/);
});

test("the host roles can't move the apps or request folders agent accounts use (HOST2-11)", () => {
  const file = configFile();
  for (const role of ["host", "both"]) {
    assert.throws(() => saveInstallConfig({ role, env: { T3BLACKOUT_APPS: "/Volumes/Apps" }, file }), /can't use T3BLACKOUT_APPS/);
    assert.throws(() => saveInstallConfig({ role, env: { T3BLACKOUT_UPDATE_REQUESTS: "/tmp/requests" }, file }), /can't use T3BLACKOUT_UPDATE_REQUESTS/);
    // Their own values, spelled out, are fine; so are locations only you use.
    assert.equal(saveInstallConfig({ role, env: { T3BLACKOUT_APPS: "/Applications/", T3BLACKOUT_UPDATE_REQUESTS: HOST_LOCATIONS.T3BLACKOUT_UPDATE_REQUESTS, T3BLACKOUT_HOME: "/Volumes/t3b" }, file }).role, role);
  }
  assert.equal(hostLocationProblem("ui", { T3BLACKOUT_APPS: "/Volumes/Apps" }), null);
  assert.equal(saveInstallConfig({ role: "ui", env: { T3BLACKOUT_APPS: "/Volumes/Apps" }, file }).env.T3BLACKOUT_APPS, "/Volumes/Apps");
});
