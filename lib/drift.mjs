// What upstream changed under the features a build left out (lib/features.mjs),
// as one self-contained HTML page with no scripts. It's written to state/drift/
// for `t3blackout drift`, and baked into the app, where the version stamp shows
// it in a frame.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { featureByName } from "./features.mjs";
import { gitMirror } from "./util.mjs";

const MAX_COMMITS = 30;
/** Lines kept either side of where a rule's anchor was. */
const ANCHOR_CONTEXT = 20;
/** Lines of a file's other changes, beyond the anchor's. */
const MAX_OTHER_LINES = 250;

const git = (args) => {
  const result = spawnSync("git", gitMirror(args), { encoding: "utf8", maxBuffer: 64 << 20 });
  return result.status === 0 ? result.stdout : null;
};

const existsAt = (sha, file) => spawnSync("git", gitMirror(["cat-file", "-e", `${sha}:${file}`])).status === 0;

/** Upstream files a type error points at: the file itself, and modules its message names. */
function filesInError(error) {
  const files = [error.file];
  const dir = path.posix.dirname(error.file);
  for (const [, specifier] of error.message.matchAll(/'"((?:\.{1,2}|~)\/[^"]+)"'/g)) {
    const base = specifier.startsWith("~/")
      ? path.posix.join(error.file.split("/src/")[0], "src", specifier.slice(2))
      : path.posix.join(dir, specifier);
    files.push(...["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base.replace(/\.(ts|tsx|js)$/, "") + ext));
  }
  return files;
}

/** Splits `git diff` output into hunks of { kind, text, old, new } lines. */
function parseHunks(diff) {
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (header) {
      hunk = { header: header[3].trim(), lines: [], hit: false };
      hunks.push(hunk);
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (!hunk || raw.startsWith("\\")) continue;
    const kind = raw[0] === "+" ? "add" : raw[0] === "-" ? "del" : raw[0] === " " ? "ctx" : null;
    if (!kind) continue;
    hunk.lines.push({ kind, text: raw.slice(1), anchor: false, old: kind === "add" ? null : oldLine, new: kind === "del" ? null : newLine });
    if (kind !== "add") oldLine++;
    if (kind !== "del") newLine++;
  }
  return hunks;
}

/**
 * Marks where the anchor was: the run of old lines that best matches a run of
 * the anchor's lines, counting rare lines and removed lines most, so a generic
 * line like `<SettingsRow` alone doesn't light up every row.
 */
function markAnchor(hunks, anchor) {
  const wanted = (anchor ?? "").split("\n").map((line) => line.trim());
  if (!wanted.some((line) => line.length > 3)) return;
  const old = hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "add").map((line) => ({ line, hunk })));
  const seen = new Map();
  for (const { line } of old) seen.set(line.text.trim(), (seen.get(line.text.trim()) ?? 0) + 1);
  const weight = ({ line }) => (line.kind === "del" ? 2 : 1) / seen.get(line.text.trim());
  let best = { score: 0, runs: [] };
  for (let i = 0; i < old.length; i++) {
    for (let j = 0; j < wanted.length; j++) {
      let score = 0;
      let length = 0;
      while (i + length < old.length && j + length < wanted.length && wanted[j + length].length > 3 && old[i + length].line.text.trim() === wanted[j + length]) {
        score += weight(old[i + length]);
        length++;
      }
      if (!length) continue;
      const run = old.slice(i, i + length);
      if (score > best.score + 1e-9) best = { score, runs: [run] };
      else if (Math.abs(score - best.score) < 1e-9 && best.runs.length < 3) best.runs.push(run);
    }
  }
  for (const run of best.runs) {
    for (const { line, hunk } of run) {
      line.anchor = true;
      hunk.hit = true;
    }
  }
}

/** Keeps `around` lines either side of the anchor, folding the rest into gaps. */
function cropAround(hunk, around) {
  const keep = hunk.lines.map(() => false);
  hunk.lines.forEach((line, i) => {
    if (!line.anchor) return;
    for (let k = Math.max(0, i - around); k <= Math.min(hunk.lines.length - 1, i + around); k++) keep[k] = true;
  });
  const lines = [];
  for (let i = 0; i < hunk.lines.length; ) {
    if (keep[i]) {
      lines.push(hunk.lines[i++]);
      continue;
    }
    let count = 0;
    while (i < hunk.lines.length && !keep[i]) {
      count++;
      i++;
    }
    lines.push({ kind: "gap", count });
  }
  hunk.lines = lines;
}

/** Upstream's commits and diff for one file between two commits. */
function fileChange(file, from, to, anchor) {
  const log = git(["log", "--no-merges", `--max-count=${MAX_COMMITS}`, "--format=%H%x09%s", `${from}..${to}`, "--", file]) ?? "";
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, 40), title: line.slice(41) }));
  const hunks = parseHunks(git(["diff", "--no-color", "-U3", from, to, "--", file]) ?? "");
  markAnchor(hunks, anchor);
  for (const hunk of hunks) if (hunk.hit) cropAround(hunk, ANCHOR_CONTEXT);
  // The rest of the file's changes, while there's room.
  let budget = MAX_OTHER_LINES;
  let dropped = 0;
  for (const hunk of hunks.filter((h) => !h.hit)) {
    if (hunk.lines.length <= budget) budget -= hunk.lines.length;
    else {
      dropped += hunk.lines.length;
      hunk.lines = [];
    }
  }
  return {
    path: file,
    from,
    exists: existsAt(to, file),
    commits,
    hunks: hunks.filter((h) => h.lines.length),
    droppedLines: dropped,
  };
}

/**
 * Where an anchor's code lives in upstream now, if anywhere: groups of nearby
 * lines in `sha` that match the anchor's lines, best (rarest matches) first, each
 * with a snippet around it. Finds code that moved to another file.
 */
function findAnchor(sha, anchor) {
  const wanted = [...new Set((anchor ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 8))].slice(0, 8);
  const hits = [];
  for (const text of wanted) {
    const out = git(["grep", "-n", "-F", "-e", text, sha, "--", "apps", "packages", "scripts"]) ?? "";
    const found = out
      .split("\n")
      .filter(Boolean)
      .map((line) => /^[^:]+:([^:]+):(\d+):/.exec(line))
      .filter(Boolean)
      .map(([, file, n]) => ({ file, line: Number(n), text }));
    if (found.length && found.length <= 20) hits.push(...found.map((hit) => ({ ...hit, weight: 1 / found.length })));
  }
  const groups = [];
  for (const hit of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const group = groups.at(-1);
    if (group && group.file === hit.file && hit.line - group.last <= 12) {
      group.last = hit.line;
      group.lines.add(hit.line);
      if (!group.texts.has(hit.text)) group.score += hit.weight;
      group.texts.add(hit.text);
    } else {
      groups.push({ file: hit.file, first: hit.line, last: hit.line, lines: new Set([hit.line]), texts: new Set([hit.text]), score: hit.weight });
    }
  }
  const best = groups.filter((group) => group.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 2);
  return best.map((group) => {
    const source = (git(["show", `${sha}:${group.file}`]) ?? "").split("\n");
    const from = Math.max(1, group.first - 6);
    const to = Math.min(source.length, group.last + 6);
    return {
      file: group.file,
      line: group.first,
      matched: group.texts.size,
      of: wanted.length,
      snippet: source.slice(from - 1, to).map((text, i) => ({ n: from + i, text, hit: group.lines.has(from + i) })),
    };
  });
}

/**
 * `skipped`: Map of feature name -> { reason: "anchor", failures } | { reason:
 * "compile", errors } | { reason: "requires", requires }. `strict`: strict
 * rule failures that stopped the build. `baselineFor(name)`: the upstream commit
 * a feature last built against.
 */
export function collectDrift({ skipped, strict = [], rulesById, target, baselineFor }) {
  const describeRule = (failure) => {
    const rule = rulesById.get(failure.id);
    return {
      id: failure.id,
      why: rule?.why ?? "",
      file: failure.file,
      message: failure.message,
      anchor: failure.anchor,
      now: failure.anchor ? findAnchor(target.sha, failure.anchor) : [],
    };
  };
  const changesFor = (from, entries) => {
    const seen = new Set();
    const files = [];
    for (const { file, anchor } of entries) {
      if (!file || seen.has(file) || !from || !(existsAt(from, file) || existsAt(target.sha, file))) continue;
      seen.add(file);
      files.push(fileChange(file, from, target.sha, anchor));
    }
    return files;
  };
  const features = [...skipped].map(([name, skip]) => {
    const feature = featureByName(name);
    const from = baselineFor(name);
    const rules = (skip.failures ?? []).map(describeRule);
    const errors = skip.errors ?? [];
    const files = changesFor(from, [
      ...rules.map((rule) => ({ file: rule.file, anchor: rule.anchor })),
      ...errors.flatMap((error) => filesInError(error).map((file) => ({ file, anchor: null }))),
    ]);
    return {
      name,
      label: feature?.label ?? name,
      description: feature?.description ?? null,
      reason: skip.reason,
      requires: skip.requires ? (featureByName(skip.requires)?.label ?? skip.requires) : null,
      from,
      rules,
      errors,
      files,
    };
  });
  const strictRules = strict.map(describeRule);
  const strictFrom = baselineFor(null);
  return {
    version: target.version,
    sha: target.sha,
    repo: target.repo ?? null,
    features,
    strict: strictRules.length ? { from: strictFrom, rules: strictRules, files: changesFor(strictFrom, strictRules) } : null,
  };
}

/** What the version stamp lists, without the diffs. */
export const driftSummary = (drift) =>
  (drift?.features ?? []).map(({ name, label, description, reason, requires }) => ({ name, label, description, reason, requires }));

// ---------------------------------------------------------------- render --

const escape = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const short = (sha) => (sha ? sha.slice(0, 7) : "?");

function commitTitle(commit, repo) {
  const pr = /^(.*?)\s*\(#(\d+)\)$/.exec(commit.title);
  const sha = repo ? `<a href="${repo}/commit/${commit.sha}"><code>${short(commit.sha)}</code></a>` : `<code>${short(commit.sha)}</code>`;
  if (!pr || !repo) return `${sha} ${escape(commit.title)}`;
  return `${sha} ${escape(pr[1])} <a href="${repo}/pull/${pr[2]}">#${pr[2]}</a>`;
}

function renderHunk(hunk) {
  const rows = hunk.lines
    .map((line) => {
      if (line.kind === "gap") return `<tr class="gap"><td colspan="4">⋯ ${line.count} line${line.count === 1 ? "" : "s"}</td></tr>`;
      const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      return `<tr class="${line.kind}${line.anchor ? " anchor" : ""}"><td class="n">${line.old ?? ""}</td><td class="n">${line.new ?? ""}</td><td class="s">${sign}</td><td class="t">${escape(line.text) || " "}</td></tr>`;
    })
    .join("");
  const header = hunk.header ? `<caption>${escape(hunk.header)}</caption>` : "";
  return `<div class="diffwrap"><table class="diff">${header}${rows}</table></div>`;
}

function renderFile(file, repo, to) {
  const hit = file.hunks.filter((h) => h.hit);
  const rest = file.hunks.filter((h) => !h.hit);
  const compare = repo ? ` <a class="aside" href="${repo}/compare/${file.from}...${to}">compare on GitHub</a>` : "";
  const commits = file.commits.length
    ? `<ul class="commits">${file.commits.map((c) => `<li>${commitTitle(c, repo)}</li>`).join("")}</ul>`
    : `<p class="muted">Upstream didn't change this file since ${short(file.from)}, so another rule's edit probably moved the anchor.</p>`;
  const gone = file.exists ? "" : `<p class="warn">This file no longer exists upstream; one of the commits above moved or deleted it.</p>`;
  const body = [
    hit.length ? `<p class="lede">Where the rule hooked in (highlighted):</p>${hit.map(renderHunk).join("")}` : "",
    rest.length
      ? hit.length
        ? `<details><summary>${rest.length} other change${rest.length === 1 ? "" : "s"} in this file</summary>${rest.map(renderHunk).join("")}</details>`
        : rest.map(renderHunk).join("")
      : "",
    file.droppedLines ? `<p class="muted">${file.droppedLines} more changed lines not shown.${compare}</p>` : "",
  ].join("");
  return `<div class="file"><h3><code>${escape(file.path)}</code>${compare}</h3>${gone}${commits}${body}</div>`;
}

function renderNow(rule) {
  if (!rule.anchor) return "";
  if (!rule.now?.length) return `<p class="lede">Upstream no longer has anything that looks like it.</p>`;
  return rule.now
    .map((place, i) => {
      const moved = place.file === rule.file ? "" : ` <span class="tag">moved</span>`;
      const rows = place.snippet
        .map((line) => `<tr class="${line.hit ? "anchor" : "ctx"}"><td class="n">${line.n}</td><td class="t">${escape(line.text) || " "}</td></tr>`)
        .join("");
      return `<p class="lede">${i ? "Also like it" : "Closest match in upstream now"}: <code>${escape(place.file)}:${place.line}</code>${moved} <span class="muted">(${place.matched} of ${place.of} lines)</span></p><div class="diffwrap"><table class="diff">${rows}</table></div>`;
    })
    .join("");
}

function renderRules(rules) {
  return rules
    .map(
      (rule) => `<div class="rule"><p><code>${escape(rule.id)}</code> ${escape(rule.why)}</p>${
        rule.anchor
          ? `<p class="lede">It looks for this in <code>${escape(rule.file)}</code>:</p><pre class="anchor">${escape(rule.anchor)}</pre>${renderNow(rule)}`
          : `<p class="muted">${escape(rule.message)}</p>`
      }</div>`,
    )
    .join("");
}

/** A screen counts as changed above this share of differing pixels (antialiasing noise sits below). */
const CHANGED = 0.002;
const screenChanged = (screen) => screen.changed === null || screen.changed >= CHANGED;

function renderScreen(screen, skipped, versions) {
  const leftOut = screen.features.filter((name) => skipped.has(name)).map((name) => skipped.get(name));
  const tags = [
    screen.changed === null ? "" : `<span class="tag">${(screen.changed * 100).toFixed(1)}% changed</span>`,
    ...leftOut.map((label) => `<span class="tag warn">${escape(label)} left out</span>`),
  ].join("");
  const figure = (image, caption) =>
    `<figure><figcaption>${escape(caption)}</figcaption>${image ? zoomable(image, caption) : `<p class="muted">${escape(screen.note ?? "Not captured.")}</p>`}</figure>`;
  return `<div class="screen" id="screen-${escape(screen.name)}"><h3>${escape(screen.label)} ${tags}</h3>
<div class="pair">${figure(screen.before, `Before · ${versions.before ?? "installed"}`)}${figure(screen.after, `After · ${versions.after}`)}</div>
${screen.diff ? `<details><summary>Highlight what changed</summary>${zoomable(screen.diff, "Changed pixels")}</details>` : ""}</div>`;
}

/** An image that opens full size on click, and closes on the next: CSS only, the report has no scripts. */
const zoomable = (src, alt) => `<details class="zoom"><summary><img alt="${escape(alt)}" src="${src}"></summary></details>`;

function renderScreens(looks, drift) {
  if (!looks) return "";
  const intro = `<p class="muted">Your installed build on the left, this one on the right. Both run with an empty profile, no network and the Blackout theme, in browser mode, so desktop-only controls (like Window opacity) don't show.</p>`;
  if (!looks.screens.length) return `<section id="screens"><h2>Screens</h2><p class="muted">${escape(looks.note ?? "No screenshots.")}</p></section>`;
  const skipped = new Map(drift.features.map((feature) => [feature.name, feature.label]));
  const versions = { before: looks.beforeVersion, after: drift.version };
  const changed = looks.screens.filter(screenChanged);
  const same = looks.screens.filter((screen) => !screenChanged(screen));
  return `<section id="screens"><h2>Screens</h2>${intro}
${changed.map((screen) => renderScreen(screen, skipped, versions)).join("\n")}
${same.length ? `<details class="same"><summary>${same.length} screen${same.length === 1 ? " looks" : "s look"} the same: ${same.map((s) => escape(s.label)).join(", ")}</summary>${same.map((screen) => renderScreen(screen, skipped, versions)).join("\n")}</details>` : ""}
</section>`;
}

function renderFeature(feature, drift, looks) {
  const why = {
    anchor: "Upstream changed the code it hooks into.",
    compile: "It no longer compiles against upstream's code.",
    requires: `It needs ${escape(feature.requires)}, which was left out.`,
  }[feature.reason];
  const errors = feature.errors.length
    ? `<pre class="errors">${feature.errors.map((e) => escape(`${e.file}(${e.line}): ${e.message}`)).join("\n")}</pre>`
    : "";
  return `<section id="${escape(feature.name)}">
<h2>${escape(feature.label)}</h2>
${feature.description ? `<p class="desc">${escape(feature.description)}</p>` : ""}
<p class="why">${why}${feature.from ? ` <span class="muted">Changes since upstream ${short(feature.from)}, the last build that had it.</span>` : ""}</p>
${seenOn(feature, looks)}${renderRules(feature.rules)}${errors}${feature.files.map((file) => renderFile(file, drift.repo, drift.sha)).join("")}
</section>`;
}

/** Links a feature to the screens it shows on. */
function seenOn(feature, looks) {
  const screens = (looks?.screens ?? []).filter((screen) => screen.features.includes(feature.name) && screen.after);
  if (!screens.length) return "";
  return `<p class="lede">See it: ${screens.map((screen) => `<a href="#screen-${escape(screen.name)}">${escape(screen.label)}</a>`).join(", ")}</p>`;
}

const STYLE = `
:root{color-scheme:dark;--bg:#0b0b0c;--panel:#141416;--line:#26262a;--text:#e7e7ea;--muted:#8d8d96;--accent:#ff7a1a;--add:#0f2a1a;--addt:#7ee2a8;--del:#2e1215;--delt:#ff9aa2;--hit:#4a2a00}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:17px;margin:0 0 4px}h3{font-size:13px;margin:18px 0 8px;font-weight:600}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,.diff{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.muted{color:var(--muted)}.warn{color:var(--delt)}.lede{margin:10px 0 6px;color:var(--muted)}.aside{font-weight:400;margin-left:8px;font-size:12px}
header p{color:var(--muted);margin:4px 0}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 4px}nav a{border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--text)}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:18px}
section.strict{border-color:#6b1d24}
.desc{margin:0;color:var(--muted)}.why{margin:8px 0 0}
.rule{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}.rule p{margin:0}
pre{background:#0e0e10;border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;margin:0;white-space:pre}
pre.anchor{border-color:#5a3410}pre.errors{color:var(--delt);margin-top:12px}
.file{border-top:1px solid var(--line);margin-top:14px}
ul.commits{margin:0;padding-left:18px}ul.commits li{margin:2px 0}
div.diffwrap{border:1px solid var(--line);border-radius:8px;overflow-x:auto;margin:8px 0}
table.diff{width:100%;border-collapse:collapse}
table.diff caption{text-align:left;color:var(--muted);padding:4px 10px;background:#101012;caption-side:top}
td.t{width:100%}.tag{font-size:11px;border:1px solid #5a3410;color:var(--accent);border-radius:999px;padding:0 7px;margin-left:4px}
table.diff td{padding:0 8px;white-space:pre;vertical-align:top}
td.n{color:#5b5b63;text-align:right;user-select:none;min-width:40px}td.s{user-select:none;width:14px;color:var(--muted)}
tr.add{background:var(--add)}tr.add td.t,tr.add td.s{color:var(--addt)}
tr.del{background:var(--del)}tr.del td.t,tr.del td.s{color:var(--delt)}
tr.anchor td{background:var(--hit)!important;color:#ffd2a8!important}tr.anchor td.s{box-shadow:inset 3px 0 var(--accent)}
tr.gap td{color:var(--muted);background:#101012;padding:2px 10px;font-style:italic}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted)}
.screen{border-top:1px solid var(--line);padding-top:6px;margin-top:14px}.screen:first-of-type{border-top:0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}figcaption{color:var(--muted);font-size:12px;margin:0 0 4px}
.screen img{display:block;width:100%;border:1px solid var(--line);border-radius:8px}
details.zoom{margin:0}details.zoom>summary{list-style:none;cursor:zoom-in}details.zoom>summary::-webkit-details-marker{display:none}
details.zoom[open]>summary{cursor:zoom-out}
details.zoom[open]>summary::before{content:"";position:fixed;inset:0;background:rgb(0 0 0/88%);z-index:9}
details.zoom[open]>summary img{position:fixed;inset:0;margin:auto;width:auto;height:auto;max-width:96%;max-height:96%;z-index:10;border-color:#3a3a40}
.tag.warn{border-color:#6b1d24;color:var(--delt)}details.same{margin-top:16px}
footer{margin-top:28px;color:var(--muted)}footer h2{color:var(--text)}footer li{margin:4px 0}
`;

/** The report for a build that left nothing out: just its screens. */
export const emptyDrift = ({ version, sha, repo = null }) => ({ version, sha, repo, features: [], strict: null });

/**
 * The report: screens before and after (`looks`, from lib/looks.mjs, when the
 * build got that far), then each feature left out, then what stopped the update.
 */
export function renderDriftReport(drift, looks = null) {
  const features = drift.features;
  const strict = drift.strict;
  const title = strict
    ? `Upstream ${drift.version} wasn't installed`
    : features.length
      ? `${features.length} feature${features.length === 1 ? "" : "s"} left out of ${drift.version}`
      : `What changed in ${drift.version}`;
  const intro = strict
    ? "A strict rule (privacy, identity or the updater) no longer matches upstream, so nothing was installed. What upstream changed is below."
    : features.length
      ? "This build runs upstream's code where these Blackout features used to hook in. Every privacy, identity and updater rule applied as usual."
      : "Every Blackout feature made it into this build.";
  const strictSection = strict
    ? `<section class="strict"><h2>Stopped the update</h2><p class="why">${strict.rules.length} strict rule${strict.rules.length === 1 ? "" : "s"} no longer match${strict.rules.length === 1 ? "es" : ""}.</p>${renderRules(strict.rules)}${strict.files.map((file) => renderFile(file, drift.repo, drift.sha)).join("")}</section>`
    : "";
  const links = [...(looks?.screens.length ? [["screens", "Screens"]] : []), ...features.map((f) => [f.name, f.label])];
  const nav = links.length > 1 ? `<nav>${links.map(([id, label]) => `<a href="#${escape(id)}">${escape(label)}</a>`).join("")}</nav>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head>
<body><main>
<header><h1>${escape(title)}</h1><p>${intro}</p><p class="muted">Upstream ${escape(drift.version)} (${short(drift.sha)})</p>${nav}</header>
${renderScreens(looks, drift)}${strictSection}${features.map((feature) => renderFeature(feature, drift, looks)).join("\n")}
${features.length || strict ? `<footer><h2>What you can do</h2><ul>
<li><b>Keep upstream's version.</b> Nothing to do: this build already runs it. To stop listing a feature here, remove its rules from <code>lib/rules.mjs</code> and its entry from <code>lib/features.mjs</code>.</li>
<li><b>Bring Blackout's back.</b> Point the rule at upstream's new code (the highlighted lines show where it hooked in), check with <code>t3blackout check</code>, and update.</li>
</ul></footer>` : ""}
</main></body></html>
`;
}
