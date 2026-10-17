// Applies the strip rules in lib/rules.mjs to an upstream checkout.
//
// Upstream lands hundreds of commits a week, so plain .patch files rot fast.
// Each rule instead names a small anchor in the source and states how many times
// it must match. If upstream moves or rewrites that code the rule fails loudly
// and the update is aborted; it never silently ships a build with telemetry
// back on.

import * as fs from "node:fs";
import * as path from "node:path";

export class RuleDrift extends Error {}

function countMatches(source, find) {
  if (typeof find === "string") return source.split(find).length - 1;
  const flags = find.flags.includes("g") ? find.flags : find.flags + "g";
  return [...source.matchAll(new RegExp(find.source, flags))].length;
}

function applyReplace(root, rule) {
  const file = path.join(root, rule.file);
  if (!fs.existsSync(file)) throw new RuleDrift(`${rule.id}: ${rule.file} no longer exists`);
  let source = fs.readFileSync(file, "utf8");
  for (const edit of rule.edits) {
    const found = countMatches(source, edit.find);
    const expected = edit.count ?? 1;
    if (found !== expected) {
      throw new RuleDrift(
        `${rule.id}: expected ${expected} match(es) of ${String(edit.find)} in ${rule.file}, found ${found}`,
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
    throw new RuleDrift(`${rule.id}: ${rule.file} already exists upstream; refusing to overwrite`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rule.content);
}

/** Applies every rule; collects all drift so one run shows everything that broke. */
export function applyRules(root, rules) {
  const failures = [];
  for (const rule of rules) {
    try {
      if (rule.kind === "write") applyWrite(root, rule);
      else applyReplace(root, rule);
      console.log(`  ✓ ${rule.id}`);
    } catch (error) {
      if (!(error instanceof RuleDrift)) throw error;
      failures.push(error.message);
      console.log(`  ✗ ${error.message}`);
    }
  }
  return failures;
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
