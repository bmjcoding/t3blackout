// The upstream mirror: fetching it, and reading releases out of it.

import * as fs from "node:fs";
import * as path from "node:path";

import { DEADLINES, UPSTREAM_URL, publicGitOrThrow } from "./git.mjs";
import { compareRefs, isReleaseTag } from "./pin.mjs";
import { MIRROR, mirrorGit, mirrorOut } from "./util.mjs";

export { UPSTREAM_URL };

/**
 * A release must be this old before it's built, so a bad one has time to be
 * noticed and pulled upstream first. `--ref` skips it.
 */
export const SOAK_HOURS = Number(process.env.T3BLACKOUT_SOAK_HOURS ?? 48);

export const hasMirror = () => fs.existsSync(path.join(MIRROR, ".git"));

/**
 * Clones or updates the mirror. Blobless and without a checkout of its own:
 * file contents arrive only for the commits a build checks out, so it stays a
 * fraction of a full clone's size. Over HTTPS only and within a deadline
 * (lib/git.mjs), whatever this machine's git configuration says.
 */
export function fetchUpstreamHere() {
  const opts = { url: UPSTREAM_URL, stdio: ["ignore", "inherit", "pipe"] };
  if (!hasMirror()) {
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    publicGitOrThrow(["clone", "--quiet", "--filter=blob:none", "--no-checkout", "--", UPSTREAM_URL, MIRROR], { ...opts, timeout: DEADLINES.clone }, "cloning upstream");
  }
  mirrorOut(["fetch", "--quiet", "--tags", "--force", "origin"], { fetch: true, stdio: opts.stdio, timeout: DEADLINES.fetch }, "fetching upstream");
}

/** The app calls the stable channel "latest". */
export const cliChannel = (channel) => (channel === "latest" ? "stable" : channel);

/** Every tag in the mirror, with when it was made (unix seconds). */
function mirrorTagTimes() {
  return mirrorOut(["for-each-ref", "--format=%(refname) %(creatordate:unix)", "refs/tags"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, time] = line.split(" ");
      return { tag: name.replace(/^refs\/tags\//, ""), time: Number(time) };
    });
}

/** Every tag name in the mirror. */
export const mirrorTags = () => mirrorTagTimes().map(({ tag }) => tag);

/**
 * Release tags on a channel that have soaked, newest release first; tags look
 * like v0.1.1-nightly.20261017.3234. Only canonical release tags count (pin.mjs),
 * ordered by release, not by tag date.
 */
export function soakedTags(name, { soakHours = SOAK_HOURS } = {}) {
  const channel = cliChannel(name);
  if (!["nightly", "preview", "stable"].includes(channel)) throw new Error(`unknown channel ${channel}`);
  const tags = mirrorTagTimes()
    .filter(({ tag }) => isReleaseTag(tag, channel))
    .sort((a, b) => compareRefs(b.tag, a.tag));
  if (!tags.length) throw new Error(`no ${channel} tags upstream`);
  const cutoff = Date.now() / 1000 - soakHours * 3600;
  const soaked = tags.filter(({ time }) => time <= cutoff).map(({ tag }) => tag);
  if (!soaked.length) throw new Error(`no ${channel} release is ${soakHours} hours old yet`);
  return soaked;
}

/** Newest release tag on a channel that has soaked. */
export const resolveRef = (name, options) => soakedTags(name, options)[0];

export const revParse = (ref) => mirrorOut(["rev-parse", `${ref}^{commit}`]);

export const commitTime = (sha) => Number(mirrorOut(["log", "-1", "--format=%ct", sha]));

/** App version for a ref: the tag itself, or the nearest tag for a branch or sha. */
export function versionOf(ref, sha) {
  if (/^v\d/.test(ref)) return ref.slice(1);
  const tag = mirrorGit(["describe", "--tags", "--abbrev=0", sha]).stdout?.trim();
  return tag ? tag.replace(/^v/, "") : "0.0.0";
}

/** Upstream commit titles since the installed build, in electron-updater's release-notes shape. */
export function releaseNotes(fromSha, toSha, version) {
  if (!fromSha) return [];
  const result = mirrorGit(["log", "--reverse", "--no-merges", "--format=- %s", `${fromSha}..${toSha}`]);
  const note = result.status === 0 ? result.stdout.trim() : "";
  return note ? [{ version, note }] : [];
}

/** Commits in the upstream mirror for `fromSha..toSha`, newest first, merges skipped. */
export function upstreamCommits(fromSha, toSha, limit = 40) {
  const result = mirrorGit(["log", "--no-merges", `--max-count=${limit}`, "--format=%H%x09%s", `${fromSha}..${toSha}`]);
  return result.status === 0 ? parseCommitLines(result.stdout) : [];
}

/**
 * Commits in `fromSha..toSha`, oldest first, merges skipped, with what a
 * reviewer needs: [{ sha, title, pr, body (trimmed), files (the first 25), fileCount }].
 */
export function commitDetails(fromSha, toSha, limit = 600) {
  const result = mirrorGit(["log", "--reverse", "--no-merges", `--max-count=${limit}`, "--name-only", "--format=%x1e%H%x1f%s%x1f%b%x1f", `${fromSha}..${toSha}`]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\x1e")
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, title, body, rest = ""] = record.split("\x1f");
      const files = rest.split("\n").filter(Boolean);
      const trimmed = body
        .split("\n")
        .filter((line) => !/^(co-authored-by|signed-off-by):/i.test(line.trim()))
        .join("\n")
        .trim();
      return {
        sha,
        title,
        pr: Number(/\(#(\d+)\)\s*$/.exec(title)?.[1]) || null,
        body: trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed,
        files: files.slice(0, 25),
        fileCount: files.length,
      };
    });
}

/** `git log --format=%H%x09%s` output as [{ sha, title }]. */
export function parseCommitLines(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), title: line.slice(tab + 1) };
    });
}

/** A GitHub remote (https or ssh form) as its web URL, or null for anything else. */
export function githubWebUrl(remote) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote?.trim() ?? "");
  return match ? `https://github.com/${match[1]}` : null;
}

/** The upstream repository's web URL: the one the mirror is held to (lib/git.mjs), not whatever its configuration says. */
export const upstreamWebUrl = () => githubWebUrl(UPSTREAM_URL);

/** The nearest release tag before `sha`, e.g. v0.1.1-nightly.20261016.3201, or null. */
export function previousTag(sha) {
  const result = mirrorGit(["describe", "--tags", "--abbrev=0", `${sha}^`]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

