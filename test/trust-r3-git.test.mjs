// node --test test/: git isolation, round 3 (decision K; SUPPLY3-05, HOST3-01).
// Every git process against upstream or the mirror runs without global or
// system configuration and without GIT_CONFIG_* from the caller, with HTTPS (a
// local path, here) as the only transport whatever a repository allows; a
// repository's own URL rewrites, proxies and helpers are refused before git
// reaches a remote from it, and its remote must still be the URL meant after
// rewriting. Mirror reads that don't need file contents never fetch lazily, so a
// mirror another account controls can't make the reader run or reach anything.
// Scratch repositories, a scratch "transport" program that records being run,
// and a local socket; nothing leaves the machine.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { checkRepoTransport, gitConfigArgs, gitEnv, publicGit } from "../lib/git.mjs";
import { mirrorGit, mirrorOut } from "../lib/util.mjs";
import { run } from "./trust-fixtures.mjs";

// The real path: includeIf "gitdir:" compares against it (/var vs /private/var on macOS).
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r3-git-")));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const marker = path.join(dir, "transport-ran");
const transport = path.join(dir, "transport");
fs.writeFileSync(transport, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
const ran = () => fs.existsSync(marker);
const UPSTREAM = "https://github.com/pingdotgg/t3code.git";

/** A repository with one commit; returns [repo, sha]. */
function repoWithCommit(name) {
  const repo = path.join(dir, name);
  run(dir, ["init", "-q", "-b", "main", repo]);
  fs.writeFileSync(path.join(repo, "file"), "x\n");
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "--no-gpg-sign", "-m", "fixture"]);
  return [repo, run(repo, ["rev-parse", "HEAD"])];
}

/** What a compromised build account can do to its mirror: an `ext::` promisor that runs `transport`, and the commit's object gone. */
function poisonedMirror(name) {
  const [repo, sha] = repoWithCommit(name);
  run(repo, ["config", "protocol.ext.allow", "always"]);
  run(repo, ["config", "extensions.partialClone", "origin"]);
  run(repo, ["config", "remote.origin.url", `ext::${transport}`]);
  run(repo, ["config", "remote.origin.promisor", "true"]);
  fs.rmSync(path.join(repo, ".git/objects", sha.slice(0, 2), sha.slice(2)));
  return [repo, sha];
}

test("HOST3-01: reading a poisoned mirror runs no transport, lazily or through a rewrite", () => {
  fs.rmSync(marker, { force: true });
  const [mirror, sha] = poisonedMirror("poisoned-mirror");
  // The probe works: round 2's mirror read (its -c options, no global config) ran the transport.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  spawnSync("git", [...gitConfigArgs("https"), "-c", `safe.directory=${mirror}`, "-C", mirror, "log", "-1", "--format=%ct", sha], { env, encoding: "utf8", timeout: 10_000 });
  assert.ok(ran(), "a lazy fetch ran the mirror's ext:: transport");
  fs.rmSync(marker);
  // The installing account's metadata reads (poll --offline's revParse, commitTime).
  const read = mirrorGit(["log", "-1", "--format=%ct", sha], { dir: mirror });
  assert.notEqual(read.status, 0, "the object is missing and isn't fetched");
  assert.throws(() => mirrorOut(["rev-parse", `${sha}^{commit}`], { dir: mirror }), /failed/);
  assert.ok(!ran(), "no lazy fetch ran the mirror's transport");
  // Reading file contents fetches, so it checks where the mirror sends that first.
  assert.throws(() => mirrorGit(["show", `${sha}:file`], { dir: mirror, fetch: true }), /refusing to reach https:\/\/github\.com\/pingdotgg\/t3code\.git from .*sets protocol\.ext\.allow.*sends origin to ext::/);
  assert.ok(!ran());
  // Even without that check, a repository's protocol.ext.allow=always is overridden.
  const rewritten = path.join(dir, "rewrite-to-ext");
  run(dir, ["init", "-q", rewritten]);
  run(rewritten, ["config", "protocol.ext.allow", "always"]);
  run(rewritten, ["config", `url.ext::${transport}.insteadOf`, "https://review.invalid/"]);
  const listed = publicGit(["-C", rewritten, "ls-remote", "https://review.invalid/"], { url: "https://review.invalid/", timeout: 10_000 });
  assert.notEqual(listed.status, 0);
  assert.match(listed.stderr, /transport 'ext' not allowed/);
  assert.ok(!ran(), "GIT_ALLOW_PROTOCOL beat the repository's protocol.ext.allow");
  assert.equal(gitEnv({ GIT_ALLOW_PROTOCOL: "ext:https" }).GIT_ALLOW_PROTOCOL, "https");
});

test("SUPPLY3-05: the caller's global includeIf, proxy and GIT_CONFIG_COUNT don't reach mirror reads", () => {
  const [mirror] = repoWithCommit("plain-mirror");
  run(mirror, ["remote", "add", "origin", UPSTREAM]);
  const included = path.join(dir, "included-gitconfig");
  const globalFile = path.join(dir, "global-gitconfig");
  fs.writeFileSync(included, `[http]\n\tproxy = http://127.0.0.1:9\n[url "https://include.invalid/"]\n\tinsteadOf = https://github.com/\n`);
  fs.writeFileSync(globalFile, `[includeIf "gitdir:${mirror}/.git"]\n\tpath = ${included}\n`);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalFile };
  // The probe works: plain git with that environment is redirected.
  assert.match(spawnSync("git", ["-C", mirror, "ls-remote", "--get-url", "origin"], { env, encoding: "utf8" }).stdout, /include\.invalid/);
  assert.equal(mirrorOut(["ls-remote", "--get-url", "origin"], { dir: mirror, env }), UPSTREAM);
  assert.equal(mirrorGit(["config", "--get", "http.proxy"], { dir: mirror, env }).status, 1, "no proxy from the included file");
  const countEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://count.invalid/.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/" };
  assert.match(spawnSync("git", ["-C", mirror, "ls-remote", "--get-url", "origin"], { env: countEnv, encoding: "utf8" }).stdout, /count\.invalid/);
  assert.equal(mirrorOut(["ls-remote", "--get-url", "origin"], { dir: mirror, env: countEnv }), UPSTREAM);
  // And the owner's fetch from it passes the repository check.
  assert.doesNotThrow(() => checkRepoTransport(mirror, { url: UPSTREAM, remote: "origin" }));
});

test("SUPPLY3-05: a repository's own HTTPS rewrite is refused before git connects anywhere", async () => {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const [repo] = repoWithCommit("local-rewrite");
    run(repo, ["config", `url.https://127.0.0.1:${port}/rewritten/.insteadOf`, "https://github.com/"]);
    // git runs synchronously: the server sees a connection once the event loop turns.
    const settled = () => new Promise((resolve) => setTimeout(resolve, 100));
    // The probe works: without the check git goes where the rewrite says (HTTPS is allowed).
    const unchecked = publicGit(["-C", repo, "ls-remote", "--", UPSTREAM], { url: UPSTREAM, timeout: 3_000 });
    assert.notEqual(unchecked.status, 0);
    await settled();
    assert.equal(connections.length, 1, "git connected to the rewritten host");
    // Through the repository check (selfupdate's fetch, the mirror's fetches): refused, no connection.
    assert.throws(
      () => publicGit(["fetch", "--quiet", UPSTREAM, "main"], { url: UPSTREAM, repo, timeout: 3_000 }),
      new RegExp(`refusing to reach .* sets url\\.https://127\\.0\\.0\\.1:${port}/rewritten/\\.insteadof; sends https://github\\.com/pingdotgg/t3code\\.git to https://127\\.0\\.0\\.1:${port}/rewritten/pingdotgg/t3code\\.git`),
    );
    await settled();
    assert.equal(connections.length, 1, "no further connection");
  } finally {
    server.close();
  }
});

test("a mirror's origin must be upstream, its only remote, with no proxy or helper of its own", () => {
  const check = (setup) => {
    const [repo] = repoWithCommit(`origin-${Math.random().toString(36).slice(2)}`);
    run(repo, ["remote", "add", "origin", UPSTREAM]);
    setup(repo);
    return () => checkRepoTransport(repo, { url: UPSTREAM, remote: "origin" });
  };
  assert.throws(check((repo) => run(repo, ["remote", "set-url", "origin", "https://elsewhere.invalid/t3code.git"])), /sends origin to https:\/\/elsewhere\.invalid\/t3code\.git/);
  assert.throws(check((repo) => run(repo, ["config", "--add", "remote.origin.url", "https://elsewhere.invalid/t3code.git"])), /doesn't give origin exactly one URL/);
  assert.throws(check((repo) => run(repo, ["remote", "add", "evil", "https://elsewhere.invalid/x.git"])), /sets remote\.evil\.url/);
  assert.throws(check((repo) => run(repo, ["config", "http.proxy", "http://127.0.0.1:9"])), /sets http\.proxy/);
  assert.throws(check((repo) => run(repo, ["config", "remote.origin.vcs", "evil"])), /sets remote\.origin\.vcs/);
  assert.throws(check((repo) => run(repo, ["config", "credential.helper", "!evil"])), /sets credential\.helper/);
  // Included files count as the repository's own.
  const included = path.join(dir, "repo-include");
  fs.writeFileSync(included, `[http "https://github.com/"]\n\tsslVerify = false\n`);
  assert.throws(check((repo) => run(repo, ["config", "include.path", included])), /sets http\.https:\/\/github\.com\/\.sslverify/);
  // A plain clone passes.
  assert.doesNotThrow(check(() => {}));
});
