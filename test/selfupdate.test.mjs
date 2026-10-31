// node --test test/: the evaluator key may only move pin.json (lib/selfupdate.mjs).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { BOT_PRINCIPAL, botCommitProblem } from "../lib/selfupdate.mjs";

const pin = (ref) => ({
  version: 1,
  channels: { nightly: { ref, sha: "a".repeat(40), evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } },
  deviceTools: ["agent-device@0.21.31"],
});

function repoWithBotKey() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-selfupdate-"));
  const key = path.join(dir, "bot_key");
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const pub = fs.readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const repo = path.join(dir, "repo");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, "-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${key}`, "-c", "user.name=bot", "-c", "user.email=bot@example.com", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  const signers = path.join(dir, "allowed_signers");
  fs.writeFileSync(signers, `${BOT_PRINCIPAL} namespaces="git" ${pub}\n`);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-S", "-m", "root");
  const commit = (files, message) => {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
    git("add", "-A");
    git("commit", "-q", "-S", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const signer = (sha) => git("-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "log", "-1", "--format=%G? %GS", sha);
  return { repo, commit, signer };
}

test("the evaluator signs as its principal", () => {
  const { commit, signer } = repoWithBotKey();
  const sha = commit({ "pin.json": JSON.stringify(pin("v0.1.4-nightly.20261028.3824")) }, "pin");
  assert.equal(signer(sha), `G ${BOT_PRINCIPAL}`);
});

test("a pin-only commit with a valid pin is accepted; the first pin isn't the evaluator's to write", () => {
  const { repo, commit } = repoWithBotKey();
  const first = commit({ "pin.json": JSON.stringify(pin("v0.1.3-nightly.20261025.3692")) }, "first pin");
  assert.match(botCommitProblem(first, repo), /creates pin\.json; its first version needs a commit you sign/);
  const sha = commit({ "pin.json": JSON.stringify(pin("v0.1.4-nightly.20261028.3824")) }, "pin");
  assert.equal(botCommitProblem(sha, repo), null);
});

test("a commit that touches anything besides pin.json is refused", () => {
  const { repo, commit } = repoWithBotKey();
  const sha = commit({ "pin.json": JSON.stringify(pin("v0.1.4-nightly.20261028.3824")), "rules.mjs": "evil\n" }, "pin and more");
  assert.match(botCommitProblem(sha, repo), /not just pin\.json/);
});

test("an invalid pin is refused", () => {
  const { repo, commit } = repoWithBotKey();
  const bad = pin("v0.1.4-nightly.20261028.3824");
  bad.channels.nightly.ref = "main";
  const sha = commit({ "pin.json": JSON.stringify(bad) }, "bad pin");
  assert.match(botCommitProblem(sha, repo), /isn't a release tag/);
});

test("a pin naming another channel's release is refused", () => {
  const { repo, commit } = repoWithBotKey();
  const sha = commit({ "pin.json": JSON.stringify({ ...pin("v0.1.4"), channels: { nightly: { ...pin("x").channels.nightly, ref: "v0.1.4" } } }) }, "stable as nightly");
  assert.match(botCommitProblem(sha, repo), /is a stable release/);
});

test("rolling a channel back is refused", () => {
  const { repo, commit } = repoWithBotKey();
  commit({ "pin.json": JSON.stringify(pin("v0.1.6-nightly.20261030.3917")) }, "pin newer");
  const sha = commit({ "pin.json": JSON.stringify(pin("v0.1.3-nightly.20261025.3692")) }, "pin older");
  assert.match(botCommitProblem(sha, repo), /moves nightly back/);
});

test("dropping a reviewed device tool is refused", () => {
  const { repo, commit } = repoWithBotKey();
  commit({ "pin.json": JSON.stringify(pin("v0.1.4-nightly.20261028.3824")) }, "pin");
  const sha = commit({ "pin.json": JSON.stringify({ ...pin("v0.1.6-nightly.20261030.3917"), deviceTools: [] }) }, "drop tools");
  assert.match(botCommitProblem(sha, repo), /removes reviewed device tools/);
});
