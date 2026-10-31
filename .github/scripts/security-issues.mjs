// The alert job's issues (.github/workflows/evaluate.yml; the logic is in
// reconcile.mjs):
//   node .github/scripts/security-issues.mjs advisories <advisories.json>
//       (written by bin/t3blackout advisories, against the pin on main)
//   node .github/scripts/security-issues.mjs held --channel C --exit N --published REF --pinned REF --newer FILE --report FILE
//       (--published: the ref the commit job pushed, if any; --newer: bin/t3blackout releases --out)
// GH_TOKEN and GH_REPO set; DRY_RUN=1 reads issues but only prints what it would change.

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import { githubClient } from "./github.mjs";
import { reconcileAdvisories, reconcileHeld } from "./reconcile.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string" },
    exit: { type: "string" },
    published: { type: "string" },
    pinned: { type: "string" },
    report: { type: "string" },
    newer: { type: "string" },
  },
});

const gh = githubClient({ token: process.env.GH_TOKEN, repo: process.env.GH_REPO, dryRun: process.env.DRY_RUN === "1" });
const readIfThere = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** The newer upstream releases bin/t3blackout releases found for `channel`, or null when it didn't say. */
function readNewer(file, channel) {
  try {
    const found = JSON.parse(readIfThere(file));
    return found?.channel === channel && Array.isArray(found.newer) && found.newer.every((tag) => typeof tag === "string") ? found.newer : null;
  } catch {
    return null;
  }
}

if (positionals[0] === "advisories" && positionals[1]) {
  await reconcileAdvisories(JSON.parse(fs.readFileSync(positionals[1], "utf8")), gh);
} else if (positionals[0] === "held") {
  const report = readIfThere(values.report);
  // A failed evaluation fails this step too (reconcileHeld throws); its report goes to the log first.
  if (values.exit !== "0" && values.exit !== "3") console.log(report);
  const newer = readNewer(values.newer, values.channel);
  await reconcileHeld({ channel: values.channel, exit: values.exit, published: values.published ?? "", pinned: values.pinned ?? "", newer, report }, gh);
} else {
  console.error("usage: security-issues.mjs advisories <advisories.json> | held --channel C --exit N --published REF --pinned REF --newer FILE --report FILE");
  process.exit(2);
}
