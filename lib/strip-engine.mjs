// Applies the strip rules in lib/rules.mjs to an upstream checkout.
//
// Upstream lands hundreds of commits a week, so plain .patch files rot fast.
// Each rule instead names a small anchor in the source and states how many times
// it must match. If upstream moves or rewrites that code the rule fails loudly
// and the update is aborted; it never silently ships a build with telemetry
// back on.

import * as fs from "node:fs";
import * as path from "node:path";

export class RuleDrift extends Error {
  /** `anchor`: the text the rule looks for, when it was the anchor that went missing. */
  constructor(message, { file = null, anchor = null } = {}) {
    super(message);
    this.file = file;
    this.anchor = anchor;
  }
}

function countMatches(source, find) {
  if (typeof find === "string") return source.split(find).length - 1;
  const flags = find.flags.includes("g") ? find.flags : find.flags + "g";
  return [...source.matchAll(new RegExp(find.source, flags))].length;
}

function applyReplace(root, rule) {
  const file = path.join(root, rule.file);
  if (!fs.existsSync(file)) throw new RuleDrift(`${rule.id}: ${rule.file} no longer exists`, { file: rule.file });
  let source = fs.readFileSync(file, "utf8");
  for (const edit of rule.edits) {
    const found = countMatches(source, edit.find);
    const expected = edit.count ?? 1;
    if (found !== expected) {
      throw new RuleDrift(
        `${rule.id}: expected ${expected} match(es) of ${String(edit.find)} in ${rule.file}, found ${found}`,
        { file: rule.file, anchor: typeof edit.find === "string" ? edit.find : edit.find.source },
      );
    }
    source =
      typeof edit.find === "string"
        ? source.split(edit.find).join(edit.replace)
        : source.replace(new RegExp(edit.find.source, edit.find.flags.includes("g") ? edit.find.flags : edit.find.flags + "g"), edit.replace);
  }
  fs.writeFileSync(file, source);
}

function applyWrite(root, rule) {
  const file = path.join(root, rule.file);
  if (fs.existsSync(file) && !rule.overwrite) {
    throw new RuleDrift(`${rule.id}: ${rule.file} already exists upstream; refusing to overwrite`, { file: rule.file });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rule.content);
}

/**
 * Replaces a phrase in every matching file under `roots`. For text spread over
 * hundreds of files, where per-file anchors would drift daily; `minCount` still
 * catches upstream renaming the phrase itself.
 */
function applyRebrand(root, rule) {
  const files = [];
  const walk = (full) => {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) {
        if (entry !== "node_modules" && entry !== "dist") walk(path.join(full, entry));
      }
    } else if (rule.include.test(full)) {
      files.push(full);
    }
  };
  for (const relative of rule.roots) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) throw new RuleDrift(`${rule.id}: ${relative} no longer exists`);
    walk(full);
  }
  let total = 0;
  for (const file of files) {
    const parts = fs.readFileSync(file, "utf8").split(rule.find);
    if (parts.length === 1) continue;
    total += parts.length - 1;
    fs.writeFileSync(file, parts.join(rule.replace));
  }
  if (total < rule.minCount) {
    throw new RuleDrift(`${rule.id}: expected at least ${rule.minCount} occurrences of "${rule.find}", found ${total}`);
  }
}

/**
 * Applies every rule; collects all drift so one run shows everything that broke,
 * as { id, message, file, anchor }.
 */
export function applyRules(root, rules) {
  const failures = [];
  for (const rule of rules) {
    try {
      if (rule.kind === "write") applyWrite(root, rule);
      else if (rule.kind === "rebrand") applyRebrand(root, rule);
      else applyReplace(root, rule);
      console.log(`  ✓ ${rule.id}`);
    } catch (error) {
      if (!(error instanceof RuleDrift)) throw error;
      failures.push({ id: rule.id, message: error.message, file: error.file, anchor: error.anchor });
      console.log(`  ✗ ${error.message}`);
    }
  }
  return failures;
}

/**
 * Every hostname written as a URL in the source under `dirs` (relative to
 * `root`), mapped to where it first appears. Tests, fixtures and docs are
 * skipped: they never reach the app.
 */
export function findHosts(root, dirs) {
  const hosts = new Map();
  const skipDir = /^(node_modules|dist|build|test|tests|__tests__|fixtures|__fixtures__)$|-testing$/;
  const skipFile = /\.(test|spec|testkit|bench)\.|\.(md|snap)$/;
  const url = /(?:https?|wss?):\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir.test(entry.name)) walk(full);
      } else if (/\.(ts|tsx|m?js|cjs|json|html)$/.test(entry.name) && !skipFile.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const match of text.matchAll(url)) {
          const host = match[1].toLowerCase();
          if (hosts.has(host)) continue;
          const line = text.slice(0, match.index).split("\n").length;
          hosts.set(host, `${path.relative(root, full)}:${line}`);
        }
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return hosts;
}

/**
 * Greps built output for strings that must never ship. Runs after the build so
 * it also catches phone-homes upstream adds in places no rule knows about yet.
 */
export function scanForbidden(dirs, forbidden) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(m?js|cjs|html|json|asar)$/.test(entry.name)) {
        // latin1 keeps ASCII needles intact inside binary .asar archives.
        const text = fs.readFileSync(full, "latin1");
        for (const needle of forbidden) {
          if (text.includes(needle)) hits.push(`${full}: ${needle}`);
        }
      }
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return hits;
}
