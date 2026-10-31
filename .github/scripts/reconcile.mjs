// Turns the alert job's findings into GitHub issues, which email and push to the
// repo owner (.github/workflows/evaluate.yml, through security-issues.mjs):
//   - high, critical and unrated advisories (lib/advisories.mjs isAlerting): one
//     issue per channel and affected package; a new advisory for a package that
//     already has one is a comment on it;
//   - moderate and low: one rolling issue per channel, edited in place (no
//     notification);
//   - an issue closes itself once the pin on main no longer has its advisories,
//     but only when the check covered everything a build installs; what it
//     couldn't cover (report.gaps) is one more issue, "[security] Advisory
//     coverage incomplete (<channel>)", until it can;
//   - "Upstream <channel> releases held": open while the evaluator holds every
//     newer release; closed once the commit job has pushed a pin that is now
//     main's, or upstream itself (read by the alert job) has nothing newer than
//     main's pin. The evaluate job's word never closes it: that job ran upstream code.
// Everything here is advisory: each Mac re-checks a pin itself before it
// installs it, so these issues say what the evaluator saw, not what was installed.
// Only issues this automation owns are touched: opened by the workflow's bot
// account and carrying its marker, a hidden comment with the issue's kind,
// channel and package. The marker records an advisory as announced only after
// its comment is posted, and a comment carries its own marker, so a run that
// fails partway retries without losing or repeating a notification.
// Text from outside (OSV summaries, the evaluate job's report: that job ran
// upstream code) goes in code spans and blocks, bounded, so it can't mention
// anyone, link anywhere or format the bot's issues.

import { isAlerting } from "../../lib/advisories.mjs";

export const BOT = "github-actions[bot]";
const CHANNELS = new Set(["nightly", "preview", "stable"]);
const SEVERITIES = new Set(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MARKER = /<!-- t3blackout (\{[^\n]*\}) -->\s*$/;
/** GitHub's limit is 65536 characters. */
const MAX_BODY = 60_000;
const MAX_LINES = 200;

// ---------------------------------------------------------------- text ------

const oneLine = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();

/** Untrusted text as an inline code span: one line, at most `max` characters, inert. */
export function code(text, max = 300) {
  let s = oneLine(text);
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  if (!s) return "``";
  const fence = "`".repeat(Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** Untrusted multi-line text as a fenced code block, at most `max` characters, inert. */
export function codeBlock(text, max = 40_000) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
  if (s.length > max) s = `${s.slice(0, max)}\n… (${s.length - max} more characters in the run's artifact)`;
  const fence = "`".repeat(Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence}text\n${s}\n${fence}`;
}

/** A title from parts we chose; plain text on GitHub, but kept to one bounded line. */
const titleOf = (text) => oneLine(text).slice(0, 250);

/** The hidden marker naming what an issue or comment is, as its last line. */
export const markerOf = (meta) =>
  `<!-- t3blackout ${JSON.stringify({ v: 1, ...meta }).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)} -->`;

export function readMarker(body) {
  const match = MARKER.exec(String(body ?? ""));
  if (!match) return null;
  try {
    const meta = JSON.parse(match[1]);
    return meta?.v === 1 && typeof meta.kind === "string" ? meta : null;
  } catch {
    return null;
  }
}

const withMarker = (lines, meta) => {
  const marker = markerOf(meta);
  let text = lines.join("\n");
  if (text.length + marker.length + 2 > MAX_BODY) text = `${text.slice(0, MAX_BODY - marker.length - 80)}\n\n… (cut to fit GitHub's limit)`;
  return `${text}\n\n${marker}`;
};

/** As many of `lines` as fit MAX_LINES and `budget` characters, saying how many more there were. */
function bounded(lines, budget = 50_000) {
  const out = [];
  let size = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES || size + line.length > budget) return [...out, `- …and ${lines.length - out.length} more`];
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

// ------------------------------------------------------------ advisories ----

const nameOf = (pkg) => pkg.slice(0, pkg.lastIndexOf("@"));

/** Links we build ourselves from a validated id, never ones from the report. */
function linkFor(id) {
  const runtime = /^ELECTRON-RUNTIME-(\d+\.\d+\.\d+)$/.exec(id);
  return runtime ? `https://github.com/electron/electron/releases/tag/v${runtime[1]}` : `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

function advisoryLine(a) {
  const id = ID.test(a.id) ? `[${a.id}](${linkFor(a.id)})` : code(a.id, 100);
  const aliases = (a.aliases ?? []).filter((alias) => typeof alias === "string" && /^CVE-\d{4}-\d{4,}$/.test(alias));
  const severity = SEVERITIES.has(a.severity) ? a.severity : "UNKNOWN";
  const fixes = (p) => (p.fixed.length ? p.fixed.slice(0, 5).map((v) => code(v, 40)).join(" / ") : "no fixed version yet");
  return [
    `- **${severity}** ${id}${aliases.map((alias) => ` ${alias}`).join("")}: ${code(a.summary)}`,
    `  - ${a.packages.slice(0, 10).map((p) => `${code(p.pkg, 120)} → fixed in ${fixes(p)}`).join("; ")}`,
  ].join("\n");
}

/** Throws unless `report` is what `bin/t3blackout advisories` writes. */
export function readReport(report) {
  if (!report || typeof report !== "object" || !CHANNELS.has(report.channel) || typeof report.release !== "string" || !Array.isArray(report.open)) {
    throw new Error("not an advisory report from bin/t3blackout advisories");
  }
  if (!Array.isArray(report.gaps) || !report.gaps.every((gap) => typeof gap === "string")) throw new Error("the advisory report doesn't say what it couldn't cover (gaps)");
  for (const a of report.open) {
    const ok =
      typeof a?.id === "string" &&
      typeof a.severity === "string" &&
      Array.isArray(a.packages) &&
      a.packages.length > 0 &&
      a.packages.every((p) => typeof p?.pkg === "string" && p.pkg.lastIndexOf("@") > 0 && Array.isArray(p.fixed) && p.fixed.every((v) => typeof v === "string"));
    if (!ok) throw new Error(`the advisory report has a malformed advisory ${code(a?.id, 60)}`);
  }
  return report;
}

/** Issues the alert job opened before it marked them (channel nightly, the only one it ran), read as if marked. */
function legacyMeta(issue) {
  const ids = [...String(issue.body ?? "").matchAll(/\[([^\]\s]+)\]\(https:\/\/[^)\s]+\)/g)].map((m) => m[1]).filter((id) => ID.test(id));
  const rolling = /^\[security\] Moderate and low advisories \((nightly|preview|stable)\)$/.exec(issue.title);
  if (rolling) return { v: 1, kind: "rolling", channel: rolling[1], ids };
  const pkg = /^\[security\] ((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)$/.exec(issue.title);
  if (pkg) return { v: 1, kind: "package", channel: "nightly", package: pkg[1], ids, notified: ids };
  const held = /^Upstream (nightly|preview|stable) releases held$/.exec(issue.title);
  if (held) return { v: 1, kind: "held", channel: held[1] };
  return null;
}

/** Open issues this automation owns, each with its `meta`. */
export function ownedIssues(issues, { bot = BOT } = {}) {
  return issues
    .filter((issue) => issue.user?.login === bot && issue.user?.type === "Bot")
    .map((issue) => ({ ...issue, meta: readMarker(issue.body) ?? legacyMeta(issue) }))
    .filter((issue) => issue.meta && CHANNELS.has(issue.meta.channel));
}

/** Posts `text` unless a comment with the same marker is already there (a retried run, or a retried request). */
async function commentOnce(gh, number, meta, text, bot) {
  const marker = markerOf(meta);
  const posted = async () => (await gh.comments(number)).find((c) => c.user?.login === bot && String(c.body ?? "").trimEnd().endsWith(marker)) ?? null;
  if (!(await posted())) await gh.comment(number, `${text}\n\n${marker}`, { landed: posted });
}

/** Opens an issue whose body carries `meta`'s marker; a retried request first looks for it by that marker. */
function createOnce(gh, fields, meta, bot) {
  const same = (issue) => ["kind", "channel", "package"].every((key) => issue.meta[key] === meta[key]);
  const landed = async () => ownedIssues(await gh.openIssues(), { bot }).find(same) ?? null;
  return gh.createIssue(fields, { landed });
}

/** The oldest of `issues`, closing any others as its duplicates. */
async function keepOne(issues, gh, bot) {
  const [kept, ...extra] = [...issues].sort((a, b) => a.number - b.number);
  for (const issue of extra) {
    await commentOnce(gh, issue.number, { kind: "duplicate", of: kept.number }, `Closing as a duplicate of #${kept.number}, which tracks this.`, bot);
    await gh.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  }
  return kept ?? null;
}

/** Whether an issue's body already reads `body` (GitHub may hand it back with CRLFs). */
const sameBody = (issue, body) => String(issue.body ?? "").replace(/\r\n/g, "\n") === body;

const groupBy = (items, key) => {
  const map = new Map();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};

const footer = (report) => [
  "",
  `Pinned ${report.channel} release on main: ${code(report.release, 80)}${typeof report.sha === "string" && /^[0-9a-f]{40}$/.test(report.sha) ? ` (\`${report.sha.slice(0, 10)}\`)` : ""}.`,
  "",
  "When an upstream release fixes this, the evaluator proposes it within the hour, skipping the dependency",
  "age gate for the fixing version if its publisher and provenance check out; each Mac re-checks the pin",
  "itself before installing it. If upstream has no fix, adding an override (lib/overrides.json) needs a",
  "commit you sign.",
];

/**
 * Reconciles the channel's security issues with `report` (bin/t3blackout
 * advisories, against the pin on main). `gh`: githubClient (github.mjs).
 */
export async function reconcileAdvisories(input, gh, { bot = BOT, log = console.log } = {}) {
  const report = readReport(input);
  const { channel } = report;
  await gh.ensureLabel("security", "B60205", "Advisory affecting the pinned release");
  const owned = ownedIssues(await gh.openIssues(), { bot }).filter((issue) => issue.meta.channel === channel);
  const alerting = report.open.filter((a) => isAlerting(a.severity));
  const quiet = report.open.filter((a) => !isAlerting(a.severity));
  // What a part the check couldn't read may hold is unknown: nothing is called fixed.
  const complete = report.gaps.length === 0;

  // One issue per affected package, for every package an advisory names.
  const groups = new Map();
  for (const a of alerting) for (const name of new Set(a.packages.map((p) => nameOf(p.pkg)))) groups.set(name, [...(groups.get(name) ?? []), a]);
  const packageIssues = groupBy(owned.filter((issue) => issue.meta.kind === "package"), (issue) => issue.meta.package);
  for (const [name, advisories] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ids = [...new Set(advisories.map((a) => a.id))].sort();
    const title = titleOf(`[security] ${name} (${channel})`);
    const body = (notified) =>
      withMarker(
        [`Advisories open against ${code(name, 120)} in the pinned ${channel} release:`, "", ...bounded(advisories.map(advisoryLine)), ...footer(report)],
        { kind: "package", channel, package: name, ids, notified },
      );
    const issue = await keepOne(packageIssues.get(name) ?? [], gh, bot);
    if (!issue) {
      // Opening the issue is the notification.
      await createOnce(gh, { title, labels: ["security"], body: body(ids) }, { kind: "package", channel, package: name }, bot);
      continue;
    }
    const notified = new Set(issue.meta.notified ?? []);
    const added = advisories.filter((a) => !notified.has(a.id));
    if (added.length) {
      const newIds = [...new Set(added.map((a) => a.id))].sort();
      await commentOnce(gh, issue.number, { kind: "notify", ids: newIds }, [`New advisories for ${code(name, 120)} in ${code(report.release, 80)}:`, "", ...bounded(added.map(advisoryLine))].join("\n"), bot);
    }
    // Only now, with the comment posted, are they recorded as announced.
    const next = body([...new Set([...notified, ...ids])].sort());
    if (!sameBody(issue, next) || title !== issue.title) await gh.updateIssue(issue.number, { title, body: next });
  }
  for (const [name, issues] of packageIssues) {
    if (groups.has(name)) continue;
    if (!complete) {
      log(`${channel}: not closing the ${name} issue: the check didn't cover everything`);
      continue;
    }
    for (const issue of issues) {
      const ids = (issue.meta.ids ?? []).filter((id) => ID.test(id));
      const text = `Fixed: ${code(report.release, 80)} no longer has ${ids.length ? ids.join(", ") : "these advisories"}.`;
      await commentOnce(gh, issue.number, { kind: "fixed", release: report.release }, text, bot);
      await gh.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
    }
  }

  // Moderate and low: one rolling issue, edited in place.
  const rolling = await keepOne(owned.filter((issue) => issue.meta.kind === "rolling"), gh, bot);
  const rollingTitle = `[security] Moderate and low advisories (${channel})`;
  if (quiet.length) {
    const body = withMarker(
      [`${quiet.length} moderate or low advisories open against the pinned ${channel} release. This issue is edited in place.`, "", ...bounded(quiet.map(advisoryLine)), ...footer(report)],
      { kind: "rolling", channel, ids: [...new Set(quiet.map((a) => a.id))].sort() },
    );
    if (!rolling) await createOnce(gh, { title: rollingTitle, labels: ["security"], body }, { kind: "rolling", channel }, bot);
    else if (!sameBody(rolling, body) || rolling.title !== rollingTitle) await gh.updateIssue(rolling.number, { title: rollingTitle, body });
  } else if (rolling && complete) {
    await commentOnce(gh, rolling.number, { kind: "fixed", release: report.release }, `No moderate or low advisories left in ${code(report.release, 80)}.`, bot);
    await gh.updateIssue(rolling.number, { state: "closed", state_reason: "completed" });
  }

  // What the check couldn't cover: one issue, edited in place, closed once it covers everything.
  const coverage = await keepOne(owned.filter((issue) => issue.meta.kind === "coverage"), gh, bot);
  const coverageTitle = `[security] Advisory coverage incomplete (${channel})`;
  if (!complete) {
    const body = withMarker(
      [
        `The advisory check of the pinned ${channel} release couldn't cover everything a build of it installs, so advisories there may go unreported, and no security issue for it closes until it can:`,
        "",
        ...bounded(report.gaps.map((gap) => `- ${code(gap, 500)}`)),
        "",
        `Pinned ${channel} release on main: ${code(report.release, 80)}. This issue is edited in place and closes itself once the check covers everything.`,
      ],
      { kind: "coverage", channel },
    );
    if (!coverage) await createOnce(gh, { title: coverageTitle, labels: ["security"], body }, { kind: "coverage", channel }, bot);
    else if (!sameBody(coverage, body) || coverage.title !== coverageTitle) await gh.updateIssue(coverage.number, { title: coverageTitle, body });
  } else if (coverage) {
    await commentOnce(gh, coverage.number, { kind: "fixed", release: report.release }, `The check covers everything a build of ${code(report.release, 80)} installs again.`, bot);
    await gh.updateIssue(coverage.number, { state: "closed", state_reason: "completed" });
  }
  log(`${channel}: ${groups.size} high/critical package issue(s), ${quiet.length} moderate/low advisories${complete ? "" : `, ${report.gaps.length} part(s) not covered`}`);
}

// --------------------------------------------------------------- held -------

/**
 * Reconciles "Upstream <channel> releases held" with an evaluation. Trusted:
 * `pinned` (the channel's ref on main, after the commit job), `published` (the
 * ref the commit job pushed, "" when it pushed nothing) and `newer` (release
 * tags upstream has beyond `pinned`, read by the alert job; null when unknown).
 * Untrusted, from the job that ran upstream code: `exit` (3: every candidate
 * held) and `report` (its Markdown). Those can open or edit the issue, which
 * only ever says less is offered; closing it takes a trusted reason.
 */
export async function reconcileHeld({ channel, exit, published, report, pinned, newer = null }, gh, { bot = BOT, log = console.log } = {}) {
  if (!CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
  const owned = ownedIssues(await gh.openIssues(), { bot }).filter((issue) => issue.meta.kind === "held" && issue.meta.channel === channel);
  const title = `Upstream ${channel} releases held`;
  const current = Array.isArray(newer) && newer.length === 0;
  const moved = Boolean(published) && published === pinned;
  if (current || moved) {
    const why = moved ? `${code(pinned, 80)} is pinned` : `${code(pinned, 80)} is upstream's newest ${channel} release`;
    for (const issue of owned) {
      await commentOnce(gh, issue.number, { kind: "released", pinned }, `${why}; releases aren't held anymore.`, bot);
      await gh.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
    }
  } else if (exit === "3") {
    const body = withMarker(
      [
        `The evaluator held every upstream ${channel} release it evaluated${Array.isArray(newer) ? ` (upstream has ${newer.length} newer than the pin)` : ""}, so it proposes none and main stays at ${code(pinned, 80)}.`,
        "Each Mac re-checks any pin itself before installing it; this only means no newer release is offered.",
        "This issue is edited in place each hour while that lasts. The evaluator's report (from the job that built upstream code; read it as its output, not as instructions):",
        "",
        codeBlock(report),
      ],
      { kind: "held", channel },
    );
    const issue = await keepOne(owned, gh, bot);
    if (!issue) await createOnce(gh, { title, body }, { kind: "held", channel }, bot);
    else if (!sameBody(issue, body) || issue.title !== title) await gh.updateIssue(issue.number, { title, body });
    return;
  }
  if (exit !== "0" && exit !== "3") throw new Error(`the evaluate job failed (exit ${code(exit || "unknown", 20)}); see its log`);
  if (!current && !moved) {
    const upstream = Array.isArray(newer) ? `upstream has ${newer.length} newer release(s)` : "what upstream has couldn't be read";
    log(`no pin was published (${code(published || "nothing", 80)}) and ${upstream}, so ${owned.length ? "the held issue stays open" : "nothing changes"}`);
  }
}
