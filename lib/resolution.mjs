// What a fresh dependency resolution may bring in: WORK's re-resolution under
// the security overrides (lib/build.mjs installDependencies) and the packager's
// staged production install (lib/stage-install.mjs). Each is resolved first,
// lockfile only and with scripts off, checked here, and only then installed
// frozen, so no lifecycle script of an unchecked version ever runs. What a
// lockfile installs from the checkout itself (workspace projects, links, file:
// folders and tarballs) must be what the pinned commit has there (checkLinksInTree).

import * as fs from "node:fs";
import * as path from "node:path";

import { MIN_AGE_DAYS, dependencyAgeGate, heldDependencies, lockIdentities, substitutions } from "./gates.mjs";
import { inTree, parseLockfile, splitPackage } from "./lockfile.mjs";
import { overrideFor, readOverrides } from "./overrides.mjs";

/**
 * Checks `resolvedText` (a pnpm-lock.yaml just resolved) against `baseText`
 * (the verified lockfile it started from): every package comes from the npm
 * registry or upstream's tree (lib/gates.mjs resolutionKind), no version keeps
 * different bytes than the base locked, no version a security override replaces
 * survives, and every version the base doesn't have has the registry's integrity
 * and, unless it's an override's fix, is at least MIN_AGE_DAYS old. Returns
 * { packages, added }; throws otherwise. `what` names the resolution in errors;
 * `gate` is the age and integrity check (lib/gates.mjs dependencyAgeGate).
 */
export async function checkResolution(baseText, resolvedText, { overrides = readOverrides(), what = "the lockfile", gate = dependencyAgeGate } = {}) {
  const resolved = lockIdentities(resolvedText);
  const packages = new Set(resolved.keys());
  if (!packages.size) throw new Error(`${what} lists no packages; refusing to install a resolution nothing checked`);
  const survived = [...packages].filter((pkg) => overrideFor(pkg, overrides));
  if (survived.length) throw new Error(`security overrides didn't take: ${survived.join(", ")} still in ${what}`);
  const base = lockIdentities(baseText);
  const swapped = substitutions(base, resolved);
  if (swapped.length) throw new Error(`${what} changed what an already checked version is, so nothing was installed: ${swapped.map(({ pkg, why }) => `${pkg} ${why}`).join(", ")}`);
  const targets = new Set(overrides.map((o) => `${o.selector.slice(0, o.selector.lastIndexOf("@"))}@${o.version}`));
  const added = [...packages].filter((pkg) => !base.has(pkg) && !targets.has(pkg)).sort();
  if ([...packages].some((pkg) => !base.has(pkg))) {
    // Override fixes too: they skip the age gate (the owner chose them), not the integrity check.
    const result = await gate(baseText, resolvedText);
    const held = heldDependencies({ ...result, young: result.young.filter(({ pkg }) => !targets.has(pkg)) });
    if (held.length) throw new Error(`${what} resolved versions it can't vouch for (under ${MIN_AGE_DAYS} days old, undated, or not the registry's bytes), so nothing was installed: ${held.join(", ")}`);
  }
  return { packages, added };
}

/**
 * What a parsed lockfile (lib/lockfile.mjs) installs from the checkout instead
 * of a registry, as [{ where, kind, what }], `where` relative to the checkout's
 * root. kind "link" (pnpm symlinks the folder): each workspace project and each
 * folder an importer links to; "copy" (pnpm copies the folder's files): a
 * `file:` folder; "tarball": a `file:` tarball. Throws on one that names nothing
 * a commit could hold (lib/lockfile.mjs inTree: outside the checkout, or in
 * node_modules), or one resolved from somewhere its version doesn't say.
 */
export function localSources(lock) {
  const sources = new Map();
  const add = (where, kind, what) => {
    if (!inTree(where)) throw new Error(`pnpm-lock.yaml: ${what} isn't a path in upstream's tree`);
    if (!sources.has(`${kind} ${where}`)) sources.set(`${kind} ${where}`, { where, kind, what });
  };
  for (const key of lock.importers.keys()) add(key.slice(key.indexOf("/") + 1), "link", `workspace project ${key.slice(key.indexOf("/") + 1)}`);
  for (const { importer, name, target } of lock.links) add(target, "link", `${importer}'s link ${name} (${target})`);
  for (const key of lock.packages) {
    const local = /^(file|link|workspace):(.*)$/.exec(splitPackage(key).version);
    if (!local) continue;
    const [, scheme, where] = local;
    const { directory, tarball } = lock.resolutions.get(key) ?? {};
    const kind = typeof directory === "string" ? (scheme === "file" ? "copy" : "link") : scheme === "file" && /^file:/.test(tarball ?? "") ? "tarball" : null;
    const from = kind === "tarball" ? tarball.slice("file:".length) : directory;
    if (!kind || from !== where || where === ".") throw new Error(`pnpm-lock.yaml: ${key} isn't resolved from the folder or file its version names`);
    add(where, kind, key);
  }
  return [...sources.values()];
}

/** `git ls-tree -r -t -z <commit>` output as Map path -> "dir", "file", "symlink" or "submodule". */
export function trackedTree(text) {
  const kinds = { "040000": "dir", "100644": "file", "100755": "file", "120000": "symlink", "160000": "submodule" };
  const tree = new Map();
  for (const entry of text.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) [a-z]+ [0-9a-f]+\t(.+)$/s.exec(entry);
    if (!match || !Object.hasOwn(kinds, match[1])) throw new Error(`can't read git ls-tree's entry ${JSON.stringify(entry.slice(0, 120))}`);
    tree.set(match[2], kinds[match[1]]);
  }
  return tree;
}

/**
 * Throws unless everything `lockText` installs from the checkout `root`
 * (localSources) is what the pinned commit has there. `tree`: that commit's
 * files (trackedTree). After following symlinks, each must lead to a folder (or
 * a tarball's file) inside the checkout that the commit tracks, so not a
 * node_modules folder, build output or anything else whose bytes are only
 * whatever happens to be there; and a `file:` folder, whose files pnpm copies,
 * may hold nothing the commit doesn't (pnpm leaves out node_modules) and no
 * symlink (pnpm would copy whatever it points at). lib/lockfile.mjs keeps the
 * names inside the tree; this checks what's on disk behind them.
 */
export function checkLinksInTree(lockText, root, tree) {
  if (!(tree instanceof Map) || !tree.size) throw new Error("checkLinksInTree needs the pinned commit's files (trackedTree)");
  const top = fs.realpathSync(root);
  for (const { where, kind, what } of localSources(parseLockfile(lockText))) {
    let real = null;
    try {
      real = fs.realpathSync(path.join(top, where));
    } catch {}
    if (real === null) throw new Error(`pnpm-lock.yaml: ${what} isn't in upstream's checkout`);
    if (real !== top && !real.startsWith(`${top}${path.sep}`)) throw new Error(`pnpm-lock.yaml: ${what} leads out of upstream's checkout, to ${real}`);
    const at = real === top ? "." : path.relative(top, real).split(path.sep).join("/");
    const want = kind === "tarball" ? "file" : "dir";
    const stat = fs.lstatSync(real);
    const tracked = at === "." ? kind === "link" : inTree(at) && tree.get(at) === want;
    if (!tracked || (want === "dir" ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`pnpm-lock.yaml: ${what} is ${at}, which isn't a ${want === "dir" ? "folder" : "file"} upstream's pinned commit has`);
    }
    if (kind === "copy") checkCopiedFolder(real, at, tree, what);
  }
}

/** Throws unless every file pnpm would copy from folder `real` (`at` in the checkout) is one `tree` has. */
function checkCopiedFolder(real, at, tree, what) {
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const inside = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`pnpm-lock.yaml: ${what} holds a symlink, ${inside}; pnpm would copy whatever it points at`);
      const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
      if (tree.get(inside) !== kind) throw new Error(`pnpm-lock.yaml: ${what} holds ${inside}, which upstream's pinned commit doesn't`);
      if (kind === "dir") walk(path.join(dir, entry.name), inside);
    }
  };
  walk(real, at);
}
