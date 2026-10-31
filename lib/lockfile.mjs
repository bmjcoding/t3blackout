// pnpm-lock.yaml's dependency graph, read structurally (lib/yaml.mjs throws on
// YAML it can't read), because what reads a lockfile here decides what gets
// checked: an entry it skipped would be a package nobody checked.

import * as path from "node:path";

import { parseYaml } from "./yaml.mjs";

/** `name@version` -> { name, version }; the version may be `file:`, a URL, etc. */
export function splitPackage(pkg) {
  const at = pkg.indexOf("@", pkg.startsWith("@") ? 1 : 0);
  if (at <= 0) throw new Error(`not a name@version: ${pkg}`);
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
}

/** A snapshot key or dependency reference without its peer suffix: `a@1.0.0(b@2.0.0)` -> `a@1.0.0`. */
export const withoutPeers = (ref) => {
  const { name, version } = splitPackage(ref);
  const paren = version.indexOf("(");
  return `${name}@${paren === -1 ? version : version.slice(0, paren)}`;
};

/** Whether a locked version comes from the npm registry: not a workspace link, local file, tarball URL or git ref. */
export const isRegistryVersion = (version) => /^\d/.test(version);

/** A folder in upstream's checkout, relative to its root: "." or a plain relative path, no `..` and nothing odd in it. */
const IN_TREE = /^(?:\.|(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@.+-]+(?:\/[\w@.+-]+)*)$/;

/**
 * Whether `where` can name something upstream's commit holds: a path IN_TREE
 * that isn't in a node_modules folder (installed, never committed). The build
 * then checks it really is in the pinned commit (lib/resolution.mjs).
 */
export const inTree = (where) => typeof where === "string" && IN_TREE.test(where) && !/(?:^|\/)node_modules(?:\/|$)/.test(where);

/**
 * The folder a workspace link `link:<to>` from importer `where` names, relative
 * to the checkout's root, or null when `ref` isn't a link. Throws when it leads
 * out of the checkout (an absolute path, or `..` past its root) or into a
 * node_modules folder: what's there isn't part of the pinned commit, so nothing
 * could vouch for it.
 */
function linkTarget(where, ref, name) {
  const value = typeof ref === "object" && ref !== null ? ref.version : ref;
  if (typeof value !== "string" || !value.startsWith("link:")) return null;
  const to = value.slice("link:".length);
  const target = path.posix.normalize(path.posix.join(where, to)).replace(/\/$/, "");
  if (!inTree(where) || path.posix.isAbsolute(to) || to.includes("\\") || !inTree(target)) {
    throw new Error(`pnpm-lock.yaml: ${where} links ${name} to ${to}, outside upstream's tree (or in node_modules, which no commit holds)`);
  }
  return target;
}

/**
 * The snapshot key a dependency `name: ref` points at, or null for a workspace
 * link (parseLockfile checks where it leads). An alias (`typescript:
 * '@tsc-rs/typescript@0.8.0'`) names its real package.
 */
function snapshotKey(name, ref) {
  const value = typeof ref === "object" && ref !== null ? ref.version : ref;
  if (typeof value !== "string" || !value) throw new Error(`dependency ${name} has no version`);
  if (/^link:/.test(value)) return null;
  const head = value.split("(")[0];
  const aliased = /^(@[^@/]+\/)?[^@/]+@./.test(head) && !/^(file|https?|git\+[a-z]+):/.test(head);
  return aliased ? value : `${name}@${value}`;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const IMPORTER_FIELDS = [...DEP_FIELDS, "configDependencies", "packageManagerDependencies"];

/**
 * A pnpm lockfile (v9) as { packages: Set<name@version>, roots: [snapshot keys],
 * deps: Map<snapshot key, [snapshot keys]>, resolutions: Map<name@version,
 * resolution>, importers: Map<"document/path", Map<"field name", snapshot key or
 * null for a link>>, edges: Map<snapshot key, Map<"field name", snapshot key>>,
 * links: [{ importer, name, target }] (each workspace link's folder, relative to
 * the checkout) }, every document merged. Throws on an unsupported lockfile
 * version, a reference to a package the lockfile lacks, or a link that leads out
 * of upstream's tree (only importers may link, to folders inside it).
 */
export function parseLockfile(text) {
  const docs = parseYaml(text);
  if (!docs.length) throw new Error("pnpm-lock.yaml is empty");
  const packages = new Set();
  const resolutions = new Map();
  const roots = [];
  const deps = new Map();
  const edges = new Map();
  const importers = new Map();
  const links = [];
  for (const [index, doc] of docs.entries()) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("pnpm-lock.yaml: a document isn't a mapping");
    if (String(doc.lockfileVersion) !== "9.0") throw new Error(`pnpm-lock.yaml: lockfile version ${doc.lockfileVersion} isn't supported (9.0)`);
    const section = (name) => {
      const value = doc[name] ?? {};
      if (typeof value !== "object" || Array.isArray(value)) throw new Error(`pnpm-lock.yaml: ${name} isn't a mapping`);
      return value;
    };
    for (const [key, info] of Object.entries(section("packages"))) {
      splitPackage(key);
      if (resolutions.has(key) && JSON.stringify(resolutions.get(key)) !== JSON.stringify(info?.resolution ?? null)) {
        throw new Error(`pnpm-lock.yaml: ${key} is resolved two ways`);
      }
      packages.add(key);
      resolutions.set(key, info?.resolution ?? null);
    }
    for (const [key, snapshot] of Object.entries(section("snapshots"))) {
      const named = new Map();
      for (const field of DEP_FIELDS.filter((f) => f !== "devDependencies")) {
        for (const [name, ref] of Object.entries(snapshot?.[field] ?? {})) {
          const target = snapshotKey(name, ref);
          if (!target) throw new Error(`pnpm-lock.yaml: ${key} links ${name}; only workspace projects may link`);
          named.set(`${field} ${name}`, target);
        }
      }
      deps.set(key, [...named.values()]);
      edges.set(key, named);
    }
    for (const [where, importer] of Object.entries(section("importers"))) {
      const named = new Map();
      for (const field of IMPORTER_FIELDS) {
        for (const [name, ref] of Object.entries(importer?.[field] ?? {})) {
          const target = snapshotKey(name, ref);
          named.set(`${field} ${name}`, target);
          if (target) roots.push(target);
          else links.push({ importer: where, name, target: linkTarget(where, ref, name) });
        }
      }
      importers.set(`${index}/${where}`, named);
    }
  }
  // Every reference must resolve to a snapshot, or what it brings in would go unseen.
  for (const key of [...roots, ...[...deps.values()].flat()]) {
    if (!deps.has(key)) throw new Error(`pnpm-lock.yaml refers to ${key}, which it has no snapshot of`);
    if (!packages.has(withoutPeers(key))) throw new Error(`pnpm-lock.yaml refers to ${key}, which its packages don't list`);
  }
  return { packages, roots, deps, resolutions, importers, edges, links };
}

/**
 * Packages (name@version) reachable from the importers, not entering any
 * snapshot `cut(pkg)` says to stop at (e.g. one a security override replaces).
 */
export function reachablePackages(lock, cut = () => false) {
  const seen = new Set();
  const out = new Set();
  const stack = [...lock.roots];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const pkg = withoutPeers(key);
    if (cut(pkg)) continue;
    out.add(pkg);
    stack.push(...(lock.deps.get(key) ?? []));
  }
  return out;
}

/** The registry packages (name@version) of a parsed lockfile, sorted. */
export const registryPackages = (packages) => [...packages].filter((pkg) => isRegistryVersion(splitPackage(pkg).version)).sort();
