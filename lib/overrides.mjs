// Security overrides (lib/overrides.json): dependency versions with advisories
// upstream hasn't fixed, replaced in every build through pnpm's overrides. A repo
// file, so only a commit the repository owner signs can change one; the
// evaluator's key can't (lib/selfupdate.mjs).
//
// Each entry names the vulnerable version found (`selector`) and the fix
// (`version`). The override covers its whole line below the fix (the major, or
// for 0.x the minor), `name@>=<line floor> <fix>`, because pnpm matches override
// keys against the range a dependent asks for (`^8.11.2`), not the version it
// resolved. Versions compare as SemVer (lib/semver.mjs).

import * as fs from "node:fs";

import { compareVersions, lineFloor as floorOf, parseVersion } from "./semver.mjs";
import { RuleDrift } from "./strip-engine.mjs";
import { entryOf, parseDocuments } from "./yaml.mjs";

const FILE = new URL("./overrides.json", import.meta.url);
const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
/** Exact versions as overrides.json writes them: SemVer, no "v". */
const isVersion = (v) => typeof v === "string" && !v.startsWith("v") && parseVersion(v) !== null;

const split = (pkg) => {
  const at = pkg.lastIndexOf("@");
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
};

/** [{ selector: "name@version", version, advisories }] from lib/overrides.json, validated. */
export const readOverrides = () => parseOverrides(fs.readFileSync(FILE, "utf8"));

/** overrides.json's text (this clone's, or as committed at some revision) as readOverrides returns it. */
export function parseOverrides(text) {
  const { overrides } = JSON.parse(text);
  if (!Array.isArray(overrides)) throw new Error("lib/overrides.json: overrides isn't a list");
  for (const o of overrides) {
    if (typeof o.selector !== "string" || !NAME.test(split(o.selector).name) || !isVersion(split(o.selector).version) || !isVersion(o.version) || !Array.isArray(o.advisories)) {
      throw new Error(`lib/overrides.json: invalid entry ${JSON.stringify(o)}`);
    }
    const found = split(o.selector).version;
    if (floorOf(found) !== floorOf(o.version) || compareVersions(o.version, found) <= 0) {
      throw new Error(`lib/overrides.json: ${o.selector} -> ${o.version} must be a newer version in the same major line`);
    }
  }
  return overrides;
}

/** Each override as { name, from (inclusive), to (exclusive, the fix) }. */
const spans = (overrides) =>
  overrides.map((o) => {
    const { name, version } = split(o.selector);
    return { name, from: floorOf(version), to: o.version };
  });

/** The overrides as pnpm-workspace.yaml `overrides:` lines. */
export const overrideYamlLines = (overrides = readOverrides()) => [
  ...new Set(spans(overrides).map((s) => `  "${s.name}@>=${s.from} <${s.to}": ${s.to}`)),
].join("\n");

/** The override covering `pkg` (name@version), or null. */
export function overrideFor(pkg, overrides = readOverrides()) {
  const { name, version } = split(pkg);
  return (
    spans(overrides).find((s) => s.name === name && compareVersions(version, s.from) >= 0 && compareVersions(version, s.to) < 0) ?? null
  );
}

/** `packages` (name@version) as a build with the overrides installs them. */
export function applyOverrides(packages, overrides = readOverrides()) {
  return [
    ...new Set(
      packages.map((pkg) => {
        const span = overrideFor(pkg, overrides);
        return span ? `${span.name}@${span.to}` : pkg;
      }),
    ),
  ];
}

/** The first version past a caret or tilde range: ^1.2.3 -> 2.0.0-0, ^0.2.3 -> 0.3.0-0, ~1.2.3 -> 1.3.0-0. */
function rangeEnd(op, version) {
  const { major, minor, patch } = parseVersion(version);
  const next = (n) => String(BigInt(n) + 1n);
  if (op === "~") return `${major}.${next(minor)}.0-0`;
  if (major !== "0") return `${next(major)}.0.0-0`;
  return minor !== "0" ? `0.${next(minor)}.0-0` : `0.0.${next(patch)}-0`;
}

/**
 * A catalog range for `name` raised to the override's fix, or null when no span
 * overlaps it. Exact versions, ^ and ~ ranges (and npm: aliases of them) are
 * understood; any other range for an overridden package throws, as it might
 * keep a vulnerable version in.
 */
function raisedRange(name, range, overrides) {
  const match = /^([~^]|=)?(\S+)$/.exec(range.trim());
  if (!match || !isVersion(match[2])) {
    throw new RuleDrift(`pnpm-workspace.yaml: catalog entry ${name}: ${range} can't be checked against the security override for ${name}; expected an exact version or a ^/~ range`, { file: "pnpm-workspace.yaml" });
  }
  const [, op = "", low] = match;
  const end = op === "^" || op === "~" ? rangeEnd(op, low) : null;
  const span = spans(overrides).find(
    (s) => s.name === name && compareVersions(low, s.to) < 0 && (end ? compareVersions(end, s.from) > 0 : compareVersions(low, s.from) >= 0),
  );
  return span ? `${op === "=" ? "" : op}${span.to}` : null;
}

/**
 * pnpm-workspace.yaml with every catalog entry (the default `catalog:` and each
 * named one under `catalogs:`) that could resolve inside an override's span raised
 * to its fix. Upstream's own overrides can point at a catalog (e.g. "undici@^8":
 * "catalog:"), which would otherwise win over ours. The file is read structurally
 * (lib/yaml.mjs), so quoting, comments and flow style don't hide an entry; YAML it
 * can't read, or an overridden package's range it can't judge, throws RuleDrift.
 */
export function raiseCatalog(yaml, overrides = readOverrides()) {
  const drift = (why) => new RuleDrift(`pnpm-workspace.yaml: ${why}`, { file: "pnpm-workspace.yaml" });
  let docs;
  try {
    docs = parseDocuments(yaml);
  } catch (error) {
    throw drift(error.message);
  }
  if (docs.length !== 1 || docs[0].type !== "map") throw drift("isn't a single YAML mapping");
  const catalogs = [];
  const isEmpty = (node) => node.type === "scalar" && node.style === "empty";
  const catalog = entryOf(docs[0], "catalog");
  if (catalog && !isEmpty(catalog.value)) catalogs.push(["catalog", catalog.value]);
  const named = entryOf(docs[0], "catalogs");
  if (named && !isEmpty(named.value)) {
    if (named.value.type !== "map") throw drift("catalogs isn't a mapping");
    for (const { key, value } of named.value.entries) if (!isEmpty(value)) catalogs.push([`catalogs.${key.text}`, value]);
  }
  const overridden = new Set(spans(overrides).map((s) => s.name));
  const edits = [];
  for (const [where, node] of catalogs) {
    if (node.type !== "map") throw drift(`${where} isn't a mapping`);
    for (const { key, value } of node.entries) {
      if (value.type !== "scalar" || value.style === "empty") throw drift(`${where}.${key.text} isn't a version`);
      const alias = /^npm:((?:@[^@/\s]+\/)?[^@/\s]+)@(.+)$/.exec(value.text);
      const name = alias ? alias[1] : key.text;
      if (!overridden.has(name)) continue;
      const raised = raisedRange(name, alias ? alias[2] : value.text, overrides);
      if (raised !== null) edits.push({ value, text: alias ? `npm:${name}@${raised}` : raised, flow: Boolean(node.flow) });
    }
  }
  let out = yaml;
  for (const { value, text, flow } of edits.sort((a, b) => b.value.start - a.value.start)) {
    const quote = value.style === "single" ? "'" : value.style === "double" ? '"' : "";
    const lineEnd = out.indexOf("\n", value.end) === -1 ? out.length : out.indexOf("\n", value.end);
    const rest = out.slice(value.end, lineEnd);
    const note = !flow && /^\s*(#.*)?\r?$/.test(rest) ? ` # t3blackout security override (was ${value.text})${rest.endsWith("\r") ? "\r" : ""}` : rest;
    out = `${out.slice(0, value.start)}${quote}${text}${quote}${note}${out.slice(lineEnd)}`;
  }
  return out;
}
