// Keeps each machine's copy of t3blackout current, so a rule fix pushed from one
// machine reaches the others before their next build. It only fast-forwards to
// commits signed with SSH by a principal in .allowed_signers as committed at this
// clone's HEAD (not as the incoming commits would have it), so someone who gets
// into the GitHub account can't push code that every machine runs within the
// hour. GPG and X.509 signatures are refused outright: git would check those
// against whatever keyring the machine has, not against the allowlist.
//
// It runs under the update lock (bin/t3blackout cmdUpdate) and reads FETCH_HEAD
// once: everything after works on that exact commit id, and the fast-forward must
// land on it, so another fetch can't swap in commits nobody verified.
//
// The evaluator's key (principal BOT_PRINCIPAL, used by .github/workflows/
// evaluate.yml) may only pin a real, newer upstream release, and this machine,
// not CI, decides whether it may have it: the evaluator's verdicts are only a
// proposal (lib/pincheck.mjs), and its key could be stolen. A commit it signed is
// accepted only if it changes pin.json and nothing else, has one parent, follows
// a pin (it can't write the first one, or a channel's first), leaves a valid pin
// of canonical release tags, rolls no channel back (pin.mjs backwardMove), and
// approves device tools or their locks only alongside a forward move. Then each
// of its gates is worked out again here, from upstream's git, npm and OSV:
//   - each channel it moves names the commit its tag points at upstream (git
//     ls-remote), so a stolen key can't pass off an old or unreleased commit
//     under a newer release's name;
//   - every tool it approves is one the release it moves to pins and, with its
//     dependency closure, passes review (gates.mjs reviewAddedDeviceTools);
//   - every dependency version the release adds over the release the pin it
//     follows names (which this clone already trusts) is at least MIN_AGE_DAYS
//     old, keeps its bytes and has the registry's, unless the fast lane, worked out
//     from that release's own lockfile and the owner's overrides, waives it as a
//     security fix (lib/fastlane.mjs). A young one holds the update until it's old
//     enough; nothing else the update carries is taken before then either.
// The build that follows strips, typechecks, scans and smoke-tests the release
// here before anything is installed (lib/build.mjs).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openAdvisories } from "./evaluate.mjs";
import { makeFastLane } from "./fastlane.mjs";
import { DEADLINES, UPSTREAM_URL, ownConfig, publicGit, releaseSnapshot } from "./git.mjs";
import { MIN_AGE_DAYS, dependencyAgeGate, heldDependencies, lockIdentities, reviewAddedDeviceTools } from "./gates.mjs";
import { DEVICE_TOOL_PINS, deviceToolsInUse, trustedInventory } from "./inventory.mjs";
import { parseOverrides } from "./overrides.mjs";
import { PIN_FILE, backwardMove, compareRefs, unreleasedPin, validatePin } from "./pin.mjs";
import { ROOT, commandExists, log } from "./util.mjs";

export const BOT_PRINCIPAL = "t3blackout-evaluator";

const SIGNERS = ".allowed_signers";
const KNOWN_DEVICE_TOOLS = "lib/known-device-tools.txt";
const KNOWN_HOSTS = "lib/known-hosts.txt";
const OVERRIDES = "lib/overrides.json";

const gitIn = (repo) => (args, opts = {}) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env } });

const outOf = (git) => (args) => {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : null;
};

/** A GitHub repository URL in any form git takes (https, ssh, scp-like): its owner/repo, else null. */
const GITHUB_URL = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/(?:[\w.-]+@)?github\.com(?::\d+)?\/|(?:[\w.-]+@)?github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;

/**
 * https://github.com/<owner>/<repo>.git for this clone's origin, in whatever URL
 * form it's written, or null when that isn't one GitHub repository. Read as the
 * clone's own configuration writes it (lib/git.mjs ownConfig), not as `git
 * remote get-url` would: an `insteadOf` rule in any git configuration would make
 * that something else (SUPPLY4-02).
 */
export function githubOrigin(repo) {
  let urls;
  try {
    urls = ownConfig(repo, "remote.origin.url");
  } catch {
    return null;
  }
  const name = urls.length === 1 ? GITHUB_URL.exec(urls[0])?.[1] : null;
  return name ? `https://github.com/${name}.git` : null;
}

/**
 * Fetches main without prompting, only through lib/git.mjs (HTTPS only, none of
 * this machine's git configuration, the clone's own checked first): from
 * `remote` when the caller names one (a local path, for tests), else from this
 * clone's GitHub origin over HTTPS, with the GitHub CLI's stored login when it
 * has one. Nothing else is fetched: an SSH key behind an agent like 1Password
 * would wait for an approval nobody gives at 04:00, and a git configuration's
 * rewrite could send the fetch anywhere.
 */
function fetchMain(repo, remote) {
  const url = remote ?? githubOrigin(repo);
  if (!url) return { status: 1, stderr: "origin isn't a github.com repository URL, and self-update fetches only from GitHub" };
  const gh = !remote && commandExists("gh") && spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 30_000 }).status === 0;
  try {
    return publicGit(["fetch", "--quiet", url, "main"], { url, repo, timeout: DEADLINES.fetch, config: gh ? ["credential.helper=!gh auth git-credential"] : [] });
  } catch (error) {
    // The clone's own git configuration would send the fetch elsewhere (lib/git.mjs checkRepoTransport).
    return { status: 1, stderr: error.message };
  }
}

/** The signature on a raw commit object: "ssh", "openpgp", "x509", "unknown" (several, or another kind), or null when unsigned. */
export function signatureKind(raw) {
  const end = raw.indexOf("\n\n");
  const headers = [...(end === -1 ? raw : raw.slice(0, end)).matchAll(/^gpgsig(?:-sha256)? (.*)$/gm)];
  if (!headers.length) return null;
  if (headers.length > 1) return "unknown";
  return { "-----BEGIN SSH SIGNATURE-----": "ssh", "-----BEGIN PGP SIGNATURE-----": "openpgp", "-----BEGIN SIGNED MESSAGE-----": "x509" }[headers[0][1].trim()] ?? "unknown";
}

/** The principals an allowed-signers file lists. */
export function principalsOf(text) {
  const principals = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const field = trimmed.startsWith('"') ? trimmed.slice(1, trimmed.indexOf('"', 1)) : trimmed.split(/\s+/)[0];
    for (const principal of field.split(",")) if (principal) principals.add(principal);
  }
  return principals;
}

/** { principal } when `sha` carries a good SSH signature from a listed principal, else { problem }. */
function signer(git, sha, signersFile, principals) {
  const raw = git(["cat-file", "commit", sha]);
  if (raw.status !== 0) return { problem: "can't be read" };
  const kind = signatureKind(raw.stdout);
  if (kind !== "ssh") return { problem: kind ? `is signed with ${kind === "unknown" ? "an unrecognized signature" : kind}, not an SSH key in ${SIGNERS}` : "isn't signed" };
  const checked = git(["-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${signersFile}`, "log", "-1", "--no-show-signature", "--format=%G?%x00%GS", sha]);
  const [status, principal = ""] = checked.status === 0 ? checked.stdout.split("\0") : ["E"];
  if (status !== "G" || !principals.has(principal.trim())) return { problem: `isn't signed by a key in ${SIGNERS} (${status})` };
  return { principal: principal.trim() };
}

/** Why an evaluator-signed commit is out of bounds, or null when it only moves the pin forward. */
export function botCommitProblem(sha, repo = ROOT) {
  const read = outOf(gitIn(repo));
  const parents = (read(["rev-list", "--parents", "-n", "1", sha]) ?? "").split(" ").length - 1;
  if (parents !== 1) return "is a merge or a root commit";
  const files = (read(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]) ?? "").split("\n").filter(Boolean);
  if (files.length !== 1 || files[0] !== PIN_FILE) return `changes ${files.join(", ") || "nothing"}, not just ${PIN_FILE}`;
  let next;
  try {
    next = validatePin(JSON.parse(read(["show", `${sha}:${PIN_FILE}`]) ?? "null"));
  } catch (error) {
    return `leaves ${error.message}`;
  }
  // The first pin, and a channel's first, have nothing trusted to be measured
  // against (dependency age, device tools): the owner signs those.
  const before = read(["show", `${sha}^:${PIN_FILE}`]);
  if (before === null) return `creates ${PIN_FILE}; its first version needs a commit you sign`;
  let previous;
  try {
    previous = validatePin(JSON.parse(before));
  } catch (error) {
    return `follows an invalid ${PIN_FILE} (${error.message})`;
  }
  const backward = backwardMove(previous, next);
  if (backward) return backward;
  const added = Object.keys(next.channels).filter((channel) => !previous.channels[channel]);
  if (added.length) return `adds a ${added.join(", ")} pin; a channel's first pin needs a commit you sign`;
  const approved = [...addedApprovals(previous, next)];
  const moved = Object.entries(next.channels).some(([channel, entry]) => compareRefs(entry.ref, previous.channels[channel].ref) > 0);
  if (approved.length && !moved) return `approves device tools ${approved.join(", ")} without moving a channel forward`;
  return null;
}

/** Device tools `next` approves, or locks, that `previous` didn't. */
const addedApprovals = (previous, next) =>
  new Set([
    ...next.deviceTools.filter((tool) => !previous.deviceTools.includes(tool)),
    ...Object.keys(next.deviceToolLocks ?? {}).filter((tool) => !Object.hasOwn(previous.deviceToolLocks ?? {}, tool)),
  ]);

/** A list file's entries at a commit (comments and blank lines dropped); empty when the file isn't there. */
const listAt = (out, rev, file) =>
  (out(["show", `${rev}:${file}`]) ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);

/**
 * The fast lane (lib/fastlane.mjs) for dependencies new since the release with
 * lockfile `baseLock`, from what only upstream (that release's lockfile and
 * device tool pins, `toolsText`) and the owner (`overrides`) wrote. Made once, on
 * the first young version; when it can't be (OSV unreachable, say), nothing is
 * waived, which only ever holds more back.
 */
function lazyFastLane({ baseLock, toolsText, overrides, advisories, now }) {
  let lane = null;
  const make = async () => {
    try {
      const packages = trustedInventory({ upstreamLock: baseLock, deviceTools: deviceToolsInUse(toolsText()), overrides: overrides() });
      return makeFastLane({ basePackages: packages, openAdvisories: await advisories(packages), now });
    } catch {
      return null;
    }
  };
  return async (pkg) => {
    lane ??= make();
    const waive = await lane;
    return waive ? waive(pkg) : null;
  };
}

/**
 * One evaluator commit's gates, worked out here (see the top of this file).
 * `snapshot` holds the releases it moves to and the ones it moves from
 * (lib/git.mjs releaseSnapshot). Returns { result: "refused" | "held" |
 * "skipped", message } or null; a throw marked `transient` means skipped.
 */
async function botCommitGates({ short, before, after, moved, snapshot, out, sha, upstream, isKnownHost, reviewClosure, advisories, now, report }) {
  const approved = [...addedApprovals(before, after)];
  if (approved.length) {
    const pinned = new Set(moved.flatMap(([, entry]) => deviceToolsInUse(snapshot.show(entry.sha, DEVICE_TOOL_PINS))));
    const stray = approved.filter((tool) => !pinned.has(tool));
    if (stray.length) return { result: "refused", message: `evaluator commit ${short} approves ${stray.join(", ")}, which ${moved.map(([, entry]) => entry.ref).join(", ")} doesn't pin` };
    const known = new Set(listAt(out, `${sha}^`, KNOWN_HOSTS));
    const { isReservedHost } = isKnownHost ? {} : await import("./build.mjs");
    let reviews;
    try {
      reviews = await reviewAddedDeviceTools(before.deviceTools, after.deviceTools, {
        knownDeviceTools: listAt(out, `${sha}^`, KNOWN_DEVICE_TOOLS),
        isKnownHost: isKnownHost ?? ((host) => known.has(host) || isReservedHost(host)),
        closure: reviewClosure,
        locks: after.deviceToolLocks ?? {},
        previousLocks: before.deviceToolLocks ?? {},
        now,
      });
    } catch (error) {
      return { result: "skipped", message: `couldn't review the device tools evaluator commit ${short} approves (${error.message})` };
    }
    const failed = reviews.find((review) => !review.ok);
    if (failed) return { result: "refused", message: `evaluator commit ${short} approves device tool ${failed.tool}, which fails review here: ${failed.reasons.join("; ")}` };
  }
  for (const [channel, entry] of moved) {
    const previous = before.channels[channel];
    const [baseLock, lock] = [snapshot.show(previous.sha, "pnpm-lock.yaml"), snapshot.show(entry.sha, "pnpm-lock.yaml")];
    if (!baseLock || !lock) return { result: "refused", message: `evaluator commit ${short}: no pnpm-lock.yaml at ${baseLock ? entry.ref : previous.ref}` };
    try {
      lockIdentities(baseLock);
      lockIdentities(lock);
    } catch (error) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, whose dependencies can't be checked: ${error.message}` };
    }
    const waive = lazyFastLane({
      baseLock,
      toolsText: () => snapshot.show(previous.sha, DEVICE_TOOL_PINS),
      overrides: () => {
        const text = out(["show", `${sha}^:${OVERRIDES}`]);
        return text === null ? [] : parseOverrides(text);
      },
      advisories,
      now,
    });
    let gate;
    try {
      gate = await dependencyAgeGate(baseLock, lock, { waive, now });
    } catch (error) {
      return { result: "skipped", message: `couldn't check the dependencies ${entry.ref} adds (${error.message})` };
    }
    if (gate.substituted.length) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, which changes or misstates dependencies' bytes: ${heldDependencies({ young: [], unknown: [], substituted: gate.substituted }).join(", ")}` };
    }
    const held = heldDependencies(gate);
    if (held.length) {
      return { result: "held", message: `evaluator commit ${short} pins ${entry.ref}, which adds dependencies under ${MIN_AGE_DAYS} days old over ${previous.ref}; waiting until they're old enough: ${held.join(", ")}` };
    }
    for (const { pkg, reason } of gate.waived) report(`evaluator commit ${short}: fast lane: ${pkg}: ${reason}`);
  }
  return null;
}

/**
 * Every evaluator commit in the update, with its gates worked out here, in
 * order, each against the pin before it (this clone's, a commit the owner signed,
 * or an evaluator commit that passed just before). { result: "refused" | "held" |
 * "skipped", message } or null; "skipped" when npm or upstream can't be reached,
 * "held" while a dependency is too young (each run retries).
 */
async function evaluatorProblem(git, { head, tip, bot, upstream, isKnownHost, reviewClosure, advisories, now, report }) {
  const out = outOf(git);
  const pinAt = (rev) => {
    const text = out(["show", `${rev}:${PIN_FILE}`]);
    if (text === null) return null;
    try {
      return validatePin(JSON.parse(text));
    } catch {
      return null;
    }
  };
  for (const sha of bot) {
    const short = sha.slice(0, 10);
    // botCommitProblem has checked both pins are valid and the move is forward.
    const [before, after] = [pinAt(`${sha}^`), pinAt(sha)];
    const moved = Object.entries(after.channels).filter(([channel, entry]) => before.channels[channel].ref !== entry.ref || before.channels[channel].sha !== entry.sha);
    if (!moved.length && !addedApprovals(before, after).size) continue;
    try {
      const why = unreleasedPin(before, after, upstream);
      if (why) return { result: "refused", message: `evaluator commit ${short} ${why}` };
    } catch (error) {
      return { result: "skipped", message: `couldn't check the tags evaluator commit ${short} pins upstream (${error.message})` };
    }
    let snapshot;
    try {
      // The releases it moves to by tag (just checked upstream); the ones it moves
      // from by commit: they're trusted already, whatever their tags say now.
      snapshot = releaseSnapshot(
        moved.map(([, entry]) => ({ ref: entry.ref, sha: entry.sha })),
        { url: upstream, trusted: moved.map(([channel]) => before.channels[channel].sha) },
      );
    } catch (error) {
      return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
    }
    try {
      const problem = await botCommitGates({ short, before, after, moved, snapshot, out, sha, upstream, isKnownHost, reviewClosure, advisories, now, report });
      if (problem) return problem;
    } catch (error) {
      return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
    } finally {
      snapshot.close();
    }
  }
  const final = pinAt(tip);
  if (!final) return null;
  try {
    const why = unreleasedPin(pinAt(head), final, upstream);
    return why ? { result: "refused", message: `the update ${why}` } : null;
  } catch (error) {
    return { result: "skipped", message: `couldn't check the pinned tags upstream (${error.message})` };
  }
}

/**
 * Fast-forwards this clone to signed new commits on main: "updated", "refused",
 * "held" (an evaluator pin waits for its dependencies to age) or "skipped". Call
 * it holding the update lock. The options other than `report` are for tests
 * (`remote`: where main is fetched from instead of origin's GitHub repository).
 */
export async function selfUpdate({ repo = ROOT, remote = null, upstream = UPSTREAM_URL, report = log, isKnownHost = null, reviewClosure, advisories = openAdvisories, now = Date.now() } = {}) {
  const git = gitIn(repo);
  const out = outOf(git);
  const head = out(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const signers = head ? out(["show", `${head}:${SIGNERS}`]) : null;
  if (!signers) return "skipped";
  if (out(["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") {
    report("self-update skipped: not on main");
    return "skipped";
  }
  if (out(["status", "--porcelain", "--untracked-files=no"])) {
    report("self-update skipped: uncommitted changes");
    return "skipped";
  }
  const fetched = fetchMain(repo, remote);
  if (fetched.status !== 0) {
    report(`self-update skipped: couldn't fetch (${(fetched.stderr || fetched.error?.message || "timed out").trim().split("\n")[0]})`);
    return "skipped";
  }
  const tip = out(["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  if (!tip || tip === head) return "skipped";
  if (git(["merge-base", "--is-ancestor", head, tip]).status !== 0) {
    report(`self-update refused: origin/main (${tip.slice(0, 10)}) isn't a fast-forward of this clone`);
    return "refused";
  }
  const commits = (out(["rev-list", "--reverse", `${head}..${tip}`]) ?? "").split("\n").filter(Boolean);
  if (!commits.length) return "skipped";
  const bot = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-signers-"));
  try {
    const file = path.join(dir, "allowed_signers");
    fs.writeFileSync(file, `${signers}\n`, { mode: 0o600 });
    const principals = principalsOf(signers);
    for (const sha of commits) {
      const signed = signer(git, sha, file, principals);
      if (signed.problem) {
        report(`self-update refused: commit ${sha.slice(0, 10)} ${signed.problem}`);
        return "refused";
      }
      if (signed.principal === BOT_PRINCIPAL) bot.push(sha);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const sha of bot) {
    const why = botCommitProblem(sha, repo);
    if (why) {
      report(`self-update refused: evaluator commit ${sha.slice(0, 10)} ${why}`);
      return "refused";
    }
  }
  // A later commit the owner signed that rewrites pin.json vouches for all of it,
  // so the evaluator commits before it need no gates of their own (their shape
  // above still counts): the owner can always replace a pin the evaluator's key
  // shouldn't have made, and machines held on it move on unattended.
  const pinChanged = (sha) => out(["rev-parse", "--verify", "--quiet", `${sha}:${PIN_FILE}`]) !== out(["rev-parse", "--verify", "--quiet", `${sha}^1:${PIN_FILE}`]);
  const lastOwnerPin = commits.findLastIndex((sha) => !bot.includes(sha) && pinChanged(sha));
  const gated = bot.filter((sha) => commits.indexOf(sha) > lastOwnerPin);
  if (gated.length) {
    const problem = await evaluatorProblem(git, { head, tip, bot: gated, upstream, isKnownHost, reviewClosure, advisories, now, report });
    if (problem) {
      report(`self-update ${problem.result}: ${problem.message}`);
      return problem.result;
    }
  }
  if (git(["merge", "--ff-only", "--quiet", tip]).status !== 0) {
    report("self-update failed to fast-forward");
    return "skipped";
  }
  const landed = out(["rev-parse", "HEAD"]);
  if (landed !== tip) {
    report(`self-update refused: HEAD is ${landed?.slice(0, 10) ?? "unknown"} after fast-forwarding to the verified ${tip.slice(0, 10)}`);
    return "refused";
  }
  report(`self-updated t3blackout to ${tip.slice(0, 10)} (${commits.length} signed commit(s)${bot.length ? `, ${bot.length} from the evaluator` : ""})`);
  return "updated";
}
