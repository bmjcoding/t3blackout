// Keeps each machine's copy of t3blackout current, so a rule fix pushed from one
// machine reaches the others before their next build. It only fast-forwards to
// commits signed by a key in .allowed_signers as it is checked out here, so
// someone who gets into the GitHub account can't push code that every machine
// runs at 04:00.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { ROOT, commandExists, log } from "./util.mjs";

const SIGNERS = path.join(ROOT, ".allowed_signers");

const git = (args, opts = {}) =>
  spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 60_000, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env } });

const out = (args) => {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : null;
};

/** owner/repo of origin, whatever its URL form. */
function originRepo() {
  const url = out(["remote", "get-url", "origin"]) ?? "";
  return /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
}

/**
 * Fetches main without prompting: over HTTPS with the GitHub CLI's stored login
 * when it has one (an SSH key behind an agent like 1Password would wait for an
 * approval nobody gives at 04:00), otherwise from origin with SSH in batch mode.
 */
function fetchMain() {
  const repo = originRepo();
  if (repo && commandExists("gh") && spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0) {
    return git(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "fetch", "--quiet", `https://github.com/${repo}.git`, "main"]);
  }
  return git(["fetch", "--quiet", "origin", "main"], { env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" } });
}

/** Fast-forwards this clone to signed new commits on main: "updated", "refused" or "skipped". */
export function selfUpdate() {
  if (!fs.existsSync(SIGNERS)) return "skipped";
  if (out(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
    log("self-update skipped: not on main");
    return "skipped";
  }
  if (out(["status", "--porcelain", "--untracked-files=no"])) {
    log("self-update skipped: uncommitted changes");
    return "skipped";
  }
  const fetched = fetchMain();
  if (fetched.status !== 0) {
    log(`self-update skipped: couldn't fetch (${(fetched.stderr || fetched.error?.message || "timed out").trim().split("\n")[0]})`);
    return "skipped";
  }
  const head = out(["rev-parse", "HEAD"]);
  const tip = out(["rev-parse", "FETCH_HEAD"]);
  if (!tip || tip === head) return "skipped";
  if (git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).status !== 0) {
    log(`self-update refused: origin/main (${tip.slice(0, 10)}) isn't a fast-forward of this clone`);
    return "refused";
  }
  // Every new commit, checked against the signers file as it is here (not as
  // the incoming commits would have it), by ssh-keygen whatever signer git is
  // configured with (e.g. 1Password's).
  const verify = ["-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${SIGNERS}`];
  const commits = (out([...verify, "log", "--format=%H %G?", "HEAD..FETCH_HEAD"]) ?? "").split("\n").filter(Boolean);
  const unsigned = commits.filter((line) => !line.endsWith(" G"));
  if (!commits.length || unsigned.length) {
    log(`self-update refused: ${unsigned.length} of ${commits.length} new commit(s) aren't signed by a key in .allowed_signers`);
    return "refused";
  }
  if (git(["merge", "--ff-only", "--quiet", "FETCH_HEAD"]).status !== 0) {
    log("self-update failed to fast-forward");
    return "skipped";
  }
  log(`self-updated t3blackout to ${tip.slice(0, 10)} (${commits.length} signed commit(s))`);
  return "updated";
}
