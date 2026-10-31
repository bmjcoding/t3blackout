// Git against public remotes: upstream (github.com/pingdotgg/t3code) and this
// repository's own GitHub copy, and against the upstream mirror (lib/util.mjs
// mirrorGit). Every clone, fetch and ls-remote goes through publicGit, and so
// does every lazy blob fetch one of those repositories makes later (`git show`
// in a blobless clone), because the options below travel to the git processes
// it starts.
//
// A machine's own git configuration must not decide how these run. A
// `url.ssh://git@github.com/.insteadOf=https://github.com/` rule in ~/.gitconfig
// would send an HTTPS URL through SSH, and an SSH agent that asks before each use
// (1Password) would hold an unattended update until someone approves it, or
// forever. So: no global or system configuration (rewrites, credential helpers,
// core.sshCommand, proxies, includeIf), nothing GIT_* in the environment, HTTPS
// as the only transport whatever any configuration allows (GIT_ALLOW_PROTOCOL),
// nothing that can prompt, and a deadline on every call. A repository's own
// configuration can't be switched off, so before git reaches a remote from one,
// checkRepoTransport refuses one that rewrites URLs or sets how git connects,
// and checks the remote is still the URL meant after any rewriting.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

/** How long each kind of call may run before it's abandoned, in ms. */
export const DEADLINES = { list: 60_000, read: 300_000, fetch: 900_000, clone: 1_800_000 };

const FALSE = ["/usr/bin/false", "/bin/false"].find((file) => fs.existsSync(file)) ?? "false";

/** The one transport a URL may use: https, or file for a local path (a test's upstream). */
export function transportOf(url) {
  if (/^https:\/\/[^\s/]+\//.test(url)) return "https";
  if (path.isAbsolute(url)) return "file";
  throw new Error(`refusing git transport for ${url}: only https:// URLs are fetched`);
}

/**
 * `-c` options for git against a remote reached over `transport`: no other
 * transport (a rewritten URL fails at once instead of trying SSH), no credential
 * helper or password prompt, no hooks or signature programs, and a stalled
 * transfer gives up after a minute. Child processes (lazy fetches) inherit them.
 */
export const gitConfigArgs = (transport = "https") =>
  [
    "protocol.allow=never",
    `protocol.${transport}.allow=always`,
    "credential.helper=",
    `core.askPass=${FALSE}`,
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "log.showSignature=false",
    "http.lowSpeedLimit=1000",
    "http.lowSpeedTime=60",
  ].flatMap((option) => ["-c", option]);

/**
 * `env` without anything that configures git or reaches an SSH agent, with no
 * global or system git configuration, and `transport` as the only one git may
 * use: GIT_ALLOW_PROTOCOL overrides every protocol.*.allow, a repository's own
 * `protocol.ext.allow=always` included (HOST3-01), and remote helpers with it.
 */
export function gitEnv(env = process.env, transport = "https") {
  const kept = Object.entries(env).filter(([name]) => !name.startsWith("GIT_") && !["SSH_ASKPASS", "SSH_AUTH_SOCK", "GCM_INTERACTIVE"].includes(name));
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: FALSE,
    GIT_SSH_COMMAND: FALSE,
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: transport,
  };
}

/** spawnSync of `git args` under the rules above for remote `url`; no repository's configuration checked. */
function isolatedGit(args, { url, timeout = DEADLINES.fetch, config = [], env = process.env, ...opts } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("publicGit needs a deadline");
  const transport = transportOf(url);
  const extra = config.flatMap((option) => ["-c", option]);
  return spawnSync("git", [...gitConfigArgs(transport), ...extra, ...args], {
    encoding: "utf8",
    maxBuffer: 256 << 20,
    // Not inside a repository whose own configuration git would read (ls-remote, clone).
    cwd: "/",
    ...opts,
    timeout,
    // SIGTERM, not SIGKILL: git removes its lock files (index.lock, ref locks) on the way out.
    killSignal: "SIGTERM",
    env: gitEnv(env, transport),
  });
}

/** A repository's own configuration that decides where git connects for a remote, or how. */
const TRANSPORT_KEY = /^(?:url\..+\.(?:insteadof|pushinsteadof)|http\..+|remote\..+\.(?:vcs|uploadpack|receivepack|proxy|proxyauthmethod)|core\.(?:gitproxy|sshcommand)|credential\..+|protocol\.(?:.+\.)?allow)$/;

/**
 * Throws unless git run in `repo` reaches `url` as itself: the repository's own
 * configuration (its config file, a worktree's, and whatever they include) may
 * not rewrite URLs, set proxies, TLS, helpers or credentials; and the remote
 * used, `remote` (the only one the repository may have, and its only promisor)
 * or `url` itself when the command names it, must be `url` after any rewriting.
 * `config`: the caller's own `-c` options.
 */
export function checkRepoTransport(repo, { url, remote = null, config = [] }) {
  const git = (args) => isolatedGit(["-C", repo, ...args], { url, config, timeout: DEADLINES.list });
  const listed = git(["config", "--list", "--show-scope", "--includes", "-z"]);
  if (listed.status !== 0) throw new Error(`couldn't read ${repo}'s git configuration: ${gitFailure(listed, DEADLINES.list)}`);
  // -z: scope NUL key LF value NUL, a value-less key without the LF.
  const parts = listed.stdout.split("\0");
  const own = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "local" && parts[i] !== "worktree") continue;
    const cut = parts[i + 1].indexOf("\n");
    own.push(cut === -1 ? { key: parts[i + 1], value: "" } : { key: parts[i + 1].slice(0, cut), value: parts[i + 1].slice(cut + 1) });
  }
  const problems = own
    .filter(({ key, value }) => {
      if (TRANSPORT_KEY.test(key)) return true;
      if (!remote) return key === "extensions.partialclone" || /^remote\..+\.promisor$/.test(key);
      return (key.startsWith("remote.") && !key.startsWith(`remote.${remote}.`)) || (key === "extensions.partialclone" && value !== remote);
    })
    .map(({ key }) => `sets ${key}`);
  if (remote && own.filter(({ key }) => key === `remote.${remote}.url`).length !== 1) problems.push(`doesn't give ${remote} exactly one URL`);
  const target = remote ?? url;
  const reached = git(["ls-remote", "--get-url", target]);
  const got = reached.status === 0 ? reached.stdout.trim() : `nothing (${gitFailure(reached, DEADLINES.list)})`;
  if (got !== url) problems.push(`sends ${target} to ${got}, not ${url}`);
  if (problems.length) throw new Error(`refusing to reach ${url} from ${repo}: its own git configuration ${[...new Set(problems)].join("; ")}`);
}

/**
 * Runs `git args` for remote `url` (which picks the transport) under the rules
 * above, within `timeout` ms: spawnSync's result. `repo`: the repository it runs
 * in (-C), whose own configuration must leave `remote` (or `url`, when the
 * arguments name it) alone first; checkRepoTransport throws otherwise.
 * `config`: extra `-c` options, after ours (a credential helper the caller chose).
 */
export function publicGit(args, { repo = null, remote = null, ...opts } = {}) {
  if (repo === null) return isolatedGit(args, opts);
  checkRepoTransport(repo, { url: opts.url, remote, config: opts.config });
  return isolatedGit(["-C", repo, ...args], opts);
}

/**
 * The values `key` has in `repo`'s own git configuration, as written there: read
 * under the rules above (none of this machine's configuration, nothing from the
 * environment, no remote reached), so no `url.*.insteadOf` applies. [] when unset.
 */
export function ownConfig(repo, key) {
  const result = isolatedGit(["-C", repo, "config", "--get-all", "-z", key], { url: path.resolve(repo), timeout: DEADLINES.list });
  if (result.status === 1 && !result.stderr) return [];
  if (result.status !== 0) throw new Error(`couldn't read ${key} in ${repo}: ${gitFailure(result, DEADLINES.list)}`);
  return result.stdout.split("\0").slice(0, -1);
}

/** Why a publicGit call failed, in one line: git's fatal or error line, else its last. */
export function gitFailure(result, timeout) {
  if (result.error?.code === "ETIMEDOUT") return `timed out after ${Math.round(timeout / 1000)}s`;
  const lines = (result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim().split("\n");
  // "unknown option" is how a git older than this tool needs (2.45) fails.
  return lines.find((line) => /^(?:fatal|error): |^unknown option/.test(line)) ?? lines.at(-1);
}

/** publicGit, throwing `what` failed: why. */
export function publicGitOrThrow(args, opts, what) {
  const timeout = opts.timeout ?? DEADLINES.fetch;
  const result = publicGit(args, { ...opts, timeout });
  if (result.status !== 0) throw new Error(`${what} failed: ${gitFailure(result, timeout)}`);
  return result;
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Upstream's release tags `releases` ([{ ref, sha }]) in a scratch, shallow,
 * blobless bare repository, each checked to be commit `sha` there, and the
 * commits `trusted` (shas this machine already trusts, such as the release its
 * pin names now), fetched by commit id alone: an old release's tag being moved
 * or deleted upstream later doesn't change what it was (SUPPLY3-06). Returns {
 * show(sha, file) -> the file's text, or null when the commit doesn't have it;
 * close() }. Not reaching upstream (or a file's contents) throws an error marked
 * `transient`; a tag naming another commit throws a plain one.
 */
export function releaseSnapshot(releases, { url = UPSTREAM_URL, trusted = [] } = {}) {
  const transient = (message) => Object.assign(new Error(message), { transient: true });
  const wanted = [...new Map(releases.map((release) => [release.ref, release])).values()];
  if (!wanted.length) throw new Error("releaseSnapshot needs a release");
  for (const { ref, sha } of wanted) if (!/^v[\w.-]+$/.test(ref) || !SHA.test(sha)) throw new Error(`${ref} at ${sha} isn't a release tag and commit`);
  for (const sha of trusted) if (!SHA.test(sha)) throw new Error(`${sha} isn't a commit`);
  const commits = [...new Set(trusted)].filter((sha) => !wanted.some((release) => release.sha === sha));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-release-"));
  const repo = path.join(dir, "upstream.git");
  const git = (args, timeout) => publicGit(args, { url, repo, remote: "origin", timeout });
  const close = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const [first, ...rest] = wanted;
    const clone = publicGit(["clone", "--quiet", "--bare", "--depth=1", "--filter=blob:none", "--no-tags", "--branch", first.ref, "--", url, repo], { url, timeout: DEADLINES.clone });
    if (clone.status !== 0) throw transient(`couldn't fetch upstream ${first.ref}: ${gitFailure(clone, DEADLINES.clone)}`);
    for (const { ref } of rest) {
      const fetched = git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags", "origin", `+refs/tags/${ref}:refs/tags/${ref}`], DEADLINES.fetch);
      if (fetched.status !== 0) throw transient(`couldn't fetch upstream ${ref}: ${gitFailure(fetched, DEADLINES.fetch)}`);
    }
    for (const sha of commits) {
      const fetched = git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", "--no-tags", "origin", sha], DEADLINES.fetch);
      if (fetched.status !== 0) throw transient(`couldn't fetch upstream commit ${sha.slice(0, 10)}: ${gitFailure(fetched, DEADLINES.fetch)}`);
    }
    for (const { ref, sha } of releases) {
      const name = ref === first.ref ? "HEAD" : `refs/tags/${ref}`;
      const found = git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], DEADLINES.list).stdout?.trim();
      if (found !== sha) throw new Error(`upstream's ${ref} isn't ${sha.slice(0, 10)}`);
    }
    for (const sha of commits) {
      if (git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], DEADLINES.list).stdout?.trim() !== sha) throw transient(`upstream didn't send commit ${sha.slice(0, 10)}`);
    }
  } catch (error) {
    close();
    throw error;
  }
  const show = (sha, file) => {
    if (!wanted.some((release) => release.sha === sha) && !commits.includes(sha)) throw new Error(`${sha.slice(0, 10)} isn't in this snapshot`);
    // Trees came with the fetch; only the file's contents are fetched, on demand.
    const listed = git(["ls-tree", "--name-only", sha, "--", file], DEADLINES.list);
    if (listed.status !== 0) throw transient(`couldn't read ${sha.slice(0, 10)}'s tree: ${gitFailure(listed, DEADLINES.list)}`);
    if (listed.stdout.trim() !== file) return null;
    const blob = git(["show", `${sha}:${file}`], DEADLINES.read);
    if (blob.status !== 0) throw transient(`couldn't fetch ${file} at ${sha.slice(0, 10)}: ${gitFailure(blob, DEADLINES.read)}`);
    return blob.stdout;
  };
  return { show, close };
}
