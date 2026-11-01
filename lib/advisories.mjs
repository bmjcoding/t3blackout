// Known vulnerabilities in what the machines run: every package in the pinned
// release's lockfile (Electron, and with it Chromium, included) and the device
// tools in pin.json, from three sources merged by id and alias:
//   - OSV.dev, for every package; it carries the GitHub Advisory Database's
//     reviewed advisories among others;
//   - the GitHub Advisory Database itself (api.github.com/advisories), for every
//     package: reviewed and unreviewed advisories, which can reach it before
//     OSV has them, and its malware ones;
//   - the security advisories a watched package's own GitHub repository
//     publishes (the device tools, which the app installs outside the lockfile):
//     a maintainer can publish one there that reaches neither database for
//     weeks. agent-device's GHSA-6845-fcpx-jc45 and GHSA-xr68-vpwv-cgg9 (Oct 30
//     2026) were in neither a day later, nor was any earlier agent-device advisory.
// The evaluator uses the results twice: alerts (open advisories, and ones a new
// pin fixed) and a fast lane, which waives the minimum dependency age for an
// attested version that fixes an open advisory. Nobody curates a repository's
// own advisories, and its maintainer can edit one, so one only a repository
// published opens the fast lane for nothing but the exact version an override
// the owner signed names as its fix (lib/fastlane.mjs makeFastLane `vouched`).
//
// A scan is all or nothing: every page a source continues is followed, and a
// source that can't be read, or an answer that doesn't cover every query,
// throws, so issues are never reconciled against a partial list and closed by
// mistake, and nothing is fast-laned on one. A watched package whose repository
// GitHub can't speak for (not on GitHub, or gone) is a gap: the alert job
// reports it and closes nothing (scanAdvisories), and the fast lane refuses
// to decide on it at all (findAdvisories).
//
// GitHub's API is read with a token when this process was given one
// (lib/github-token.mjs: the workflows pass the job's own; it goes to
// api.github.com and nowhere else, and no process this one starts inherits
// it). Without one it allows 60 requests an hour per address: a scan of a
// whole release is about 18 (its URL limit of about 8 KB fits some 150
// packages a request, asked once for advisories and once for malware), and a
// fast lane's check of one version 2 or 3.

import { cvssScore, scoreSeverity } from "./cvss.mjs";
import { npmMeta, repoOf } from "./gates.mjs";
import { githubToken, githubTokenProblem } from "./github-token.mjs";
import { request } from "./http.mjs";
import { compareVersions, inRange, parseVersion } from "./semver.mjs";

const OSV = "https://api.osv.dev/v1";
const GITHUB = "https://api.github.com";
const SEVERITY_ORDER = ["LOW", "MODERATE", "HIGH", "CRITICAL"];
/** OSV caps a querybatch at 1000 queries. */
const BATCH = 1000;
/** Continuation rounds (OSV) or pages (GitHub) before a scan is called runaway. */
const MAX_PAGES = 50;
/** GitHub answers 414 to a URL over about 8 KB; a batch's URL stays under this. */
const GITHUB_URL_MAX = 7000;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/**
 * Highest severity an OSV record states, as LOW/MODERATE/HIGH/CRITICAL: the
 * database's own rating (GitHub's) or a CVSS v3/v2 vector, at the top level or per
 * affected package. A malicious-package report (MAL-) is CRITICAL. Anything else
 * is UNKNOWN, which alerts (isAlerting) rather than sitting in the quiet list.
 */
export function severityOf(vuln) {
  const stated = [vuln.database_specific?.severity, ...(vuln.affected ?? []).map((a) => a.database_specific?.severity)]
    .filter(Boolean)
    .map((s) => String(s).toUpperCase())
    .map((s) => (s === "MEDIUM" ? "MODERATE" : s))
    .filter((s) => SEVERITY_ORDER.includes(s));
  for (const entry of [...(vuln.severity ?? []), ...(vuln.affected ?? []).flatMap((a) => a.severity ?? [])]) {
    const score = cvssScore(entry);
    if (score !== null) stated.push(scoreSeverity(score, entry.type));
  }
  if (!stated.length) return /^MAL-/.test(vuln.id ?? "") ? "CRITICAL" : "UNKNOWN";
  return highest(stated);
}

/**
 * Severities from the least to the most alarming. UNKNOWN sits above LOW and
 * MODERATE: an unrated advisory alerts (isAlerting), so no rating merged with
 * it may make it quieter. Anything that isn't one of these is UNKNOWN.
 */
export const RANKED = ["LOW", "MODERATE", "UNKNOWN", "HIGH", "CRITICAL"];
export const rankOf = (severity) => RANKED.indexOf(RANKED.includes(severity) ? severity : "UNKNOWN");

/** The most alarming of `severities` by RANKED; UNKNOWN when there are none. */
const highest = (severities) => [...severities].sort((a, b) => rankOf(b) - rankOf(a)).map((s) => (RANKED.includes(s) ? s : "UNKNOWN"))[0] ?? "UNKNOWN";

/** High, critical, or unrated: what notifies (a package named by one gets an issue, ci/reconcile.mjs). */
export const isAlerting = (severity) => severity === "HIGH" || severity === "CRITICAL" || severity === "UNKNOWN";

/**
 * `versions` deduplicated, lowest first (anything that isn't SemVer last).
 * Versions of equal precedence (1.0.1 and 1.0.1+build) go in code-point order,
 * so the result never depends on the order the sources answered in.
 */
const sortVersions = (versions) => {
  const valid = (v) => parseVersion(v) !== null;
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...new Set(versions)].sort((a, b) => (valid(a) && valid(b) ? compareVersions(a, b) : valid(a) ? -1 : valid(b) ? 1 : a.localeCompare(b)) || byText(a, b));
};

/** Versions an OSV record says fix `name` (npm), lowest first (anything that isn't SemVer last). */
export function fixedVersions(vuln, name) {
  const fixed = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.ecosystem !== "npm" || affected.package?.name !== name) continue;
    for (const range of affected.ranges ?? []) for (const event of range.events ?? []) if (event.fixed) fixed.push(String(event.fixed));
  }
  return sortVersions(fixed);
}

const split = (pkg) => {
  const at = pkg.lastIndexOf("@");
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
};

// ------------------------------------------------------------------ OSV --

/** Advisory ids per package (name@version) for `list`, every page of every query. */
async function queryIds(list) {
  const ids = new Map(list.map((pkg) => [pkg, new Set()]));
  let pending = list.map((pkg) => ({ pkg, token: null }));
  for (let round = 0; pending.length; round++) {
    if (round >= MAX_PAGES) throw new Error(`OSV kept continuing after ${MAX_PAGES} pages`);
    const next = [];
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const answer = await request(`${OSV}/querybatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queries: batch.map(({ pkg, token }) => ({ package: { ecosystem: "npm", name: split(pkg).name }, version: split(pkg).version, ...(token ? { page_token: token } : {}) })),
        }),
        label: "OSV querybatch",
      });
      const results = answer?.results;
      if (!Array.isArray(results) || results.length !== batch.length) {
        throw new Error(`OSV answered ${Array.isArray(results) ? results.length : "no"} results for ${batch.length} queries`);
      }
      results.forEach((result, j) => {
        if (!result || typeof result !== "object" || (result.vulns !== undefined && !Array.isArray(result.vulns))) throw new Error(`OSV sent an unreadable result for ${batch[j].pkg}`);
        for (const vuln of result.vulns ?? []) {
          if (typeof vuln?.id !== "string" || !vuln.id) throw new Error(`OSV sent an advisory without an id for ${batch[j].pkg}`);
          ids.get(batch[j].pkg).add(vuln.id);
        }
        if (result.next_page_token) next.push({ pkg: batch[j].pkg, token: String(result.next_page_token) });
      });
    }
    pending = next;
  }
  return ids;
}

/** OSV's advisories for `list`, each { id, aliases, summary, severity, packages, sources: ["osv"] }. */
async function osvAdvisories(list) {
  const hits = new Map();
  for (const [pkg, ids] of await queryIds(list)) for (const id of ids) hits.set(id, [...(hits.get(id) ?? []), pkg]);
  const advisories = [];
  for (const [id, pkgs] of [...hits].sort(([a], [b]) => a.localeCompare(b))) {
    const vuln = await request(`${OSV}/vulns/${encodeURIComponent(id)}`, { label: `OSV ${id}` });
    if (!vuln || typeof vuln !== "object" || (vuln.id !== id && !vuln.aliases?.includes(id))) throw new Error(`OSV sent an unreadable record for ${id}`);
    if (vuln.withdrawn) continue;
    advisories.push({
      id,
      aliases: vuln.aliases ?? [],
      summary: vuln.summary ?? vuln.details?.split("\n")[0]?.slice(0, 200) ?? "",
      severity: severityOf(vuln),
      packages: pkgs.map((pkg) => ({ pkg, fixed: fixedVersions(vuln, split(pkg).name) })),
      sources: ["osv"],
    });
  }
  return advisories;
}

// --------------------------------------------------------------- GitHub --

/** api.github.com's headers, with the token when there is one (lib/github-token.mjs). */
function githubHeaders() {
  const bearer = githubToken();
  return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
}

/** `error` (lib/http.mjs) as the rate limit it is, saying when it lifts, or itself. */
function rateLimited(error, label) {
  const headers = error?.headers;
  if (![403, 429].includes(error?.status) || headers?.get?.("x-ratelimit-remaining") !== "0") return error;
  const reset = Number(headers.get("x-ratelimit-reset"));
  const until = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : "";
  const unusable = githubTokenProblem();
  const how = githubToken() ? "for this token" : `for this address without a token (60 requests an hour; ${unusable ? `the one given isn't used: ${unusable}` : "give one, lib/github-token.mjs"})`;
  return new Error(`${label}: GitHub's API rate limit is used up ${how}${until}`);
}

/**
 * A GET on GitHub's API: { body, headers }, or null for a 404 when `notFound`
 * is "null". A redirect (a renamed repository) is followed only within
 * api.github.com, so the token never leaves it.
 */
async function githubGet(url, label, { notFound = "throw" } = {}) {
  for (let hop = 0; hop <= 3; hop++) {
    if (new URL(url).origin !== GITHUB) throw new Error(`${label}: GitHub sent ${new URL(url).origin}, which isn't its API`);
    let answer;
    try {
      answer = await request(url, { headers: githubHeaders(), withHeaders: true, redirect: "manual", notFound, label });
    } catch (error) {
      throw rateLimited(error, label);
    }
    if (answer === null || answer.status < 300) return answer;
    url = new URL(answer.headers.get("location") ?? "", url).href;
  }
  throw new Error(`${label}: GitHub redirected more than 3 times`);
}

/** Every item of a paginated GitHub API list (Link rel="next"); null for a 404 when `notFound` is "null". */
async function githubList(url, label, opts = {}) {
  const items = [];
  for (let page = 0, next = url; next; page++) {
    if (page >= MAX_PAGES) throw new Error(`${label}: GitHub kept continuing after ${MAX_PAGES} pages`);
    const answer = await githubGet(next, label, opts);
    if (answer === null) return null;
    if (!Array.isArray(answer.body)) throw new Error(`${label}: GitHub sent something other than a list`);
    items.push(...answer.body);
    next = /<([^>]+)>;\s*rel="next"/.exec(answer.headers.get("link") ?? "")?.[1] ?? null;
  }
  return items;
}

/** GitHub's range syntax (">= 0.8.0, <= 0.20.3") as npm's, or null for no range (every version). */
const githubRange = (range) => (typeof range === "string" && range.trim() ? range.replace(/,/g, " ") : null);

/** SemVer versions named in a GitHub fix field ("0.21.35", ">= 0.20.4", { identifier }). */
function patchedOf(vulnerability) {
  const fields = [vulnerability.first_patched_version?.identifier ?? vulnerability.first_patched_version, vulnerability.patched_versions];
  const versions = fields.filter((f) => typeof f === "string").flatMap((f) => f.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g) ?? []);
  return versions.filter((v) => parseVersion(v) !== null);
}

/**
 * Which of `pkgs` (name@version) a GitHub advisory's `vulnerabilities` cover,
 * as Map pkg -> fixed versions: same npm package, version in the affected range
 * (prereleases included). A range this can't read counts as covering the
 * version: never a reason to call one safe.
 */
function githubAffected(vulnerabilities, pkgs) {
  const out = new Map();
  for (const v of Array.isArray(vulnerabilities) ? vulnerabilities : []) {
    if (v?.package?.ecosystem !== "npm" || typeof v.package.name !== "string") continue;
    for (const pkg of pkgs) {
      const { name, version } = split(pkg);
      if (name !== v.package.name) continue;
      const range = githubRange(v.vulnerable_version_range);
      let hit = true;
      try {
        if (range !== null) hit = inRange(version, range);
      } catch {}
      if (hit) out.set(pkg, sortVersions([...(out.get(pkg) ?? []), ...patchedOf(v)]));
    }
  }
  return out;
}

/** A GitHub advisory's severity: malware is CRITICAL; otherwise its rating, else its CVSS v3 vector, else UNKNOWN. */
function githubSeverity(advisory) {
  if (advisory.type === "malware") return "CRITICAL";
  const stated = String(advisory.severity ?? "").toUpperCase().replace(/^MEDIUM$/, "MODERATE");
  if (SEVERITY_ORDER.includes(stated)) return stated;
  for (const vector of [advisory.cvss_severities?.cvss_v3?.vector_string, advisory.cvss?.vector_string]) {
    const score = cvssScore({ type: "CVSS_V3", score: vector });
    if (score !== null) return scoreSeverity(score, "CVSS_V3");
  }
  return "UNKNOWN";
}

/** One GitHub advisory as an advisory record for the `affected` packages (githubAffected), or null when it's withdrawn or has none. */
function githubRecord(advisory, affected, source, label, extra = {}) {
  if (typeof advisory?.ghsa_id !== "string" || !GHSA.test(advisory.ghsa_id)) throw new Error(`${label} sent an advisory without a GHSA id`);
  if (advisory.withdrawn_at || !affected.size) return null;
  const aliases = [advisory.cve_id, ...(Array.isArray(advisory.identifiers) ? advisory.identifiers.map((i) => i?.value) : [])];
  return {
    id: advisory.ghsa_id,
    aliases: [...new Set(aliases.filter((a) => typeof a === "string" && a && a !== advisory.ghsa_id))],
    summary: String(advisory.summary ?? "").slice(0, 200),
    severity: githubSeverity(advisory),
    packages: [...affected].map(([pkg, fixed]) => ({ pkg, fixed })),
    sources: [source],
    ...extra,
  };
}

/** `list` in batches whose `affects=` part fits GitHub's URL limit. */
function affectsBatches(list, room = GITHUB_URL_MAX - 120) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const pkg of list) {
    const entry = encodeURIComponent(pkg);
    if (entry.length + 1 > room) throw new Error(`${pkg} is too long a package to ask GitHub's Advisory Database about`);
    if (batch.length && size + entry.length + 1 > room) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(pkg);
    size += entry.length + 1;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * The GitHub Advisory Database's advisories for `list` (`affects=`, batched):
 * the reviewed and unreviewed ones it lists by default, then the malware ones it
 * lists only when asked. Returns { advisories, requests }.
 */
async function githubDatabase(list) {
  const advisories = [];
  let requests = 0;
  for (const batch of affectsBatches(list)) {
    const affects = batch.map(encodeURIComponent).join(",");
    for (const type of ["", "&type=malware"]) {
      const label = `GitHub Advisory Database${type ? " (malware)" : ""}`;
      requests++;
      const items = await githubList(`${GITHUB}/advisories?ecosystem=npm&per_page=100${type}&affects=${affects}`, label);
      for (const advisory of items) {
        const record = githubRecord(advisory, githubAffected(advisory?.vulnerabilities, batch), "github", label);
        if (record) advisories.push(record);
      }
    }
  }
  return { advisories, requests };
}

/**
 * The published security advisories of each watched package's GitHub
 * repository (its npm metadata's `repository`, for the version in `list`), for
 * the packages in `list` whose name is in `watch`: { advisories, repositories,
 * gaps }. A package whose repository isn't on GitHub, or is gone, is a gap; a
 * repository that can't be read throws.
 */
async function repositoryAdvisories(list, watch, { meta = npmMeta } = {}) {
  const byRepo = new Map();
  const gaps = [];
  for (const pkg of list.filter((p) => watch.has(split(p).name))) {
    const { name, version } = split(pkg);
    const info = (await meta(name))?.versions?.[version];
    const repo = info ? repoOf(info.repository) : null;
    const github = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(repo ?? "");
    if (!github) {
      gaps.push(`${pkg}'s own security advisories: ${info ? `its repository (${repo ?? "none"}) isn't one on GitHub` : "npm doesn't have it"}`);
      continue;
    }
    const key = `${github[1]}/${github[2]}`;
    byRepo.set(key, [...(byRepo.get(key) ?? []), pkg]);
  }
  const advisories = [];
  for (const [repo, pkgs] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
    const label = `GitHub security advisories of ${repo}`;
    const items = await githubList(`${GITHUB}/repos/${repo}/security-advisories?state=published&per_page=100`, label, { notFound: "null" });
    if (items === null) {
      gaps.push(`${pkgs.join(", ")}'s own security advisories: GitHub has no repository ${repo}`);
      continue;
    }
    for (const advisory of items) {
      if (advisory?.state !== "published") continue;
      const record = githubRecord(advisory, githubAffected(advisory?.vulnerabilities, pkgs), "github-repository", label, { repository: repo });
      if (record) advisories.push(record);
    }
  }
  return { advisories, repositories: [...byRepo.keys()].sort(), gaps };
}

// ---------------------------------------------------------------- merge --

/**
 * `records` from every source as one advisory per vulnerability: records that
 * share an id or alias are one. Its id is OSV's when OSV has it (the id issues
 * were filed under), else the GHSA id; its severity the highest any states; each
 * package's fixed versions every record's for it; `sources` which said so.
 *
 * What each source claimed stays its own: a package's `curatedFixed` lists only
 * the fixed versions a curated source (OSV, GitHub's database) itself states for
 * that package. A repository's advisory names its aliases itself (its CVE id is
 * editable), so sharing one with a curated advisory for another package must
 * not make its claims curated: the fast lane trusts curatedFixed alone
 * (lib/fastlane.mjs), alerts read every claim.
 *
 * Each package keeps its own `severity`, the most alarming any record that
 * names it states (RANKED: an unrated claim alerts, so a LOW record merged in
 * can't quiet it), and the advisory's is the most alarming of those; and its
 * own `records`, [{ id, severity }]: the id of every source record that names
 * it, with that record's own rating (the most alarming, when two sources
 * publish one id), which is what its issue lists (.github/scripts/reconcile.mjs). The lead
 * record, whose id and summary the advisory takes, is OSV's, else GitHub
 * database's, else a repository's; `origins` binds every id in the group to
 * the source (and repository) that published it, for links, and the summary
 * it gave.
 */
export function mergeAdvisories(records) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const r of records) for (const name of [r.id, ...r.aliases]) if (!parent.has(name)) parent.set(name, name);
  for (const r of records) for (const alias of r.aliases) union(alias, r.id);
  const groups = new Map();
  for (const r of records) groups.set(find(r.id), [...(groups.get(find(r.id)) ?? []), r]);
  const merged = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => sourceTier(a) - sourceTier(b) || a.id.localeCompare(b.id));
    const lead = ordered[0];
    const packages = new Map();
    for (const r of group) {
      const curated = r.sources.every((source) => source !== "github-repository");
      for (const { pkg, fixed } of r.packages) {
        const claims = packages.get(pkg) ?? { fixed: [], curatedFixed: [], severity: null, records: [] };
        const same = claims.records.find((record) => record.id === r.id);
        packages.set(pkg, {
          fixed: sortVersions([...claims.fixed, ...fixed]),
          curatedFixed: curated ? sortVersions([...claims.curatedFixed, ...fixed]) : claims.curatedFixed,
          severity: claims.severity === null ? highest([r.severity]) : highest([claims.severity, r.severity]),
          records: [...claims.records.filter((record) => record !== same), { id: r.id, severity: highest([r.severity, ...(same ? [same.severity] : [])]) }].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        });
      }
    }
    const origins = new Map();
    for (const r of ordered) {
      const origin = { id: r.id, source: r.sources[0], ...(r.repository ? { repository: r.repository } : {}), summary: r.summary ?? "" };
      if (!origins.has(`${r.id} ${origin.source} ${origin.repository ?? ""}`)) origins.set(`${r.id} ${origin.source} ${origin.repository ?? ""}`, origin);
    }
    const claims = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([pkg, claim]) => ({ pkg, ...claim }));
    merged.push({
      id: lead.id,
      aliases: [...new Set(group.flatMap((r) => [r.id, ...r.aliases]))].filter((a) => a !== lead.id).sort(),
      summary: ordered.find((r) => r.summary)?.summary ?? "",
      severity: highest(claims.map((claim) => claim.severity)),
      packages: claims,
      sources: [...new Set(group.flatMap((r) => r.sources))].sort(),
      origins: [...origins.values()],
    });
  }
  return merged.sort((a, b) => rankOf(b.severity) - rankOf(a.severity) || a.id.localeCompare(b.id));
}

/** A record's place as a merged advisory's lead: OSV first, then GitHub's database, then a repository's own. */
const sourceTier = (record) => Math.min(...record.sources.map((source) => ({ osv: 0, github: 1, "github-repository": 2 })[source] ?? 3));

/**
 * Every source's advisories affecting `packages` (name@version, npm), merged:
 * { advisories: [{ id, aliases, summary, severity, packages: [{ pkg,
 * fixed: [versions], curatedFixed, severity, records }], sources, origins }], most
 * severe first (mergeAdvisories); sources: what each
 * source was asked and when; gaps }. `watch`: package names whose own
 * repository's advisories are read too (the device tools).
 */
export async function scanAdvisories(packages, { watch = [], meta = npmMeta } = {}) {
  const list = [...new Set(packages)].sort();
  const watched = new Set(watch);
  const at = () => new Date().toISOString();
  const osv = await osvAdvisories(list);
  const osvAt = at();
  const database = await githubDatabase(list);
  const databaseAt = at();
  const repos = await repositoryAdvisories(list, watched, { meta });
  const sources = [
    { source: "OSV.dev", packages: list.length, at: osvAt },
    { source: "GitHub Advisory Database", packages: list.length, requests: database.requests, authenticated: githubToken() !== null, at: databaseAt },
    { source: "GitHub repository advisories", packages: list.filter((pkg) => watched.has(split(pkg).name)).length, repositories: repos.repositories, at: at() },
  ];
  return { advisories: mergeAdvisories([...osv, ...database.advisories, ...repos.advisories]), sources, gaps: repos.gaps };
}

/**
 * Throws unless `scan` (scanAdvisories) covered every package it was asked
 * about: a decision on it (the fast lane) must never read a source it
 * couldn't ask as "no advisories". Returns its advisories.
 */
export function completeAdvisories(scan) {
  if (scan.gaps.length) throw new Error(`advisory coverage is incomplete, so nothing is decided on it: ${scan.gaps.join("; ")}`);
  return scan.advisories;
}

/**
 * scanAdvisories' advisories, or a throw when any source left a gap
 * (completeAdvisories): what the fast lane acts on. The alert job reads the
 * partial result and its gaps from scanAdvisories instead.
 */
export const findAdvisories = async (packages, opts) => completeAdvisories(await scanAdvisories(packages, opts));
