// CI: every action a workflow uses is pinned to a full commit SHA (the
// repository also enforces this; the check keeps forks and PRs honest). Reads
// each workflow as YAML (lib/yaml.mjs), so a `uses` key counts however it's
// written: block or flow mapping, quoted or not. YAML the reader can't read
// (anchors, say) fails the check rather than hiding a `uses` from it.
// Usage: node .github/scripts/check-action-pins.mjs [workflow files...]

import * as fs from "node:fs";
import * as path from "node:path";

import { parseDocuments, toValue } from "../../lib/yaml.mjs";
import { isMain } from "./is-main.mjs";

/** The value of each `uses` key, anywhere in a workflow's text: [{ line, value }]. Throws YamlError on YAML it can't read. */
export function usesValues(text) {
  const out = [];
  const visit = (node) => {
    if (node.type === "seq") node.items.forEach(visit);
    if (node.type !== "map") return;
    for (const { key, value } of node.entries) {
      if (key.type === "scalar" && toValue(key) === "uses") {
        out.push({ line: (value.line ?? key.line) + 1, value: value.type === "scalar" ? String(toValue(value) ?? "") : `(a ${value.type === "map" ? "mapping" : "sequence"})` });
      }
      visit(value);
    }
  };
  parseDocuments(text, { blockScalars: true }).forEach(visit);
  return out.sort((a, b) => a.line - b.line);
}

/** Why a `uses:` value isn't pinned, or null: local actions are fine, others need @<40 hex> (docker: @sha256). */
export function unpinned(value) {
  if (value.startsWith("./")) return null;
  if (value.startsWith("docker://")) return /@sha256:[0-9a-f]{64}$/.test(value) ? null : "docker image without a sha256 digest";
  return /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(value) ? null : "not pinned to a full commit SHA";
}

/** Problems in `files`, one line each. */
export function checkFiles(files, read = (file) => fs.readFileSync(file, "utf8")) {
  return files.flatMap((file) => {
    let values;
    try {
      values = usesValues(read(file));
    } catch (error) {
      return [`${file}: can't read it as YAML, so its actions can't be checked: ${error.message}`];
    }
    return values.flatMap(({ line, value }) => {
      const why = unpinned(value);
      return why ? [`${file}:${line}: ${value}: ${why}`] : [];
    });
  });
}

if (isMain(import.meta.url)) {
  const dir = ".github/workflows";
  const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
  const problems = checkFiles(files);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`${files.length} workflow(s): every action is pinned to a commit SHA`);
}
