// CI (.github/workflows/build.yml): runs the tests in test/stripped/ inside a
// stripped, installed upstream checkout. Each test's first line says where it
// belongs ("// Copied to <dir>/ in a stripped upstream checkout"); a test that
// needs a real host (an e2e test) skips itself unless its variable is set, and a
// *.browser.test.tsx runs in upstream's headless Chromium project.
// Usage: node .github/scripts/stripped-tests.mjs <stripped checkout>

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { STOCK_GUIDANCE } from "../../lib/rules.mjs";
import { isMain } from "./is-main.mjs";

const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "stripped");

/** Where a stripped test goes, from its first line; throws when it doesn't say. */
export function destinationOf(text, name) {
  const match = /^\/\/ Copied to (\S+?)\/? in a stripped upstream checkout/.exec(String(text));
  if (!match || match[1].split("/").includes("..") || path.isAbsolute(match[1])) {
    throw new Error(`test/stripped/${name} doesn't start with "// Copied to <dir>/ in a stripped upstream checkout"`);
  }
  return match[1];
}

/** lib/rules.mjs's STOCK_GUIDANCE as JSON: [{ label, source, flags }]. */
export const stockGuidanceJson = () => STOCK_GUIDANCE.map(({ label, pattern }) => ({ label, source: pattern.source, flags: pattern.flags }));

if (isMain(import.meta.url)) {
  const work = process.argv[2];
  if (!work || !fs.existsSync(path.join(work, "pnpm-lock.yaml"))) {
    console.error("usage: stripped-tests.mjs <stripped, installed upstream checkout>");
    process.exit(2);
  }
  const files = fs.readdirSync(TESTS).filter((name) => /\.test\.tsx?$/.test(name)).sort();
  if (!files.length) throw new Error("test/stripped has no tests");
  const targets = files.map((name) => {
    const dir = destinationOf(fs.readFileSync(path.join(TESTS, name), "utf8"), name);
    if (!fs.existsSync(path.join(work, dir))) throw new Error(`test/stripped/${name} goes in ${dir}, which upstream doesn't have anymore`);
    fs.copyFileSync(path.join(TESTS, name), path.join(work, dir, name));
    return path.posix.join(dir, name);
  });
  console.log(`running ${targets.join(", ")}`);
  // Never let the test run install anything (pnpm's verify-deps-before-run would, scripts and all).
  const env = { ...process.env, npm_config_verify_deps_before_run: "false", pnpm_config_verify_deps_before_run: "false" };
  // The stock-guidance patterns, for the tests that check the links and prompts the app builds at run time.
  env.T3BLACKOUT_STOCK_GUIDANCE = JSON.stringify(stockGuidanceJson());
  const result = spawnSync("pnpm", ["exec", "vp", "test", "run", ...targets], { cwd: work, stdio: "inherit", env });
  process.exit(result.status ?? 1);
}
