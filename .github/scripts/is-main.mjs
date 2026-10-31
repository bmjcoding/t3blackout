// Whether a script was run directly (node <script>) rather than imported, by
// canonical path: a lexical comparison misses symlinked directories (on macOS,
// /tmp is /private/tmp), and the script then exits 0 having done nothing.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const canonical = (file) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

/** True when `moduleUrl` (the caller's import.meta.url) is the entry point node was given. */
export function isMain(moduleUrl, argv = process.argv) {
  if (!argv[1]) return false;
  const entry = canonical(argv[1]);
  return entry !== null && entry === canonical(fileURLToPath(moduleUrl));
}
