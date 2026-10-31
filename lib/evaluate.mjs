// The evaluator (bin/t3blackout evaluate, run by .github/workflows/evaluate.yml):
// picks the newest release on a channel, newer than pin.json's, that passes every
// gate. Newest first in release order, up to MAX_FALLBACK back. A release is held
// when it:
//   - pins a device tool version whose code or dependency closure fails review
//     (lib/gates.mjs, lib/device-tools.mjs),
//   - adds a dependency version published under MIN_AGE_DAYS ago,
//   - breaks a strict rule or names an unknown network host (checkRules),
//   - resolves, with the security overrides, to a lockfile that doesn't fit
//     upstream's or adds a young version (lib/inventory.mjs),
//   - with `build`: doesn't typecheck, leaks a forbidden endpoint, or fails the
//     offline smoke test (buildArtifact).
// A young dependency version may skip the age gate when it fixes an advisory open
// against the pinned release, or is an Electron with a Node.js or Chromium security
// update, and its publisher and provenance check out (lib/fastlane.mjs).
//
// Everything outside this module comes in through `io`, so the evaluation can run
// against fakes (test/pipeline-*.test.mjs). The evaluate job is untrusted: what it
// writes is only a proposal, which the commit job re-derives (lib/pincheck.mjs).

import { findAdvisories, isAlerting } from "./advisories.mjs";
import { makeFastLane, runtimeAdvisories } from "./fastlane.mjs";
import { MIN_AGE_DAYS, dependencyAgeGate, npmMeta, reviewAddedDeviceTools } from "./gates.mjs";
import { proposeToolLock } from "./device-tools.mjs";
import { DEVICE_TOOL_PINS, alertInventory, checkStageRecord, checkedResolvedLock, deviceToolsInUse, stagePlatform, stageRecord, trustedInventory } from "./inventory.mjs";
import { readOverrides } from "./overrides.mjs";
import { compareRefs, isReleaseTag, validatePin } from "./pin.mjs";
import { checkResolution } from "./resolution.mjs";

/** How many releases back the evaluator looks for one that passes. */
export const MAX_FALLBACK = 5;

/**
 * Release tags on `channel` newer than `pinnedRef`, newest first by release
 * order (not tag or commit dates), at most `limit`. Tags outside the channel's
 * release grammar (pin.mjs) are never candidates.
 */
export function releaseCandidates(tags, channel, pinnedRef, limit = MAX_FALLBACK) {
  return [...new Set(tags)]
    .filter((tag) => isReleaseTag(tag, channel))
    .filter((tag) => !pinnedRef || compareRefs(tag, pinnedRef) > 0)
    .sort((a, b) => compareRefs(b, a))
    .slice(0, limit);
}

/**
 * Every release tag on `channel` newer than `pinnedRef`, newest first, however
 * many: with none, nothing can be held. The alert job reads this from upstream
 * itself rather than take the evaluate job's word for it.
 */
export const newerReleases = (tags, channel, pinnedRef) => releaseCandidates(tags, channel, pinnedRef, Infinity);

/** OSV advisories and Electron runtime ones against `packages` (name@version). */
export async function openAdvisories(packages) {
  return [...(await findAdvisories(packages)), ...(await runtimeAdvisories(packages))];
}

/** The gates that read registries and advisory databases, never upstream code; tests replace them. */
export const networkIo = ({ isKnownHost }) => ({
  // Each device tool version `next` approves beyond `previous` and `known`: its own
  // code and the dependency closure the app installs with it, as every Mac checks too.
  // `locks`: { locks, previousLocks }, pin.json's deviceToolLocks (lib/gates.mjs).
  reviewAddedDeviceTools: (previous, next, known, locks = {}) => reviewAddedDeviceTools(previous, next, { knownDeviceTools: known, isKnownHost, ...locks }),
  // The dependency lockfile to keep for a tool already reviewed without one.
  proposeToolLock,
  dependencyAgeGate,
  npmMeta,
  openAdvisories,
  makeFastLane,
});

const lines = (text) => String(text ?? "").split("\n").filter((line) => line.trim());

/**
 * Why a resolved lockfile (the evaluate job's, overrides applied) can't be what a
 * build of the release with `upstreamLock` installs: it doesn't fit upstream's
 * lockfile, or what the overrides brought in isn't what its dependents ask for
 * on npm (lib/inventory.mjs), or it fails the check a build makes before it
 * installs one (lib/resolution.mjs: registry bytes, no overridden version
 * survives, and what the overrides add is at least MIN_AGE_DAYS old).
 */
export async function resolvedLockProblems({ upstreamLock, resolvedLock, overrides = readOverrides() }, io) {
  const { problems } = await checkedResolvedLock({ upstreamLock, resolvedLock, overrides }, { meta: io.npmMeta ?? npmMeta });
  if (!problems.length) {
    try {
      await checkResolution(upstreamLock, resolvedLock, { overrides, what: "the resolved lockfile", gate: io.dependencyAgeGate });
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems.map((problem) => `resolved lockfile: ${problem}`);
}

/**
 * What a pinned release is exposed to, for the fast lane: { packages, open }, or
 * { problem } when that can't be worked out or the advisory databases can't be
 * read (then nothing is fast-laned, which only ever holds more back). The
 * packages are lib/inventory.mjs trustedInventory: upstream's lockfile and device
 * tool pins at the pinned commit (`upstreamLock`, `deviceToolsText`, from git)
 * and the owner's overrides, never a lockfile the evaluate job resolved, so
 * nothing it adds can count as a usual publisher or an open advisory to fix.
 * Every Mac works it out the same way before it takes a pin (lib/selfupdate.mjs).
 */
export async function baseExposure({ sha, upstreamLock, deviceToolsText, overrides = readOverrides() }, io) {
  try {
    const packages = trustedInventory({ upstreamLock, deviceTools: deviceToolsInUse(deviceToolsText), overrides });
    return { packages, open: await io.openAdvisories(packages) };
  } catch (error) {
    return { problem: `${sha.slice(0, 10)}: ${error.message}` };
  }
}

/**
 * The alert job's report on what `channel`'s pin (main's, after the commit job)
 * is exposed to: { checkedAt, channel, release, sha, packages (how many were
 * checked), gaps, open }. Everything a build installs (lib/inventory.mjs
 * alertInventory, from upstream at the pinned commit through `io.show`): WORK's
 * graph as the evaluate job resolved it (`io.resolvedLock(sha)`), each device
 * tool's frozen closure (`io.toolPackages(tool, pin)`), the staged production
 * install (`io.stageRecord(sha)`), each checked, npm through `io.npmMeta`. What
 * the evaluate job didn't leave, or left and doesn't check out, is a gap: a
 * failed or timed-out evaluation still gets its advisories checked as far as git
 * and npm allow, and says what it couldn't cover.
 */
export async function advisoryReport({ pin, channel, now = () => new Date(), overrides = readOverrides() }, io) {
  const entry = pin?.channels[channel];
  if (!entry) throw new Error(`pin.json has no ${channel} pin`);
  const { packages, gaps, notes } = await alertInventory(
    {
      sha: entry.sha,
      show: io.show,
      resolvedLock: io.resolvedLock(entry.sha),
      toolPackages: (tool) => io.toolPackages(tool, pin),
      stage: io.stageRecord(entry.sha),
      overrides,
      blackout: io.blackout?.(),
    },
    { meta: io.npmMeta ?? npmMeta },
  );
  for (const line of [...notes, ...gaps.map((gap) => `not covered: ${gap}`)]) io.log?.(line);
  return { checkedAt: now().toISOString(), channel, release: entry.ref, sha: entry.sha, packages: packages.length, gaps, open: await io.openAdvisories(packages) };
}

/**
 * Evaluates one candidate: { reasons (empty when it passes), cleared (device
 * tool versions it newly needs approved), locks (the dependency lockfiles to keep
 * for them, and for any tool it pins that was reviewed without one), fastLaned,
 * leftOut, resolvedLock, stageLocks (the build's checked staged lockfiles) }.
 * Approvals are this candidate's alone; a held candidate's never carry over.
 */
async function evaluateCandidate({ ref, sha }, ctx, io) {
  const reasons = [];
  const fastLaned = [];
  const cleared = [];
  const locks = {};
  // Device tools: each version upstream pins that nobody has reviewed yet.
  let tools = [];
  try {
    tools = deviceToolsInUse(io.show(sha, DEVICE_TOOL_PINS));
  } catch (error) {
    reasons.push(error.message);
  }
  const failed = new Set();
  for (const review of await io.reviewAddedDeviceTools(ctx.approved, [...ctx.approved, ...tools], ctx.known, { previousLocks: ctx.locks })) {
    if (!review.ok) {
      failed.add(review.tool);
      reasons.push(`device tool ${review.tool}: ${review.reasons.join("; ")}`);
      continue;
    }
    cleared.push(review.tool);
    if (review.lock) locks[review.tool] = review.lock;
  }
  // Every tool a build installs needs its reviewed lockfile kept in pin.json.
  for (const tool of tools.filter((t) => !failed.has(t) && !ctx.locks[t] && !locks[t])) {
    try {
      locks[tool] = await io.proposeToolLock(tool);
    } catch (error) {
      reasons.push(`device tool ${tool}: no dependency lockfile to keep for it: ${lines(error.message)[0] ?? error}`);
    }
  }
  // Dependencies new since the pinned release must have been public a while.
  const lock = io.show(sha, "pnpm-lock.yaml");
  if (!lock || !ctx.baseLock) reasons.push(`no pnpm-lock.yaml at ${lock ? ctx.baseRef : ref}`);
  else {
    const deps = await io.dependencyAgeGate(ctx.baseLock, lock, { waive: ctx.waive });
    for (const { pkg, publishedAt } of deps.young) reasons.push(`dependency ${pkg} published ${publishedAt}, under ${MIN_AGE_DAYS} days ago`);
    for (const { pkg, reason } of deps.waived) fastLaned.push(`${pkg}: ${reason}`);
    for (const pkg of deps.unknown) reasons.push(`dependency ${pkg} has no publish time on npm`);
    for (const { pkg, why } of deps.substituted ?? []) reasons.push(`dependency ${pkg} ${why}`);
    if (deps.ok) io.log(`${deps.added} new dependency version(s), all at least ${MIN_AGE_DAYS} days old`);
  }
  let leftOut = [];
  let resolvedLock = null;
  let stageLocks = null;
  if (!reasons.length) {
    const check = io.checkRules(ref, sha, { baseline: ctx.baseSha, approvals: cleared, locks });
    if (!check.ok) reasons.push(...lines(check.message ?? "the strict rules don't apply"));
    else leftOut = check.skipped;
  }
  if (!reasons.length) {
    // The checkout the check just stripped, resolved with the overrides: what a build installs.
    resolvedLock = io.resolveLock();
    reasons.push(...(await resolvedLockProblems({ upstreamLock: lock, resolvedLock }, io)));
  }
  if (!reasons.length && ctx.build) {
    try {
      const built = await io.build(ref, sha, { baseline: ctx.baseSha, approvals: cleared, locks });
      leftOut = built.skipped;
      stageLocks = built.stageLocks ?? null;
    } catch (error) {
      reasons.push(...lines(error.message).slice(0, 20));
    }
  }
  return { reasons, cleared, locks, fastLaned, leftOut, resolvedLock, stageLocks };
}

/**
 * The pinned release's stage record when this run pins nothing new and none was
 * carried over (`io.carriedStage`): built once for it, so the alert job's
 * inventory has the staged production install too. Null, with a line in
 * `report`, when that fails.
 */
async function stageOfPinned({ baseRef, baseSha }, io, report) {
  try {
    const built = await io.build(baseRef, baseSha, { baseline: baseSha, approvals: [], locks: {} });
    return stageRecord({ sha: baseSha, locks: built.stageLocks, blackout: io.blackout?.() });
  } catch (error) {
    report.push("", `The staged production install of the pinned release, ${baseRef}, couldn't be recorded here, so the advisory check can't cover it: ${lines(error.message)[0] ?? error}`);
    return null;
  }
}

/**
 * Evaluates `channel`: { exitCode (0 pinned or already current, 3 every candidate
 * held), pin (the new pin, or null when it stays), report (Markdown), resolved
 * (Map sha -> resolved lockfile, for the pinned release and any new pin), stages
 * (Map sha -> stage record, lib/inventory.mjs: the staged production install of
 * each release built here, and the pinned release's, carried over or built) }.
 * Each lockfile and record also goes to `io.save(kind, sha, value)` ("resolved"
 * or "stage") as soon as it's known, so a run that fails or times out later still
 * hands on what it had. `ref` evaluates that one release as is; `baseline` stands
 * in for a missing pin.
 */
export async function evaluateChannel({ channel, pin, ref = null, baseline = null, build = false, now = () => new Date() }, io) {
  const pinned = pin.channels[channel] ?? null;
  // What new dependencies are measured against: the pinned release, or before
  // the first pin, --baseline.
  const baseRef = pinned?.ref ?? baseline;
  if (!baseRef) throw new Error(`no ${channel} pin to compare against; pass --baseline <release tag>`);
  const baseSha = pinned?.sha ?? io.revParse(baseRef);
  const baseLock = io.show(baseSha, "pnpm-lock.yaml");
  const resolved = new Map();
  const stages = new Map();
  const keep = (map, kind) => (sha, value) => {
    map.set(sha, value);
    io.save?.(kind, sha, value);
  };
  const keepResolved = keep(resolved, "resolved");
  const keepStage = keep(stages, "stage");
  const report = [`# Upstream evaluation: ${channel}`, "", `Pinned: ${pinned?.ref ?? "nothing yet"}. New dependencies measured against ${baseRef}, minimum age ${MIN_AGE_DAYS} days.`, ""];

  // The pinned release as built (resolved with the overrides): the alert job's
  // inventory, and what the fast lane waives against.
  let resolvedBase = null;
  try {
    const check = io.checkRules(baseRef, baseSha, { baseline: baseSha, approvals: [] });
    if (!check.ok) throw new Error(`the strip rules don't apply to it: ${lines(check.message)[0] ?? ""}`);
    resolvedBase = io.resolveLock();
    keepResolved(baseSha, resolvedBase);
  } catch (error) {
    io.log(`couldn't resolve ${baseRef}'s dependencies: ${error.message}`);
    report.push(`The pinned release's dependencies couldn't be resolved here, so the advisory check can't cover what the security overrides bring in or its staged install: ${lines(error.message)[0] ?? error}`, "");
  }
  const exposure = await baseExposure({ sha: baseSha, upstreamLock: baseLock, deviceToolsText: io.show(baseSha, DEVICE_TOOL_PINS) }, io);
  if (exposure.problem) report.push(`What the pinned release is exposed to couldn't be worked out, so no security fix skips the age gate: ${exposure.problem}`, "");
  const ctx = {
    baseRef,
    baseSha,
    baseLock,
    build,
    known: io.knownDeviceTools(),
    approved: pin.deviceTools,
    locks: pin.deviceToolLocks ?? {},
    waive: exposure.packages ? io.makeFastLane({ basePackages: exposure.packages, openAdvisories: exposure.open }) : null,
  };

  // The pinned release's staged install from the run that built it (its stage
  // record's text), if it still checks out as the alert job will check it;
  // otherwise it's built again below.
  const carried = pinned ? (io.carriedStage?.(baseSha) ?? null) : null;
  if (carried !== null) {
    try {
      if (resolvedBase === null) throw new Error("its dependencies couldn't be resolved here to check it against");
      await checkStageRecord(carried, { sha: baseSha, show: io.show, workLock: resolvedBase, blackout: io.blackout?.(), platform: stagePlatform() }, { meta: io.npmMeta ?? npmMeta });
      keepStage(baseSha, JSON.parse(carried));
    } catch (error) {
      io.log(`not carrying over the earlier stage record of ${baseRef}: ${error.message}`);
    }
  }
  const done = async (result) => {
    if (!result.pin && pinned && build && !stages.has(baseSha)) {
      const record = await stageOfPinned(ctx, io, report);
      if (record) keepStage(baseSha, record);
    }
    return { ...result, report: report.join("\n"), resolved, stages };
  };

  const candidates = ref ? [{ ref, sha: io.revParse(ref) }] : releaseCandidates(io.tags(), channel, pinned?.ref).map((tag) => ({ ref: tag, sha: io.revParse(tag) }));
  if (!candidates.length) {
    report.push("Already on the newest release.");
    return done({ exitCode: 0, pin: null });
  }
  const held = [];
  for (const candidate of candidates) {
    io.log(`evaluating ${candidate.ref}`);
    let result;
    let next;
    try {
      result = await evaluateCandidate(candidate, ctx, io);
      if (!result.reasons.length) {
        const locks = { ...ctx.locks, ...result.locks };
        next = validatePin({
          ...pin,
          channels: { ...pin.channels, [channel]: { ref: candidate.ref, sha: candidate.sha, evaluatedAt: now().toISOString(), leftOut: result.leftOut } },
          deviceTools: [...new Set([...pin.deviceTools, ...result.cleared])].sort(),
          ...(Object.keys(locks).length ? { deviceToolLocks: Object.fromEntries(Object.entries(locks).sort(([a], [b]) => a.localeCompare(b))) } : {}),
        });
      }
    } catch (error) {
      // One candidate failing to evaluate holds it, not the evaluation.
      result = { ...result, reasons: [`couldn't be evaluated: ${lines(error.message)[0] ?? error}`] };
    }
    if (result.reasons.length) {
      held.push({ ref: candidate.ref, reasons: result.reasons });
      io.log(`holding ${candidate.ref}: ${result.reasons[0]}`);
      continue;
    }
    keepResolved(candidate.sha, result.resolvedLock);
    if (result.stageLocks?.length) keepStage(candidate.sha, stageRecord({ sha: candidate.sha, locks: result.stageLocks, blackout: io.blackout?.() }));
    report.push(`Pinned **${candidate.ref}** (\`${candidate.sha.slice(0, 10)}\`)${build ? ", built and smoke-tested" : ""}.`);
    if (result.cleared.length) report.push("", `Device tools cleared: ${result.cleared.join(", ")}.`);
    if (result.fastLaned.length) report.push("", "Security fixes taken ahead of the age gate:", ...result.fastLaned.map((line) => `- ${line}`));
    if (result.leftOut.length) report.push("", `Features left out (rules need updating): ${result.leftOut.join(", ")}.`);
    for (const h of held) report.push("", `Passed over ${h.ref}:`, ...h.reasons.map((reason) => `- ${reason}`));
    return done({ exitCode: 0, pin: next });
  }
  report.push("Every newer release was held; the pin stays put.");
  for (const h of held) report.push("", `## ${h.ref}`, ...h.reasons.map((reason) => `- ${reason}`));
  const alerting = (exposure.open ?? []).filter((a) => isAlerting(a.severity));
  if (alerting.length) report.push("", `The pinned release has ${alerting.length} high or critical advisories open; see the security issues.`);
  return done({ exitCode: 3, pin: null });
}
