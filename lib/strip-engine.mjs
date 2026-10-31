// Applies the strip rules in lib/rules.mjs to an upstream checkout.
//
// Upstream lands hundreds of commits a week, so plain .patch files rot fast.
// Each rule instead names a small anchor in the source and states how many times
// it must match. If upstream moves or rewrites that code the rule fails loudly
// and the update is aborted; it never silently ships a build with telemetry
// back on.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export class RuleDrift extends Error {
  /**
   * `anchor`: the text the rule looks for, when it was the anchor that went
   * missing (a regex's source); `pattern`: the regex itself, so the drift report
   * can find the text it matched in the baseline.
   */
  constructor(message, { file = null, anchor = null, pattern = null } = {}) {
    super(message);
    this.file = file;
    this.anchor = anchor;
    this.pattern = pattern;
  }
}

// ------------------------------------------------- writes inside the root --
// The checkout is upstream's: a symlink in it (say an icon pointing at a file of
// yours) must not turn a rule's write into a write somewhere else. Every path a
// rule touches is resolved inside the real root, no part of it may be a
// symlink, and files are opened with O_NOFOLLOW.

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** `relative` inside `root`, or throws: absolute, `..`, or a symlink anywhere on the way. */
export function insideRoot(root, relative) {
  const base = fs.realpathSync(root);
  const full = path.resolve(base, relative);
  const rest = path.relative(base, full);
  if (!rest || rest === ".." || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)) {
    throw new Error(`${relative} is outside the checkout; refusing to touch it`);
  }
  let current = base;
  for (const part of rest.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${path.relative(base, current)} is a symlink in the checkout; refusing to follow it`);
  }
  return full;
}

const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};

function readSafe(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function writeSafe(file, content) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates `dir` (inside `root`) and its parents, refusing a symlink among those that exist. */
function mkdirInside(root, dir) {
  const relative = path.relative(fs.realpathSync(root), dir);
  if (relative) insideRoot(root, relative);
  fs.mkdirSync(dir, { recursive: true });
}

// --------------------------------------------------------------- the rules --

const globalOf = (find) => new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g");

function countMatches(source, find) {
  if (typeof find === "string") return source.split(find).length - 1;
  return [...source.matchAll(globalOf(find))].length;
}

function applyReplace(root, rule) {
  const file = insideRoot(root, rule.file);
  if (!exists(file)) throw new RuleDrift(`${rule.id}: ${rule.file} no longer exists`, { file: rule.file });
  let source = readSafe(file);
  for (const edit of rule.edits) {
    if (typeof edit.find === "string" && typeof edit.replace !== "string") {
      // split/join would write a function's source into the file.
      throw new Error(`${rule.id}: a string anchor needs a string replacement`);
    }
    const found = countMatches(source, edit.find);
    const expected = edit.count ?? 1;
    if (found !== expected) {
      const isString = typeof edit.find === "string";
      throw new RuleDrift(`${rule.id}: expected ${expected} match(es) of ${String(edit.find)} in ${rule.file}, found ${found}`, {
        file: rule.file,
        anchor: isString ? edit.find : edit.find.source,
        pattern: isString ? null : edit.find,
      });
    }
    source = typeof edit.find === "string" ? source.split(edit.find).join(edit.replace) : source.replace(globalOf(edit.find), edit.replace);
  }
  writeSafe(file, source);
}

function applyWrite(root, rule) {
  const file = insideRoot(root, rule.file);
  if (exists(file) && !rule.overwrite) {
    throw new RuleDrift(`${rule.id}: ${rule.file} already exists upstream; refusing to overwrite`, { file: rule.file });
  }
  mkdirInside(root, path.dirname(file));
  writeSafe(file, rule.content);
}

/**
 * Rewrites a file with `rule.transform(source)`, for edits whose targets depend
 * on upstream's content (e.g. catalog versions). The rule's own code is the
 * check; anything it can't handle should throw RuleDrift.
 */
function applyTransform(root, rule) {
  const file = insideRoot(root, rule.file);
  if (!exists(file)) throw new RuleDrift(`${rule.id}: ${rule.file} no longer exists`, { file: rule.file });
  writeSafe(file, rule.transform(readSafe(file)));
}

/**
 * Replaces a phrase in every matching file under `roots`. For text spread over
 * hundreds of files, where per-file anchors would drift daily; `minCount` still
 * catches upstream renaming the phrase itself. Symlinks are never followed.
 */
function applyRebrand(root, rule) {
  const files = [];
  const walk = (full) => {
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) {
        if (entry !== "node_modules" && entry !== "dist") walk(path.join(full, entry));
      }
    } else if (stat.isFile() && rule.include.test(full)) {
      files.push(full);
    }
  };
  for (const relative of rule.roots) {
    const full = insideRoot(root, relative);
    if (!exists(full)) throw new RuleDrift(`${rule.id}: ${relative} no longer exists`);
    walk(full);
  }
  let total = 0;
  for (const file of files) {
    const parts = readSafe(file).split(rule.find);
    if (parts.length === 1) continue;
    total += parts.length - 1;
    writeSafe(file, parts.join(rule.replace));
  }
  if (total < rule.minCount) {
    throw new RuleDrift(`${rule.id}: expected at least ${rule.minCount} occurrences of "${rule.find}", found ${total}`);
  }
}

const TEST_DIR = /^(node_modules|dist|build|test|tests|__tests__|fixtures|__fixtures__|testkit|testing)$|-testing$/;
const TEST_FILE = /\.(test|spec|testkit|bench|fixture)\.|\.(md|snap)$/;
// A line that is only a comment: //, /* or a JSDoc line's leading *.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Asserts that no shipped source line under `roots` (a `*` segment matches every
 * directory there) matches any of `patterns` ({ label, pattern }), after the
 * rules before it ran. Tests, fixtures and comment-only lines are skipped; each
 * hit is listed, and any stops the build. Symlinks are never followed.
 */
export function findAbsentViolations(root, rule) {
  const base = fs.realpathSync(root);
  const expand = (relative) =>
    relative.split("/").reduce(
      (paths, part) =>
        part !== "*"
          ? paths.map((p) => path.join(p, part))
          : paths.flatMap((p) =>
              exists(p) && fs.lstatSync(p).isDirectory()
                ? fs.readdirSync(p).filter((name) => !TEST_DIR.test(name)).map((name) => path.join(p, name))
                : [],
            ),
      [base],
    );
  const hits = [];
  const walk = (full) => {
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full)) if (!TEST_DIR.test(entry)) walk(path.join(full, entry));
    } else if (stat.isFile() && rule.include.test(full) && !TEST_FILE.test(path.basename(full))) {
      readSafe(full)
        .split("\n")
        .forEach((line, index) => {
          if (COMMENT_LINE.test(line)) return;
          for (const { label, pattern } of rule.patterns) {
            if (pattern.test(line)) hits.push(`${path.relative(base, full)}:${index + 1} (${label})`);
          }
        });
    }
  };
  for (const relative of rule.roots) {
    // The fixed part may not leave the checkout or pass a symlink; expanded parts are lstat'ed.
    insideRoot(root, relative.split("/*")[0]);
    const found = expand(relative).filter(exists);
    // A root upstream moved would leave nothing to check: that's drift, not a pass.
    if (!found.length) throw new RuleDrift(`${rule.id}: ${relative} no longer exists`);
    for (const full of found) walk(full);
  }
  return hits;
}

function applyAbsent(root, rule) {
  const hits = findAbsentViolations(root, rule);
  if (hits.length) {
    throw new RuleDrift(`${rule.id}: ${hits.length} line(s) still match: ${hits.slice(0, 20).join(", ")}${hits.length > 20 ? ", ..." : ""}`);
  }
}

const APPLY = { write: applyWrite, transform: applyTransform, rebrand: applyRebrand, absent: applyAbsent };

/**
 * Applies every rule; collects all drift so one run shows everything that broke,
 * as { id, message, file, anchor, pattern }. Anything else (a rule bug, a
 * symlink escape) throws.
 */
export function applyRules(root, rules) {
  const failures = [];
  for (const rule of rules) {
    try {
      (APPLY[rule.kind] ?? applyReplace)(root, rule);
      console.log(`  ✓ ${rule.id}`);
    } catch (error) {
      if (!(error instanceof RuleDrift)) throw error;
      failures.push({ id: rule.id, message: error.message, file: error.file, anchor: error.anchor, pattern: error.pattern });
      console.log(`  ✗ ${error.message}`);
    }
  }
  return failures;
}

// ------------------------------------------------------------- host scans --

/**
 * A URL's scheme and authority as written in source: everything up to the path.
 * Brackets (IPv6), `@` (userinfo), `${…}` (template parts) and any Unicode stay
 * in, so the URL parser, not this pattern, decides where it goes.
 */
const URL_LITERAL = /\b(https?|wss?):\/\/([^\s/?#"'`<>\\(),;|^]+)/gi;
const DOMAIN = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

/**
 * The host a URL literal's authority reaches, as a browser or Node would parse
 * it: lowercased, punycoded, userinfo and port dropped, IP literals normalized,
 * trailing dot removed. For a host built at runtime (`${region}.example.com`),
 * the domain written after the last expression. Null when there's no host to
 * name: a bare template, a single label like localhost, or no parseable host.
 */
export function urlHost(scheme, authority) {
  // Userinfo ends at the last @, as the URL parser reads it (`${user}@host` too).
  let host = authority.slice(authority.lastIndexOf("@") + 1);
  // A port built at runtime (`example.com:${port}`) leaves a host written in full.
  if (host.includes("${")) host = host.replace(/:(\d*|\$\{[^}]*\})$/, "");
  if (host.includes("${")) {
    // Built at runtime: only what follows the last expression is known.
    const tail = host.slice(host.lastIndexOf("}") + 1);
    if (!tail.startsWith(".") || tail.includes("${")) return null;
    host = tail.slice(1);
  }
  // An unparseable port (`https://auth.x.ai::<id>`, a credential key) still names its host.
  const parse = (authority) => {
    try {
      return new URL(`${scheme.toLowerCase()}://${authority}/`).hostname;
    } catch {
      return null;
    }
  };
  const parsed = parse(host) ?? (host.startsWith("[") ? null : parse(host.split(":")[0]));
  if (!parsed) return null;
  const name = parsed.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(name)) return name;
  return DOMAIN.test(name) ? name : null;
}

/** Every host URL literals in `text` reach, with the character index of each. */
export function hostsIn(text) {
  const found = [];
  for (const match of String(text).matchAll(URL_LITERAL)) {
    const host = urlHost(match[1], match[2]);
    if (host) found.push({ host, index: match.index });
  }
  return found;
}

/**
 * Every hostname or IP address written as a URL in the source under `dirs`
 * (relative to `root`), mapped to where it first appears. Tests, fixtures and
 * docs are skipped: they never reach the app. A symlink is read only when it
 * stays inside `root`.
 */
export function findHosts(root, dirs) {
  const hosts = new Map();
  const base = fs.realpathSync(root);
  const skipDir = /^(node_modules|dist|build|test|tests|__tests__|fixtures|__fixtures__)$|-testing$/;
  const skipFile = /\.(test|spec|testkit|bench)\.|\.(md|snap)$/;
  /** A symlinked file is read only when it resolves to a file inside the root; symlinked folders never. */
  const readableLink = (full) => {
    try {
      const real = fs.realpathSync(full);
      return real.startsWith(base + path.sep) && fs.statSync(real).isFile();
    } catch {
      return false;
    }
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink() && !readableLink(full)) continue;
      if (entry.isDirectory()) {
        if (!skipDir.test(entry.name)) walk(full);
      } else if (/\.(ts|tsx|m?js|cjs|json|html)$/.test(entry.name) && !skipFile.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const { host, index } of hostsIn(text)) {
          if (hosts.has(host)) continue;
          const line = text.slice(0, index).split("\n").length;
          hosts.set(host, `${path.relative(root, full)}:${line}`);
        }
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return hosts;
}

// ------------------------------------------------------ forbidden strings --

const CHUNK = 8 << 20;

/** ASCII-lowercases `buffer` in place (UTF-16LE ASCII too: its high bytes are zero). */
function lowerAscii(buffer, length) {
  for (let i = 0; i < length; i++) {
    const c = buffer[i];
    if (c >= 65 && c <= 90) buffer[i] = c + 32;
  }
}

/**
 * Greps built output for strings that must never ship. Runs after the build so
 * it also catches phone-homes upstream adds in places no rule knows about yet.
 *
 * Every regular file is read, whatever its type (JavaScript, ASAR archives,
 * app.asar.unpacked's node_modules, native .node modules, WASM, binaries),
 * case-insensitively, as single-byte text and as UTF-16LE. Symlinks are not
 * followed. What a literal scan can't see: a name assembled at runtime
 * ("ingest." + "t3.codes"), or anything compressed or encoded (gzip, base64
 * other than a listed needle); the smoke test's tripwire is the check for those.
 */
export function scanForbidden(dirs, forbidden) {
  const needles = forbidden.flatMap((needle) => [
    { needle, bytes: Buffer.from(needle.toLowerCase(), "latin1"), label: needle },
    { needle, bytes: Buffer.from(needle.toLowerCase(), "utf16le"), label: `${needle} (UTF-16)` },
  ]);
  const overlap = Math.max(0, ...needles.map((n) => n.bytes.length)) - 1;
  const buffer = Buffer.alloc(CHUNK + overlap);
  const hits = [];
  const scanFile = (file) => {
    const found = new Set();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      let carried = 0;
      for (let position = 0; ; ) {
        const read = fs.readSync(fd, buffer, carried, CHUNK, position);
        const length = carried + read;
        lowerAscii(buffer.subarray(carried), read);
        const window = buffer.subarray(0, length);
        for (const n of needles) if (!found.has(n.label) && window.indexOf(n.bytes) !== -1) found.add(n.label);
        if (read === 0) break;
        position += read;
        carried = Math.min(overlap, length);
        buffer.copy(buffer, 0, length - carried, length);
      }
    } finally {
      fs.closeSync(fd);
    }
    for (const label of found) hits.push(`${file}: ${label}`);
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) scanFile(full);
    }
  };
  for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
  return hits;
}
