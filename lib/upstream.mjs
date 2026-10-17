// The upstream mirror: fetching it, and reading releases out of it.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { MIRROR, capture, gitMirror, run } from "./util.mjs";

export const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

/**
 * A release must be this old before it's built, so a bad one has time to be
 * noticed and pulled upstream first. `--ref` skips it.
 */
export const SOAK_HOURS = Number(process.env.T3BLACKOUT_SOAK_HOURS ?? 48);

export const hasMirror = () => fs.existsSync(path.join(MIRROR, ".git"));

/**
 * Clones or updates the mirror. Blobless and without a checkout of its own:
 * file contents arrive only for the commits a build checks out, so it stays a
 * fraction of a full clone's size.
 */
export function fetchUpstreamHere() {
  if (!hasMirror()) {
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", UPSTREAM_URL, MIRROR]);
  }
  run("git", gitMirror(["fetch", "--quiet", "--tags", "--force", "origin"]));
}

/** The app calls the stable channel "latest". */
export const cliChannel = (channel) => (channel === "latest" ? "stable" : channel);

/** Newest release tag on a channel that has soaked; tags look like v0.1.1-nightly.20261017.3234. */
export function resolveRef(name, { soakHours = SOAK_HOURS } = {}) {
  const channel = cliChannel(name);
  const pattern = { nightly: "v*-nightly.*", preview: "v*-preview.*", stable: "v[0-9]*" }[channel];
  if (!pattern) throw new Error(`unknown channel ${channel}`);
  const tags = capture("git", gitMirror(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short) %(creatordate:unix)", `refs/tags/${pattern}`]))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, time] = line.split(" ");
      return { tag, time: Number(time) };
    })
    .filter(({ tag }) => channel !== "stable" || /^v\d+\.\d+\.\d+$/.test(tag));
  if (!tags.length) throw new Error(`no ${channel} tags upstream`);
  const cutoff = Date.now() / 1000 - soakHours * 3600;
  const soaked = tags.find(({ time }) => time <= cutoff);
  if (!soaked) throw new Error(`no ${channel} release is ${soakHours} hours old yet`);
  return soaked.tag;
}

export const revParse = (ref) => capture("git", gitMirror(["rev-parse", `${ref}^{commit}`]));

export const commitTime = (sha) => Number(capture("git", gitMirror(["log", "-1", "--format=%ct", sha])));

/** App version for a ref: the tag itself, or the nearest tag for a branch or sha. */
export function versionOf(ref, sha) {
  if (/^v\d/.test(ref)) return ref.slice(1);
  const tag = spawnSync("git", gitMirror(["describe", "--tags", "--abbrev=0", sha]), { encoding: "utf8" }).stdout?.trim();
  return tag ? tag.replace(/^v/, "") : "0.0.0";
}

/** Upstream commit titles since the installed build, in electron-updater's release-notes shape. */
export function releaseNotes(fromSha, toSha, version) {
  if (!fromSha) return [];
  const result = spawnSync("git", gitMirror(["log", "--reverse", "--no-merges", "--format=- %s", `${fromSha}..${toSha}`]), {
    encoding: "utf8",
  });
  const note = result.status === 0 ? result.stdout.trim() : "";
  return note ? [{ version, note }] : [];
}
