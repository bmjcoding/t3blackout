// The build the app chose, checked by the CLI before it builds or installs one.
// The app's updater (lib/files/BlackoutUpdater.ts) passes the commit its check
// offered to `update --expect-sha`, and the build it announced as downloaded to
// `apply --expect-sha --expect-blackout`, so neither a release that moved after
// the check nor a build staged meanwhile is built or installed in their place.

const SHA = /^[0-9a-f]{40}$/;

/** { sha, blackout } from --expect-sha and --expect-blackout, or null without them. Throws on a malformed one. */
export function expectedBuild(opts) {
  const sha = opts["expect-sha"];
  const blackout = opts["expect-blackout"];
  if (sha === undefined && blackout === undefined) return null;
  if (!SHA.test(sha ?? "")) throw new Error(`--expect-sha needs a full upstream commit, not ${JSON.stringify(sha ?? "")}`);
  if (blackout !== undefined && !SHA.test(blackout)) throw new Error(`--expect-blackout needs a full t3blackout commit, not ${JSON.stringify(blackout)}`);
  return { sha, blackout: blackout ?? null };
}

/** Whether `build` ({ sha, blackout }) is the expected one; anything is, when nothing was expected. */
export const isExpectedBuild = (build, expected) =>
  !expected || (build?.sha === expected.sha && (!expected.blackout || build.blackout === expected.blackout));

const short = (sha) => String(sha ?? "nothing").slice(0, 10);

/** Why a build differs from the expected one, for the app to show. */
export const unexpectedBuildMessage = (what, build, expected) =>
  `${what} is ${build?.version ?? build?.ref ?? "nothing"} (${short(build?.sha)}${expected.blackout ? `, rules ${short(build?.blackout)}` : ""}), ` +
  `not the ${short(expected.sha)}${expected.blackout ? ` (rules ${short(expected.blackout)})` : ""} this app chose`;

/**
 * What `poll` offers, decided as `update` would act: `target` ({ ref, sha }, the
 * release update builds; null without a mirror) when it isn't installed, else
 * the build staged since the last install. A staged build is offered as built
 * only when it is that release made with `rules` (this checkout's commit, which
 * update builds with): one made with other rules is offered as a download, which
 * rebuilds it, since the app installs whatever it was told is built.
 * Returns { ref, sha, staged, from: "target" | "pending" }, or null.
 */
export function pollOffer({ current, pending, target, rules }) {
  const built = (record, sha) => Boolean(rules) && record?.sha === sha && record.blackout === rules;
  if (target && target.sha !== current.sha) return { ref: target.ref, sha: target.sha, staged: built(pending, target.sha), from: "target" };
  if (!pending || !(pending.stagedAt > (current.installedAt ?? "")) || (target && pending.sha !== target.sha)) return null;
  const staged = built(pending, pending.sha);
  // Stale, but what update would build is installed already.
  if (!staged && built(current, pending.sha)) return null;
  return { ref: pending.ref, sha: pending.sha, staged, from: "pending" };
}

/**
 * Why a staged build mustn't be installed now: it was built with other strip
 * rules than this checkout's (`rules`, its HEAD), e.g. after a self-update
 * whose rebuild failed. `update` rebuilds it; null when it's current.
 */
export const staleRulesProblem = (pending, rules) =>
  rules && pending?.blackout !== rules
    ? `the staged build was made with T3 Blackout ${pending?.blackout?.slice(0, 12) ?? "(unknown)"}, not this checkout's ${rules.slice(0, 12)}; run \`t3blackout update\` to rebuild it`
    : null;
