// node --test test/: public git goes through lib/git.mjs (decision G; SUPPLY2-08,
// PIPE2-05, BUILD2-11, HOST2-12). A machine's git configuration can't turn an
// HTTPS URL into SSH (where an agent that asks before each use would hold an
// unattended update), nothing prompts, and every call has a deadline. Scratch
// configuration and a fake ssh that records being run; no network beyond a
// .invalid name that never resolves and a local socket.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { DEADLINES, gitConfigArgs, gitEnv, gitFailure, publicGit, releaseSnapshot, transportOf } from "../lib/git.mjs";
import { upstreamTagCommit } from "../lib/pin.mjs";
import { NIGHTLY, fixture } from "./trust-fixtures.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r2-git-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const URL_ = "https://t3b-r2.invalid/pingdotgg/t3code.git";
const recorder = path.join(dir, "ssh-ran");
const fakeSsh = path.join(dir, "fake-ssh");
fs.writeFileSync(fakeSsh, `#!/bin/sh\necho "$@" >> '${recorder}'\nexit 1\n`, { mode: 0o755 });
// What a user's ~/.gitconfig might hold: every https://t3b-r2.invalid/ URL through SSH.
const globalConfig = path.join(dir, "gitconfig");
fs.writeFileSync(globalConfig, `[url "ssh://git@t3b-r2.invalid/"]\n\tinsteadOf = https://t3b-r2.invalid/\n[core]\n\tsshCommand = ${fakeSsh}\n`);
const userEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_SSH_COMMAND: fakeSsh, GIT_SSH: fakeSsh, SSH_AUTH_SOCK: path.join(dir, "agent.sock") };

test("the probe works: plain git with that configuration runs ssh for an https URL", () => {
  fs.rmSync(recorder, { force: true });
  spawnSync("git", ["ls-remote", "--", URL_], { env: userEnv, encoding: "utf8", timeout: 30_000 });
  assert.ok(fs.existsSync(recorder), "git followed insteadOf to ssh");
});

test("publicGit ignores the machine's rewrites, ssh command and agent", () => {
  fs.rmSync(recorder, { force: true });
  const result = publicGit(["ls-remote", "--", URL_], { url: URL_, timeout: 30_000, env: userEnv });
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(recorder), "no ssh ran");
  const env = gitEnv(userEnv);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.GIT_SSH, undefined);
  assert.notEqual(env.GIT_SSH_COMMAND, fakeSsh);
});

test("upstreamTagCommit goes through it too, even with a rewrite in the process's own environment", () => {
  fs.rmSync(recorder, { force: true });
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_SSH_COMMAND: fakeSsh });
  try {
    assert.throws(() => upstreamTagCommit(NIGHTLY(3917), URL_), /couldn't list upstream tag/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  assert.ok(!fs.existsSync(recorder));
});

test("a rewrite in a repository's own config (which no environment can drop) fails fast instead of reaching ssh", () => {
  fs.rmSync(recorder, { force: true });
  const repo = path.join(dir, "local-rewrite.git");
  spawnSync("git", ["init", "-q", "--bare", repo]);
  spawnSync("git", ["-C", repo, "config", "url.ssh://git@t3b-r2.invalid/.insteadOf", "https://t3b-r2.invalid/"]);
  spawnSync("git", ["-C", repo, "config", "core.sshCommand", fakeSsh]);
  const result = publicGit(["-C", repo, "fetch", URL_], { url: URL_, timeout: 30_000, env: userEnv });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transport 'ssh' not allowed/);
  assert.ok(!fs.existsSync(recorder));
  // The mirror's own reads (lib/util.mjs mirrorGit) go through publicGit too, with these rules.
  assert.deepEqual(gitConfigArgs("https").slice(0, 4), ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]);
});

test("every call has a deadline: a server that never answers is abandoned", async () => {
  // The kernel completes the connection; nothing ever answers git's TLS hello.
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}/t3code.git`;
  try {
    const started = Date.now();
    const result = publicGit(["ls-remote", "--", url], { url, timeout: 1500 });
    assert.ok(Date.now() - started < 10_000);
    assert.notEqual(result.status, 0);
    assert.equal(gitFailure(result, 1500), "timed out after 2s");
  } finally {
    server.close();
  }
  assert.throws(() => publicGit(["ls-remote", "--", url], { url, timeout: Infinity }), /needs a deadline/);
  assert.ok(Object.values(DEADLINES).every((ms) => Number.isFinite(ms) && ms > 0));
});

test("only https (or a local path, for tests) is a transport", () => {
  assert.equal(transportOf("https://github.com/pingdotgg/t3code.git"), "https");
  assert.equal(transportOf("/tmp/upstream"), "file");
  for (const url of ["ssh://git@github.com/pingdotgg/t3code.git", "git@github.com:pingdotgg/t3code.git", "http://github.com/pingdotgg/t3code.git", "git://github.com/x", "ext::sh -c x", "relative/path"]) {
    assert.throws(() => transportOf(url), /only https/);
    assert.throws(() => publicGit(["ls-remote", url], { url }), /only https/);
  }
});

test("a release snapshot checks each tag names its commit, and reads files at it", () => {
  const f = fixture();
  const snapshot = releaseSnapshot([{ ref: NIGHTLY(3917), sha: f.shas[1] }, { ref: NIGHTLY(3904), sha: f.shas[0] }], { url: f.upstream });
  try {
    assert.match(snapshot.show(f.shas[1], "pnpm-lock.yaml"), /lockfileVersion/);
    assert.equal(snapshot.show(f.shas[0], "no-such-file"), null);
    assert.throws(() => snapshot.show(f.shas[2], "pnpm-lock.yaml"), /isn't in this snapshot/);
  } finally {
    snapshot.close();
  }
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(3917), sha: f.shas[0] }], { url: f.upstream }), (error) => /isn't/.test(error.message) && !error.transient);
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(3904), sha: f.shas[0] }, { ref: NIGHTLY(3917), sha: f.shas[0] }], { url: f.upstream }), (error) => !error.transient);
  assert.throws(() => releaseSnapshot([{ ref: NIGHTLY(4999), sha: f.shas[0] }], { url: f.upstream }), (error) => error.transient === true);
});
