// CVSS base scores from the vectors OSV records carry in their `severity` fields
// (https://ossf.github.io/osv-schema/#severity-field), so an advisory rated only
// by a vector still alerts at its real severity. v3.0/v3.1 and v2 follow the
// FIRST specifications' formulas; v4.0 needs FIRST's macro-vector lookup tables
// and isn't scored here (its severity is unknown unless the record states one).

const V3 = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: { N: 0.85, L: 0.62, H: 0.27 },
  UI: { N: 0.85, R: 0.62 },
  S: { U: "U", C: "C" },
  C: { H: 0.56, L: 0.22, N: 0 },
  I: { H: 0.56, L: 0.22, N: 0 },
  A: { H: 0.56, L: 0.22, N: 0 },
};
const PR_CHANGED = { N: 0.85, L: 0.68, H: 0.5 };

const V2 = {
  AV: { L: 0.395, A: 0.646, N: 1 },
  AC: { H: 0.35, M: 0.61, L: 0.71 },
  Au: { M: 0.45, S: 0.56, N: 0.704 },
  C: { N: 0, P: 0.275, C: 0.66 },
  I: { N: 0, P: 0.275, C: 0.66 },
  A: { N: 0, P: 0.275, C: 0.66 },
};

/** The vector's metrics, or null when a base metric is missing, repeated or unknown. */
function metrics(parts, table) {
  const out = Object.create(null);
  for (const part of parts) {
    const [name, value, extra] = part.split(":");
    if (extra !== undefined || value === undefined) return null;
    // Own properties only: "constructor" or "__proto__" isn't a metric or a value.
    if (!Object.hasOwn(table, name)) continue; // temporal and environmental metrics don't change the base score
    if (Object.hasOwn(out, name) || !Object.hasOwn(table[name], value)) return null;
    out[name] = value;
  }
  return Object.keys(table).every((name) => Object.hasOwn(out, name)) ? out : null;
}

/** CVSS v3.1's Roundup: the smallest one-decimal number not below `x`, without float drift. */
const roundup31 = (x) => {
  const n = Math.round(x * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
};

function scoreV3(vector) {
  const [prefix, ...parts] = vector.split("/");
  const m = metrics(parts, V3);
  if (!m) return null;
  const changed = m.S === "C";
  const iss = 1 - (1 - V3.C[m.C]) * (1 - V3.I[m.I]) * (1 - V3.A[m.A]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * V3.AV[m.AV] * V3.AC[m.AC] * (changed ? PR_CHANGED : V3.PR)[m.PR] * V3.UI[m.UI];
  if (impact <= 0) return 0;
  const raw = Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10);
  return prefix === "CVSS:3.0" ? Math.ceil(raw * 10) / 10 : roundup31(raw);
}

function scoreV2(vector) {
  const m = metrics(vector.replace(/^\(|\)$/g, "").split("/"), V2);
  if (!m) return null;
  const impact = 10.41 * (1 - (1 - V2.C[m.C]) * (1 - V2.I[m.I]) * (1 - V2.A[m.A]));
  const exploitability = 20 * V2.AV[m.AV] * V2.AC[m.AC] * V2.Au[m.Au];
  const score = (0.6 * impact + 0.4 * exploitability - 1.5) * (impact === 0 ? 0 : 1.176);
  return Math.round(Math.max(score, 0) * 10) / 10;
}

/** A CVSS base score (0 to 10) from an OSV severity entry ({ type, score }), or null when it isn't one this scores. */
export function cvssScore({ type, score } = {}) {
  const vector = String(score ?? "").trim();
  let value = null;
  if (type === "CVSS_V3" && /^CVSS:3\.[01]\//.test(vector)) value = scoreV3(vector);
  else if (type === "CVSS_V2" && !vector.startsWith("CVSS:")) value = scoreV2(vector);
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

/** LOW/MODERATE/HIGH/CRITICAL for a base score (v2 has no critical band); UNKNOWN for anything that isn't a score. */
export function scoreSeverity(score, type = "CVSS_V3") {
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) return "UNKNOWN";
  if (score >= 9 && type !== "CVSS_V2") return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MODERATE";
  return "LOW";
}
