// Injected by t3blackout as @t3tools/provider-core/server/blackoutReleaseAge.
// Provider updates and ACP Registry installs take only releases at least
// MIN_RELEASE_AGE_DAYS old, the age the build pipeline requires of every
// dependency (lib/gates.mjs), so a hijacked release has time to be caught and
// pulled before anything here installs it.
//
// The automatic provider version checks (npm's registry, Muse's) are kept on
// purpose: an accepted exception to stripping outbound calls, because the owner
// updates providers with Update all. They report only a release at least
// MIN_RELEASE_AGE_DAYS old, picked the way npm picks it (newestSettledVersion),
// and npm then installs exactly that version (maintenanceResolver.ts), so the
// app never offers a release an install would refuse. Muse's channel publishes
// no release dates, so its age counts from when this server first saw it there
// (settledSinceFirstSeen).

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const MIN_RELEASE_AGE_DAYS = 3;
/** For pnpm's minimum-release-age, which is in minutes. */
export const MIN_RELEASE_AGE_MINUTES = MIN_RELEASE_AGE_DAYS * 24 * 60;

/** The newest publish time an install accepts (npm --before, uv --exclude-newer): RFC 3339, whole seconds. */
export function releaseAgeCutoff(now: number = Date.now()): string {
  return new Date(now - MIN_RELEASE_AGE_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// SemVer as npm's semver package reads it (strict mode, https://semver.org):
// hyphens inside prerelease identifiers, build metadata (ignored in
// precedence), an optional leading "v", 256 characters at most. Its patterns
// are node-semver's own, with the same repetition bounds.

const bounded = (source: string) =>
  source
    .replaceAll("\\s*", "\\s{0,1}")
    .replaceAll("\\s+", "\\s{1,1}")
    .replaceAll("\\d*", "\\d{0,256}")
    .replaceAll("\\d+", "\\d{1,256}")
    .replaceAll("[a-zA-Z0-9-]*", "[a-zA-Z0-9-]{0,250}")
    .replaceAll("[a-zA-Z0-9-]+", "[a-zA-Z0-9-]{1,250}");
const pattern = (source: string, flags?: string) => new RegExp(bounded(source), flags);

const NUM = "0|[1-9]\\d*";
const NUM_LOOSE = "\\d+";
const WORD = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
const PRE_ID = `(?:${WORD}|${NUM})`;
const PRE_ID_LOOSE = `(?:${WORD}|${NUM_LOOSE})`;
const PRERELEASE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))`;
const PRERELEASE_LOOSE = `(?:-?(${PRE_ID_LOOSE}(?:\\.${PRE_ID_LOOSE})*))`;
const BUILD = "(?:\\+([a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*))";
const FULL_PLAIN = `v?(${NUM})\\.(${NUM})\\.(${NUM})${PRERELEASE}?${BUILD}?`;
const LOOSE_PLAIN = `[v=\\s]*(${NUM_LOOSE})\\.(${NUM_LOOSE})\\.(${NUM_LOOSE})${PRERELEASE_LOOSE}?${BUILD}?`;
const GTLT = "((?:<|>)?=?)";
const X_ID = `${NUM}|x|X|\\*`;
const X_PLAIN = `[v=\\s]*(${X_ID})(?:\\.(${X_ID})(?:\\.(${X_ID})(?:${PRERELEASE})?${BUILD}?)?)?`;

const FULL = pattern(`^${FULL_PLAIN}$`);
const COMPARATOR = pattern(`^${GTLT}\\s*(${FULL_PLAIN})$|^$`);
const BUILD_ALL = pattern(BUILD, "g");
const BUILD_FIRST = pattern(BUILD);
const HYPHEN_RANGE = pattern(`^\\s*(${X_PLAIN})\\s+-\\s+(${X_PLAIN})\\s*$`);
const COMPARATOR_TRIM = pattern(`(\\s*)${GTLT}\\s*(${LOOSE_PLAIN}|${X_PLAIN})`, "g");
const TILDE_TRIM = pattern("(\\s*)(?:~>?)\\s+", "g");
const CARET_TRIM = pattern("(\\s*)(?:\\^)\\s+", "g");
const TILDE = pattern(`^(?:~>?)${X_PLAIN}$`);
const CARET = pattern(`^(?:\\^)${X_PLAIN}$`);
const X_RANGE = pattern(`^${GTLT}\\s*${X_PLAIN}$`);
const STAR = pattern("(<|>)?=?\\s*\\*");
const GTE0_PRE = pattern("^\\s*>=\\s*0\\.0\\.0-0\\s*$");

export type SemVer = {
  readonly main: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
};

/** A version npm's semver accepts (build metadata dropped), or null. */
export function parseVersion(text: unknown): SemVer | null {
  if (typeof text !== "string" || text.length > 256) return null;
  const match = FULL.exec(text.trim());
  if (!match) return null;
  const main = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (main.some((part) => part > Number.MAX_SAFE_INTEGER)) return null;
  return { main, prerelease: match[4] ? match[4].split(".") : [] };
}

/** A version to put in an install spec: one npm accepts, written plainly (no "v", no spaces). */
export const isExactVersion = (version: string): boolean =>
  /^\d/.test(version) && version.trim() === version && parseVersion(version) !== null;

const isNumeric = (id: string) => /^\d+$/.test(id);
// Strict identifiers have no leading zeros, so a longer number is a bigger one.
const compareIdentifiers = (a: string, b: string): number =>
  isNumeric(a) && isNumeric(b)
    ? a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    : isNumeric(a) !== isNumeric(b)
      ? isNumeric(a)
        ? -1
        : 1
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;

/** SemVer precedence: negative, zero or positive. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i]! < b.main[i]! ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let i = 0; ; i++) {
    const [x, y] = [a.prerelease[i], b.prerelease[i]];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
}

const format = (v: SemVer) => `${v.main.join(".")}${v.prerelease.length ? `-${v.prerelease.join(".")}` : ""}`;
const isX = (id: string | undefined) => !id || id.toLowerCase() === "x" || id === "*";

type Comparator = { readonly operator: "" | "<" | "<=" | ">" | ">="; readonly version: SemVer | null; readonly value: string };

// node-semver's desugaring (classes/range.js), with includePrerelease, as npm checks engines.
const caret = (comp: string) =>
  comp.replace(CARET, (_, M: string, m: string, p: string, pr: string | undefined) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0-0 <${+M + 1}.0.0-0`;
    if (isX(p)) return M === "0" ? `>=${M}.${m}.0-0 <${M}.${+m + 1}.0-0` : `>=${M}.${m}.0-0 <${+M + 1}.0.0-0`;
    const low = `>=${M}.${m}.${p}${pr ? `-${pr}` : ""}`;
    if (M !== "0") return `${low} <${+M + 1}.0.0-0`;
    return m === "0" ? `${low} <${M}.${m}.${+p + 1}-0` : `${low} <${M}.${+m + 1}.0-0`;
  });
const tilde = (comp: string) =>
  comp.replace(TILDE, (_, M: string, m: string, p: string, pr: string | undefined) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
    if (isX(p)) return `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
    return `>=${M}.${m}.${p}${pr ? `-${pr}` : ""} <${M}.${+m + 1}.0-0`;
  });
const xRange = (comp: string) =>
  comp.trim().replace(X_RANGE, (whole: string, gtlt: string, M: string, m: string, p: string) => {
    if ((isX(M) && !isX(m)) || (isX(m) && p && !isX(p))) return comp.trim();
    const xm = isX(M) || isX(m);
    const anyX = xm || isX(p);
    if (gtlt === "=" && anyX) gtlt = "";
    if (isX(M)) return gtlt === ">" || gtlt === "<" ? "<0.0.0-0" : "*";
    if (gtlt && anyX) {
      let [major, minor] = [+M, xm ? 0 : +m];
      if (gtlt === ">") [gtlt, major, minor] = xm ? [">=", major + 1, 0] : [">=", major, minor + 1];
      else if (gtlt === "<=") [gtlt, major, minor] = xm ? ["<", major + 1, minor] : ["<", major, minor + 1];
      return `${gtlt}${major}.${minor}.0-0`;
    }
    if (xm) return `>=${M}.0.0-0 <${+M + 1}.0.0-0`;
    if (anyX) return `>=${M}.${m}.0-0 <${M}.${+m + 1}.0-0`;
    return whole;
  });
const hyphen = (
  _: string,
  from: string, fM: string, fm: string, fp: string, fpr: string | undefined, _fb: string | undefined,
  to: string, tM: string, tm: string, tp: string, tpr: string | undefined,
) => {
  const low = isX(fM) ? "" : isX(fm) ? `>=${fM}.0.0-0` : isX(fp) ? `>=${fM}.${fm}.0-0` : fpr ? `>=${from}` : `>=${from}-0`;
  const high = isX(tM) ? "" : isX(tm) ? `<${+tM + 1}.0.0-0` : isX(tp) ? `<${tM}.${+tm + 1}.0-0` : tpr ? `<=${tM}.${tm}.${tp}-${tpr}` : `<${tM}.${tm}.${+tp + 1}-0`;
  return `${low} ${high}`.trim();
};

function comparator(text: string): Comparator | null {
  const match = COMPARATOR.exec(text.trim().split(/\s+/).join(" "));
  if (!match) return null;
  const operator = (match[1] === "=" ? "" : (match[1] ?? "")) as Comparator["operator"];
  if (!match[2]) return { operator, version: null, value: "" };
  const version = parseVersion(match[2]);
  return version && { operator, version, value: `${operator}${format(version)}` };
}

/** One `||` alternative: its comparators, or null when node-semver would throw. */
function comparatorSet(text: string): ReadonlyArray<Comparator> | null {
  const range = text
    .replace(BUILD_ALL, "")
    .replace(HYPHEN_RANGE, hyphen as (...args: Array<string>) => string)
    .replace(COMPARATOR_TRIM, "$1$2$3")
    .replace(TILDE_TRIM, "$1~")
    .replace(CARET_TRIM, "$1^");
  const tokens = range
    .split(" ")
    .map((token) => {
      const desugared = (step: (c: string) => string, c: string) => c.trim().split(/\s+/).map(step).join(" ");
      let comp = token.replace(BUILD_FIRST, "");
      comp = desugared(caret, comp);
      comp = desugared(tilde, comp);
      comp = comp.split(/\s+/).map(xRange).join(" ");
      return comp.trim().replace(STAR, "");
    })
    .join(" ")
    .split(/\s+/)
    .map((comp) => comp.trim().replace(GTE0_PRE, ""));
  const byValue = new Map<string, Comparator>();
  for (const token of tokens) {
    const parsed = comparator(token);
    if (!parsed) return null;
    if (parsed.value === "<0.0.0-0") return [parsed];
    byValue.set(parsed.value, parsed);
  }
  if (byValue.size > 1) byValue.delete("");
  return [...byValue.values()];
}

/**
 * Whether `version` satisfies npm range `range` with prereleases included, as
 * npm checks a manifest's `engines` (npm-install-checks). Anything node-semver
 * can't read is false.
 */
export function satisfiesEngine(version: string, range: unknown): boolean {
  if (typeof range !== "string") return false;
  const sets: Array<ReadonlyArray<Comparator>> = [];
  for (const alternative of range.trim().replace(/\s+/g, " ").split("||")) {
    const set = comparatorSet(alternative.trim());
    if (!set) return false;
    sets.push(set);
  }
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return sets.some((set) =>
    set.every(({ operator, version: bound }) => {
      if (!bound) return true;
      const order = compareVersions(parsed, bound);
      return { "": order === 0, "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[operator];
    }),
  );
}

// ---------------------------------------------------------------------------

type Engines = { readonly node: string | null; readonly npm: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** npm-install-checks' checkEngine: a manifest's engines.node and engines.npm, where known. */
function engineOk(manifest: Record<string, unknown>, engines: Engines): boolean {
  const required = manifest.engines;
  if (!required) return true;
  const field = (name: string) => (typeof required === "object" ? (required as Record<string, unknown>)[name] : undefined);
  const nodeFails = engines.node && field("node") && !satisfiesEngine(engines.node, field("node"));
  const npmFails = engines.npm && field("npm") && !satisfiesEngine(engines.npm, field("npm"));
  return !(nodeFails || npmFails);
}

const sameRelease = (a: SemVer, b: SemVer) => a.main.every((part, i) => part === b.main[i]);

/**
 * What `npm install <name>@latest --before=<cutoff>` installs, read from the
 * registry's full document ({ dist-tags, versions, time }), as npm-pick-manifest
 * picks it: the latest tag once it is old enough (deprecated or not); otherwise
 * the best version before the cutoff in `<=latest` (prereleases only of the
 * tag's own release), preferring live and engine-compatible, then
 * engine-compatible, then live, then the highest. Null when nothing qualifies
 * or the document is malformed.
 *
 * `engines`: the Node and npm versions npm checks engines against. The server's
 * Node stands in for the one the provider's npm runs under; npm's own version is
 * unknown here, so engines.npm isn't checked. Unlike npm, a version with no
 * publish time is never taken (npm treats it as old enough), and a version key
 * that isn't strict SemVer is skipped (the registry only publishes strict ones).
 */
export function newestSettledVersion(
  document: unknown,
  now: number = Date.now(),
  engines: Engines = { node: typeof process === "undefined" ? null : process.version, npm: null },
): string | null {
  if (!isRecord(document)) return null;
  const { "dist-tags": tags, versions, time } = document;
  if (!isRecord(tags) || !isRecord(versions) || !isRecord(time)) return null;
  const latest = tags.latest;
  const tagged = parseVersion(latest);
  if (typeof latest !== "string" || !tagged) return null;
  const cutoff = Date.parse(releaseAgeCutoff(now));
  const settled = (version: string) => {
    const published = time[version];
    return typeof published === "string" && Date.parse(published) <= cutoff;
  };
  // npm reads a tag with no publish time as old enough; this never offers one.
  if (typeof time[latest] !== "string") return null;
  if (settled(latest)) return isRecord(versions[latest]) ? latest : null;
  const candidates = Object.keys(versions).flatMap((version) => {
    const manifest = versions[version];
    const parsed = parseVersion(version);
    if (!isRecord(manifest) || !parsed || !settled(version) || compareVersions(parsed, tagged) > 0) return [];
    if (parsed.prerelease.length > 0 && !(tagged.prerelease.length > 0 && sameRelease(parsed, tagged))) return [];
    return [{ version, parsed, live: !manifest.deprecated, fits: engineOk(manifest, engines) }];
  });
  // A stable sort, like npm's: equal precedence (build metadata) keeps the document's order.
  candidates.sort(
    (a, b) =>
      Number(b.live && b.fits) - Number(a.live && a.fits) ||
      Number(b.fits) - Number(a.fits) ||
      Number(b.live) - Number(a.live) ||
      compareVersions(b.parsed, a.parsed),
  );
  return candidates[0]?.version ?? null;
}

// ---------------------------------------------------------------------------

/** When this server first saw each channel's version: { [channel]: { version, firstSeen (epoch ms) } }. */
type FirstSeen = Record<string, { readonly version: string; readonly firstSeen: number }>;

/** A record file's entries; none when it's malformed. */
function firstSeenEntries(text: string): FirstSeen {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([channel, entry]) =>
      isRecord(entry) && typeof entry.version === "string" && typeof entry.firstSeen === "number" && Number.isFinite(entry.firstSeen)
        ? [[channel, { version: entry.version, firstSeen: entry.firstSeen }]]
        : [],
    ),
  );
}

/**
 * `version`, the version `channel` currently names, once this server has seen it
 * there for MIN_RELEASE_AGE_DAYS; null until then, for a channel (Muse's) that
 * publishes no release dates. `file` keeps when each channel's version was first
 * seen, so the wait outlasts restarts; a channel that moves to another version
 * starts that one's wait. A record that can't be read, or is dated ahead of the
 * clock, starts the wait over; one that can't be written keeps it from ending.
 */
export const settledSinceFirstSeen = Effect.fn("settledSinceFirstSeen")(function* (input: {
  readonly file: string;
  readonly channel: string;
  readonly version: string | null;
}) {
  if (input.version === null) return null;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const entries = yield* fs.readFileString(input.file).pipe(
    Effect.map(firstSeenEntries),
    Effect.orElseSucceed((): FirstSeen => ({})),
  );
  const seen = entries[input.channel];
  if (seen?.version === input.version && seen.firstSeen <= now) {
    return now - seen.firstSeen >= MIN_RELEASE_AGE_DAYS * 86_400_000 ? input.version : null;
  }
  // First seen now: written whole, then renamed over the record, so a reader never sees half.
  const next = JSON.stringify({ ...entries, [input.channel]: { version: input.version, firstSeen: now } });
  const temp = `${input.file}.tmp`;
  yield* fs.writeFileString(temp, next).pipe(Effect.andThen(fs.rename(temp, input.file)), Effect.ignore);
  return null;
});
