// The evaluator's commit job (bin/t3blackout pin-check, .github/workflows/
// evaluate.yml): the only place the evaluator's signing key is used, on a fresh
// runner that runs no upstream or npm code. The evaluate job built upstream, so
// its pin.json and resolved lockfiles are only a proposal: everything that can be
// decided from git, npm and OSV without running upstream code is decided again
// here before the pin is signed.
//
// This job is advisory too. It can't know that the evaluate job's build really
// compiled, scanned clean and passed the smoke test, and its key could be stolen.
// Each Mac is the authority: it re-derives the gates a pin's commit claims to
// pass before taking it (lib/selfupdate.mjs: tags, device tools, dependency age
// against the pin it already trusts) and builds, scans and smoke-tests the
// release itself before installing anything (lib/build.mjs). A forged verdict
// can make an update be held or fail there, never install unchecked code.
//
// A candidate may move only the channel that was evaluated, strictly forward, to
// a tag that names that commit upstream, and may add device tool approvals only
// for versions that release pins and that pass review, each with the dependency
// lockfile every machine installs it from. Its new dependencies must
// pass the age gate (with the same fast lane), its resolved lockfile must fit
// upstream's, and the strip rules must still apply (applying them reads upstream
// source; it runs none of it).

import { baseExposure, resolvedLockProblems } from "./evaluate.mjs";
import { featureByName } from "./features.mjs";
import { MIN_AGE_DAYS } from "./gates.mjs";
import { DEVICE_TOOL_PINS, deviceToolsInUse } from "./inventory.mjs";
import { backwardMove, compareRefs, validatePin } from "./pin.mjs";

const sameEntry = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Checks `candidate` (the evaluate job's pin.json for `channel`) against
 * `current` (main's): resolves "unchanged" or "changed", throws why not otherwise.
 * `io`: the evaluator's (lib/evaluate.mjs networkIo, show, knownDeviceTools,
 * checkRules, log) plus unreleasedPin(previous, next) and resolvedLock(sha).
 */
export async function verifyCandidate({ current, candidate, channel }, io) {
  validatePin(candidate);
  if (!current) throw new Error("main has no pin.json; the first pin needs a commit you sign");
  if (sameEntry(current, candidate)) return "unchanged";
  const backward = backwardMove(current, candidate);
  if (backward) throw new Error(`refusing a pin that ${backward}`);
  for (const name of new Set([...Object.keys(current.channels), ...Object.keys(candidate.channels)])) {
    if (name === channel) continue;
    if (!sameEntry(current.channels[name], candidate.channels[name])) throw new Error(`refusing a pin that changes ${name}; this run evaluated ${channel}`);
  }
  const before = current.channels[channel];
  const after = candidate.channels[channel];
  if (!before) throw new Error(`refusing a pin that adds a ${channel} pin; a channel's first pin needs a commit you sign`);
  if (compareRefs(after.ref, before.ref) <= 0) throw new Error(`refusing a pin that doesn't move ${channel} forward from ${before.ref} (to ${after.ref})`);
  const notReleased = io.unreleasedPin(current, candidate);
  if (notReleased) throw new Error(`refusing a pin that ${notReleased}`);

  // Device tools: only versions this release pins, each reviewed here.
  const inUse = deviceToolsInUse(io.show(after.sha, DEVICE_TOOL_PINS));
  const added = candidate.deviceTools.filter((tool) => !current.deviceTools.includes(tool));
  const unused = added.filter((tool) => !inUse.includes(tool));
  if (unused.length) throw new Error(`refusing a pin that approves device tools ${after.ref} doesn't pin: ${unused.join(", ")}`);
  // Their dependency lockfiles (deviceToolLocks): a new one only for a tool this
  // release pins, each verified against npm and reviewed against the last one.
  const locks = candidate.deviceToolLocks ?? {};
  const previousLocks = current.deviceToolLocks ?? {};
  const newLocks = Object.keys(locks).filter((tool) => !sameEntry(locks[tool], previousLocks[tool]));
  const stray = newLocks.filter((tool) => !inUse.includes(tool));
  if (stray.length) throw new Error(`refusing a pin that keeps dependency lockfiles for device tools ${after.ref} doesn't pin: ${stray.join(", ")}`);
  const known = io.knownDeviceTools();
  for (const review of await io.reviewAddedDeviceTools(current.deviceTools, candidate.deviceTools, known, { locks, previousLocks })) {
    if (!review.ok) throw new Error(`refusing a pin that approves ${review.tool}: ${review.reasons.join("; ")}`);
  }
  const approved = new Set([...known, ...candidate.deviceTools]);
  const unreviewed = inUse.filter((tool) => !approved.has(tool));
  if (unreviewed.length) throw new Error(`refusing a pin to ${after.ref}, which pins unreviewed device tools ${unreviewed.join(", ")}`);
  const unlocked = inUse.filter((tool) => !locks[tool]);
  if (unlocked.length) throw new Error(`refusing a pin to ${after.ref} with no dependency lockfile for device tools it pins: ${unlocked.join(", ")}`);

  // Dependencies new since the pinned release, with the fast lane the evaluator had.
  const baseLock = io.show(before.sha, "pnpm-lock.yaml");
  const lock = io.show(after.sha, "pnpm-lock.yaml");
  if (!baseLock || !lock) throw new Error(`no pnpm-lock.yaml at ${baseLock ? after.ref : before.ref}`);
  const exposure = await baseExposure({ sha: before.sha, upstreamLock: baseLock, deviceToolsText: io.show(before.sha, DEVICE_TOOL_PINS) }, io);
  if (exposure.problem) io.log(`no fast lane: ${exposure.problem}`);
  const waive = exposure.packages ? io.makeFastLane({ basePackages: exposure.packages, openAdvisories: exposure.open }) : null;
  const gate = await io.dependencyAgeGate(baseLock, lock, { waive });
  const young = [...gate.young.map(({ pkg, publishedAt }) => `${pkg} (published ${publishedAt})`), ...gate.unknown.map((pkg) => `${pkg} (no publish time)`)];
  if (young.length) throw new Error(`refusing a pin to ${after.ref}: dependencies under ${MIN_AGE_DAYS} days old: ${young.join(", ")}`);
  const swapped = (gate.substituted ?? []).map(({ pkg, why }) => `${pkg} ${why}`);
  if (swapped.length) throw new Error(`refusing a pin to ${after.ref}: dependencies whose bytes changed or aren't the registry's: ${swapped.join(", ")}`);
  for (const { pkg, reason } of gate.waived) io.log(`fast lane: ${pkg}: ${reason}`);

  // What a build of it installs, as the evaluate job resolved it.
  const resolvedLock = io.resolvedLock(after.sha);
  if (resolvedLock == null) throw new Error(`no resolved lockfile for ${after.ref} from the evaluate job`);
  const problems = await resolvedLockProblems({ upstreamLock: lock, resolvedLock }, io);
  if (problems.length) throw new Error(`refusing a pin to ${after.ref}: ${problems.join("; ")}`);

  // The strip rules, applied to upstream's source (nothing of it runs).
  const check = io.checkRules(after.ref, after.sha, { baseline: before.sha, approvals: added, locks });
  if (!check.ok) throw new Error(`refusing a pin to ${after.ref}: ${String(check.message ?? "the strict rules don't apply").split("\n")[0]}`);
  // A build can leave out more (a feature that doesn't compile); never less.
  const missing = check.skipped.filter((name) => !after.leftOut.includes(name));
  if (missing.length) throw new Error(`refusing a pin to ${after.ref} that doesn't list features its rules leave out: ${missing.sort().join(", ")}`);
  const unknown = after.leftOut.filter((name) => !featureByName(name));
  if (unknown.length) throw new Error(`refusing a pin that leaves out features that don't exist: ${unknown.join(", ")}`);
  return "changed";
}
