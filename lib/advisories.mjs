// Known vulnerabilities in what the machines run: every package in the pinned
// release's lockfile (Electron, and with it Chromium, included) and the device
// tools in pin.json, looked up in OSV.dev, which carries the GitHub Advisory
// Database among others. The evaluator uses the results twice: alerts (open
// advisories, and ones a new pin fixed) and a fast lane, which waives the
// minimum dependency age for an attested version that fixes an open advisory.
//
// A scan is all or nothing: a page OSV continues (next_page_token) is followed, and
// an answer that doesn't cover every query throws, so issues are never reconciled
// against a partial list and closed by mistake.

import { cvssScore, scoreSeverity } from "./cvss.mjs";
import { request } from "./http.mjs";
import { compareVersions, parseVersion } from "./semver.mjs";

const OSV = "https://api.osv.dev/v1";
const SEVERITY_ORDER = ["LOW", "MODERATE", "HIGH", "CRITICAL"];
/** OSV caps a querybatch at 1000 queries. */
const BATCH = 1000;
/** Continuation rounds before a scan is called runaway. */
const MAX_PAGES = 50;

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
  return stated.sort((a, b) => SEVERITY_ORDER.indexOf(b) - SEVERITY_ORDER.indexOf(a))[0];
}

/** High, critical, or unrated: each gets its own issue. */
export const isAlerting = (severity) => severity === "HIGH" || severity === "CRITICAL" || severity === "UNKNOWN";

/** Versions an OSV record says fix `name` (npm), lowest first (anything that isn't SemVer last). */
export function fixedVersions(vuln, name) {
  const fixed = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.ecosystem !== "npm" || affected.package?.name !== name) continue;
    for (const range of affected.ranges ?? []) for (const event of range.events ?? []) if (event.fixed) fixed.push(String(event.fixed));
  }
  const valid = (v) => parseVersion(v) !== null;
  return [...new Set(fixed)].sort((a, b) => (valid(a) && valid(b) ? compareVersions(a, b) : valid(a) ? -1 : valid(b) ? 1 : a.localeCompare(b)));
}

const split = (pkg) => {
  const at = pkg.lastIndexOf("@");
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
};

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

/**
 * Advisories affecting `packages` (name@version, npm): [{ id, aliases, summary,
 * severity, url, packages: [{ pkg, fixed: [versions] }] }], most severe first.
 */
export async function findAdvisories(packages) {
  const list = [...new Set(packages)].sort();
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
      url: `https://osv.dev/vulnerability/${id}`,
      packages: pkgs.map((pkg) => ({ pkg, fixed: fixedVersions(vuln, split(pkg).name) })),
    });
  }
  const rank = (severity) => (severity === "UNKNOWN" ? 2.5 : SEVERITY_ORDER.indexOf(severity));
  return advisories.sort((a, b) => rank(b.severity) - rank(a.severity) || a.id.localeCompare(b.id));
}
