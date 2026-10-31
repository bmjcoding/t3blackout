// node --test test/: the SSH runner agent accounts start servers through
// (lib/files/ssh-runner-blackout.sh, rule ssh/runner-installed-blackout-only),
// run against a fake app bundle and home.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SOURCE = fs.readFileSync(new URL("../lib/files/ssh-runner-blackout.sh", import.meta.url), "utf8");
const isMac = process.platform === "darwin";

test("the runner survives being a TypeScript template literal", () => {
  assert.equal(SOURCE.includes("`"), false, "no backticks");
  assert.equal(/(^|[^\\])\$\{/.test(SOURCE), false, "every ${ escaped");
  assert.equal(/\\\n/.test(SOURCE), false, "no backslash line continuations");
});

/** The runner as upstream's REMOTE_RUNNER_SCRIPT writes it: a set -eu script around this file's text. */
const rendered = () => `#!/bin/sh\nset -eu\nT3_ARCHIVE_VERSION='9.9.9'\n${new Function(`return \`${SOURCE}\`;`)()}`;

/** A home with the runner in it, and a fake app whose "Electron" reports what it was asked. */
function host() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-runner-")));
  const home = path.join(dir, "home");
  const app = path.join(dir, "T3 Blackout.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "build 1");
  // A server loops until killed, so it shows in ps with its arguments; anything else echoes.
  fs.writeFileSync(
    path.join(app, "Contents", "MacOS", "T3 Blackout"),
    '#!/bin/sh\nif [ "$2" = serve ] && [ -z "${T3B_FAKE_ONESHOT:-}" ]; then while :; do sleep 1; done; fi\nprintf "%s|%s\\n" "$*" "${T3B_TEST_TOKEN:-}"\n',
    { mode: 0o755 },
  );
  fs.mkdirSync(home, { mode: 0o700 });
  const runner = path.join(dir, "run-t3.sh");
  fs.writeFileSync(runner, rendered(), { mode: 0o700 });
  const shared = path.join(dir, "Shared", "t3blackout");
  fs.mkdirSync(shared, { recursive: true, mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_APP: app, T3BLACKOUT_UPDATE_REQUESTS: path.join(shared, "update-requests") };
  const run = (args, extra = {}) => spawnSync(runner, args, { encoding: "utf8", env: { ...env, ...extra } });
  return { dir, home, app, shared, runner, run, t3b: path.join(home, ".t3blackout") };
}

function writeEnv(t3b, { dirMode = 0o700, fileMode = 0o600 } = {}) {
  fs.mkdirSync(t3b, { recursive: true });
  fs.chmodSync(t3b, dirMode);
  fs.writeFileSync(path.join(t3b, "server.env"), "T3B_TEST_TOKEN=from-env\n");
  fs.chmodSync(path.join(t3b, "server.env"), fileMode);
}

test("it runs the installed app's server, loading a private server.env", () => {
  const { run, t3b, app } = host();
  writeEnv(t3b);
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs --version|from-env`);
});

test("a server.env others could read or swap is refused", () => {
  for (const [label, modes] of [["file 644", { fileMode: 0o644 }], ["folder 755", { dirMode: 0o755 }], ["file 640", { fileMode: 0o640 }]]) {
    const { run, t3b } = host();
    writeEnv(t3b, modes);
    const result = run(["--version"]);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /readable only by you/, label);
  }
  const { run, t3b, dir } = host();
  writeEnv(t3b);
  fs.renameSync(path.join(t3b, "server.env"), path.join(dir, "elsewhere.env"));
  fs.symlinkSync(path.join(dir, "elsewhere.env"), path.join(t3b, "server.env"));
  assert.equal(run(["--version"]).status, 1, "symlink");
});

test("ACL entries on server.env are removed before it's read", { skip: !isMac && "macOS ACLs" }, () => {
  const { run, t3b } = host();
  writeEnv(t3b);
  const file = path.join(t3b, "server.env");
  assert.equal(spawnSync("chmod", ["+a", "everyone allow read", file]).status, 0);
  assert.match(spawnSync("ls", ["-le", file], { encoding: "utf8" }).stdout, /everyone allow read/);
  const result = run(["--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(spawnSync("ls", ["-le", file], { encoding: "utf8" }).stdout, /allow/);
});

test("the server copies the pricing table the app's installer published, and only that", () => {
  const { run, shared, t3b } = host();
  const published = path.join(shared, "usage-model-rates.json");
  const copied = path.join(t3b, "userdata", "usage-model-rates.json");
  fs.writeFileSync(published, "{\"v\":1}");
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":1}");
  assert.equal(fs.statSync(copied).mode & 0o077, 0, "owner only");
  // A shared folder others can write isn't trusted.
  fs.chmodSync(shared, 0o775);
  fs.writeFileSync(published, "{\"v\":2}");
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":1}");
  fs.chmodSync(shared, 0o755);
  assert.equal(run(["serve"], { T3B_FAKE_ONESHOT: "1" }).status, 0);
  assert.equal(fs.readFileSync(copied, "utf8"), "{\"v\":2}");
});
