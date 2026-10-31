// node --test test/: self-update finds its origin, and fetches it, without any
// git configuration's say (SUPPLY4-02). It read origin with `git remote get-url`,
// which applies url.*.insteadOf from every configuration: a rewrite that hid
// github.com sent the fetch down an unrestricted fallback (ext:: transports, an
// SSH host alias) instead of lib/git.mjs. Now origin is read as the clone's own
// configuration writes it (lib/git.mjs ownConfig), and main is fetched only
// through publicGit: from origin's GitHub repository over HTTPS, or, in tests,
// from a local path named explicitly (`remote`). Each planted transport below is
// shown to run under plain git first, so its absence afterwards means something.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ownConfig } from "../lib/git.mjs";
import { githubOrigin } from "../lib/selfupdate.mjs";
import { fixture, run } from "./trust-fixtures.mjs";

const GITHUB = "https://github.com/bmjcoding/t3blackout.git";

/** A program that leaves `marker` behind when git runs it as a transport or an SSH command. */
function transport(dir, name) {
  const marker = path.join(dir, `${name}-ran`);
  const program = path.join(dir, name);
  fs.writeFileSync(program, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`, { mode: 0o755 });
  return { program, ran: () => fs.existsSync(marker), reset: () => fs.rmSync(marker, { force: true }) };
}

/** Plain git, as the old code ran it: whatever configuration and environment there is. */
const plainGit = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: process.env, timeout: 30_000 });

/** A local port nothing listens on: as an HTTPS proxy, any fetch fails at once, with no network. */
async function closedPort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Runs `body` with `vars` set in process.env (undefined unsets), then puts everything back. */
async function withEnv(vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const set = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  set(vars);
  try {
    return await body();
  } finally {
    set(saved);
  }
}

/** process.env for a fetch that must stay offline: an HTTPS proxy that refuses, and no GitHub CLI login. */
async function offline(dir) {
  const ghConfig = path.join(dir, "gh-config");
  fs.mkdirSync(ghConfig, { recursive: true });
  const proxy = `http://127.0.0.1:${await closedPort()}`;
  return { https_proxy: proxy, HTTPS_PROXY: proxy, no_proxy: undefined, NO_PROXY: undefined, GH_CONFIG_DIR: ghConfig, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined };
}

test("githubOrigin: the clone's own origin in any GitHub URL form; anything else, or two URLs, is none", () => {
  const f = fixture();
  for (const [url, want] of [
    [GITHUB, GITHUB],
    ["https://github.com/bmjcoding/t3blackout", GITHUB],
    ["https://github.com/bmjcoding/t3blackout/", GITHUB],
    ["git@github.com:bmjcoding/t3blackout.git", GITHUB],
    ["ssh://git@github.com/bmjcoding/t3blackout.git", GITHUB],
    ["git@github-alias:bmjcoding/t3blackout.git", null],
    ["https://example.org/github.com/bmjcoding/t3blackout.git", null],
    ["https://github.com.example.org/bmjcoding/t3blackout.git", null],
    ["https://github.com/bmjcoding/t3blackout.git/extra", null],
    [f.origin, null],
  ]) {
    run(f.clone, ["remote", "set-url", "origin", url]);
    assert.equal(githubOrigin(f.clone), want, url);
  }
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  run(f.clone, ["config", "--add", "remote.origin.url", "https://github.com/someone/else.git"]);
  assert.equal(githubOrigin(f.clone), null);
  assert.deepEqual(ownConfig(f.clone, "remote.origin.url"), [GITHUB, "https://github.com/someone/else.git"]);
  assert.deepEqual(ownConfig(f.clone, "remote.nothing.url"), []);
});

test("SUPPLY4-02: rewrites in global, environment or the clone's own configuration don't change the origin self-update reads", async () => {
  const f = fixture();
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  const global = path.join(f.dir, "gitconfig");
  fs.writeFileSync(global, `[url "ext::sh -c true"]\n  insteadOf = ${GITHUB}\n`);
  await withEnv({ GIT_CONFIG_GLOBAL: global }, () => {
    assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^ext::/);
    assert.equal(githubOrigin(f.clone), GITHUB);
  });
  await withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.git@github-alias:.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/" }, () => {
    assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^git@github-alias:/);
    assert.equal(githubOrigin(f.clone), GITHUB);
  });
  run(f.clone, ["config", "url.ext::sh -c true.insteadOf", GITHUB]);
  assert.match(plainGit(f.clone, ["remote", "get-url", "origin"]).stdout, /^ext::/);
  assert.equal(githubOrigin(f.clone), GITHUB);
});

test("SUPPLY4-02: a rewrite in the clone's own configuration that hides github.com stops self-update before anything runs", async () => {
  const f = fixture();
  const before = f.head();
  const planted = transport(f.dir, "local-transport");
  run(f.clone, ["remote", "set-url", "origin", GITHUB]);
  run(f.clone, ["config", "protocol.ext.allow", "always"]);
  run(f.clone, ["config", `url.ext::${planted.program}.insteadOf`, GITHUB]);
  // Plain git (the old fallback's `git fetch origin main`) runs the planted transport.
  assert.notEqual(plainGit(f.clone, ["fetch", "--quiet", "origin", "main"]).status, 0);
  assert.equal(planted.ran(), true, "positive control: plain git runs the planted transport");
  planted.reset();
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.equal(planted.ran(), false);
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /self-update skipped: couldn't fetch \(refusing to reach https:\/\/github\.com\/bmjcoding\/t3blackout\.git from .*sets url\.ext::.*\.insteadof/);
});

test("SUPPLY4-02: a global rewrite that hides github.com (ext:: or an SSH host alias) can't steer the fetch, which goes to GitHub over HTTPS", async () => {
  for (const kind of ["ext", "ssh-alias"]) {
    const f = fixture();
    const before = f.head();
    const planted = transport(f.dir, `${kind}-transport`);
    run(f.clone, ["remote", "set-url", "origin", GITHUB]);
    const global = path.join(f.dir, "gitconfig");
    fs.writeFileSync(
      global,
      kind === "ext"
        ? `[protocol "ext"]\n  allow = always\n[url "ext::${planted.program}"]\n  insteadOf = ${GITHUB}\n`
        : `[url "git@github-alias:"]\n  insteadOf = https://github.com/\n[core]\n  sshCommand = ${planted.program}\n`,
    );
    await withEnv({ GIT_CONFIG_GLOBAL: global, ...(await offline(f.dir)) }, async () => {
      assert.notEqual(plainGit(f.clone, ["fetch", "--quiet", "origin", "main"]).status, 0);
      assert.equal(planted.ran(), true, `positive control (${kind}): plain git runs the planted transport`);
      planted.reset();
      assert.equal(await f.update({ remote: null }), "skipped");
    });
    assert.equal(planted.ran(), false, kind);
    assert.equal(f.head(), before);
    // The fetch publicGit made: GitHub over HTTPS (here, to the refusing proxy).
    assert.match(f.logs.at(-1), /self-update skipped: couldn't fetch \(fatal: unable to access 'https:\/\/github\.com\/bmjcoding\/t3blackout\.git\/': Failed to connect to 127\.0\.0\.1/, kind);
  }
});

test("SUPPLY4-02: an origin that isn't a GitHub repository isn't fetched at all; a local one only when named", async () => {
  const f = fixture();
  const before = f.head();
  // The fixture's origin is a local path: without `remote`, self-update doesn't fetch it.
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.match(f.logs.at(-1), /couldn't fetch \(origin isn't a github\.com repository URL/);
  assert.equal(fs.existsSync(path.join(f.clone, ".git", "FETCH_HEAD")), false);
  // An SSH host alias as origin itself is no GitHub URL either.
  run(f.clone, ["remote", "set-url", "origin", "git@github-alias:bmjcoding/t3blackout.git"]);
  assert.equal(await f.update({ remote: null }), "skipped");
  assert.match(f.logs.at(-1), /origin isn't a github\.com repository URL/);
  // Named explicitly, the local fixture goes through publicGit too (file transport, the clone's configuration checked).
  run(f.clone, ["config", "url.ext::sh -c true.insteadOf", f.origin]);
  assert.equal(await f.update(), "skipped");
  assert.match(f.logs.at(-1), /refusing to reach .*origin from .*sets url\.ext::sh -c true\.insteadof/);
  run(f.clone, ["config", "--unset", "url.ext::sh -c true.insteadOf"]);
  assert.equal(await f.update(), "skipped", "nothing new on origin's main");
  assert.equal(f.head(), before);
});
