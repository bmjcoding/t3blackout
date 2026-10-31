// SemVer 2.0.0 parsing and precedence (https://semver.org/#spec-item-11), for npm
// versions, Node and Electron releases. Strict: a version this can't parse throws,
// so a gate never compares a malformed version as if it were older or equal.

const IDENT = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const VERSION = new RegExp(
  `^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
);

/** { major, minor, patch, prerelease: [identifiers], build } as strings, or null when `version` isn't SemVer (a leading "v" is allowed). */
export function parseVersion(version) {
  const match = VERSION.exec(String(version ?? ""));
  if (!match) return null;
  const [, major, minor, patch, pre, build = ""] = match;
  return { major, minor, patch, prerelease: pre ? pre.split(".") : [], build };
}

const mustParse = (version) => {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`${version} isn't a SemVer version`);
  return parsed;
};

const isNumeric = (id) => /^\d+$/.test(id);

/** Numeric strings without leading zeros, compared at any length. */
const compareNumbers = (a, b) => (a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0);

function compareIdentifiers(a, b) {
  const [x, y] = [isNumeric(a), isNumeric(b)];
  if (x && y) return compareNumbers(a, b);
  if (x !== y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative, zero or positive as `a` has lower, equal or higher precedence than `b`; build metadata is ignored. */
export function compareVersions(a, b) {
  const [x, y] = [mustParse(a), mustParse(b)];
  for (const part of ["major", "minor", "patch"]) {
    const order = compareNumbers(x[part], y[part]);
    if (order) return order;
  }
  if (!x.prerelease.length || !y.prerelease.length) return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    if (x.prerelease[i] === undefined) return -1;
    if (y.prerelease[i] === undefined) return 1;
    const order = compareIdentifiers(x.prerelease[i], y.prerelease[i]);
    if (order) return order;
  }
  return 0;
}

/** The compatibility line a version belongs to: its major, or for 0.x its minor ("0.35"), as npm's caret ranges treat it. */
export function lineOf(version) {
  const { major, minor } = mustParse(version);
  return major === "0" ? `0.${minor}` : major;
}

/** The first version of `version`'s line: 8.0.0, or 0.35.0. */
export function lineFloor(version) {
  const { major, minor } = mustParse(version);
  return major === "0" ? `0.${minor}.0` : `${major}.0.0`;
}

// npm's range syntax (node-semver, strict): a || b, space-separated comparators,
// hyphen ranges, ^ and ~ (and ~>), x-ranges and partial versions. Used to check that
// a version a lockfile picks for a dependency is one the dependent asks for.

const PARTIAL = /^v?(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:\.(\*|x|X|0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?)?$/;
const isWild = (part) => part === undefined || /^[*xX]$/.test(part);
const bump = (n) => String(BigInt(n) + 1n);

/** A partial version's parts: [major, minor, patch, prerelease], wildcards as null. Throws on anything else. */
function partial(text) {
  const match = PARTIAL.exec(text);
  if (!match) throw new Error(`${text} isn't a version or partial version`);
  const [, major, minor, patch, pre] = match;
  const parts = [major, minor, patch].map((part) => (isWild(part) ? null : part));
  // A wildcard swallows what follows it: 1.x.3 is 1.x.
  for (let i = 1; i < 3; i++) if (parts[i - 1] === null) parts[i] = null;
  return { major: parts[0], minor: parts[1], patch: parts[2], pre: parts[2] === null ? null : (pre ?? null) };
}

const full = ({ major, minor, patch, pre }) => `${major ?? 0}.${minor ?? 0}.${patch ?? 0}${pre ? `-${pre}` : ""}`;

/** The upper bound (exclusive, a -0 prerelease) of everything a partial matches: 1 -> 2.0.0-0, 1.2 -> 1.3.0-0. */
const pastPartial = ({ major, minor }) => (minor === null ? `${bump(major)}.0.0-0` : `${major}.${bump(minor)}.0-0`);

/** One comparator token (no spaces) as [[op, version], ...]; [] matches anything. */
function comparators(token) {
  const match = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  const [, op = "", rest] = match;
  const p = partial(rest);
  if (p.major === null) return op === "<" || op === ">" ? [["<", "0.0.0-0"]] : [];
  if (op === "^") {
    const upper = p.major !== "0" || p.minor === null ? `${bump(p.major)}.0.0-0` : p.minor !== "0" || p.patch === null ? `0.${bump(p.minor)}.0-0` : `0.0.${bump(p.patch)}-0`;
    return [[">=", full(p)], ["<", upper]];
  }
  if (op === "~" || op === "~>") return [[">=", full(p)], ["<", pastPartial(p.minor === null ? p : { major: p.major, minor: p.minor })]];
  if (p.patch === null) {
    // A partial: >1.2 is >=1.3.0, <=1.2 is <1.3.0-0, =1.2 is the whole of 1.2.x.
    if (op === ">") return [[">=", pastPartial(p).replace(/-0$/, "")]];
    if (op === "<") return [["<", `${full(p)}-0`]];
    if (op === "<=") return [["<", pastPartial(p)]];
    if (op === ">=") return [[">=", full(p)]];
    return [[">=", full(p)], ["<", pastPartial(p)]];
  }
  return [[op || "=", full(p)]];
}

/** A range as a list of comparator sets (any set may match); throws on syntax npm wouldn't accept. */
export function parseRange(range) {
  if (typeof range !== "string") throw new Error(`${range} isn't a version range`);
  return range.split("||").map((alternative) => {
    const text = alternative.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1");
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const [low, high] = [partial(hyphen[1]), partial(hyphen[2])];
      const lower = low.major === null ? [] : [[">=", full(low)]];
      const upper = high.major === null ? [] : high.patch === null ? [["<", pastPartial(high)]] : [["<=", full(high)]];
      return [...lower, ...upper];
    }
    return text ? text.split(/\s+/).flatMap(comparators) : [];
  });
}

const holds = (version, [op, bound]) => {
  const order = compareVersions(version, bound);
  return { "=": order === 0, ">": order > 0, ">=": order >= 0, "<": order < 0, "<=": order <= 0 }[op];
};

/**
 * Whether `version` satisfies npm range `range`. A prerelease only matches a set
 * with a comparator on the same major.minor.patch that has a prerelease too, as
 * npm decides. Throws when either can't be read.
 */
export function satisfies(version, range) {
  const v = mustParse(version);
  return parseRange(range).some((set) => {
    if (!set.every((comparator) => holds(version, comparator))) return false;
    if (!v.prerelease.length) return true;
    return set.some(([, bound]) => {
      const b = mustParse(bound);
      return b.prerelease.length > 0 && b.major === v.major && b.minor === v.minor && b.patch === v.patch;
    });
  });
}
