// A strict YAML reader for the subset pnpm writes (pnpm-lock.yaml) and upstream
// keeps by hand (pnpm-workspace.yaml): block and single-line flow collections,
// plain and quoted single-line scalars, explicit `? key` entries, comments and
// several documents. Anything else (anchors, aliases, tags, block scalars,
// multi-line scalars or flows, duplicate keys, bad indentation) throws YamlError
// instead of being skipped, so a gate never mistakes YAML it couldn't read for an
// empty or harmless file. Scalars keep their source offsets, for in-place edits.
// `{ blockScalars: true }` also reads `|` and `>` scalars (GitHub workflows'
// `run:` scripts), for CI's action-pin check; lockfiles never need them.

export class YamlError extends Error {}

const DOC_START = /^---(?=\s|$)/;
const DOC_END = /^\.\.\.(?=\s|$)/;

function splitLines(text) {
  const lines = [];
  let offset = text.startsWith("﻿") ? 1 : 0;
  for (const raw of text.slice(offset).split("\n")) {
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, offset });
    offset += raw.length + 1;
  }
  return lines;
}

const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " " };
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

class Parser {
  constructor(text, { blockScalars = false } = {}) {
    this.blockScalars = blockScalars;
    // With block scalars a tab can be a script's content; it fails only where it would indent structure.
    this.tabbed = new Set();
    this.lines = splitLines(text);
    this.col = this.lines.map(({ text: line }, i) => {
      const indent = /^ */.exec(line)[0].length;
      if (line[indent] === "\t" && line.slice(indent).trim() && !line.slice(indent).trim().startsWith("#")) {
        if (!blockScalars) this.fail(i, indent, "tabs can't indent YAML");
        this.tabbed.add(i);
      }
      return indent;
    });
    this.end = this.lines.length;
  }

  fail(line, col, message) {
    throw new YamlError(`line ${line + 1}, column ${col + 1}: ${message}`);
  }

  text(i) {
    return this.lines[i].text;
  }

  rest(i) {
    return this.text(i).slice(this.col[i]);
  }

  significant(i) {
    const rest = this.rest(i).trim();
    return rest !== "" && !rest.startsWith("#");
  }

  nextSignificant(i) {
    while (i < this.end && !this.significant(i)) i++;
    if (this.tabbed.has(i)) this.fail(i, this.col[i], "tabs can't indent YAML");
    return i;
  }

  offset(line, col) {
    return this.lines[line].offset + col;
  }

  scalar(text, style, line, start, end) {
    return { type: "scalar", style, text, line, start: this.offset(line, start), end: this.offset(line, end) };
  }

  /** Documents: [{ node, line }], empty ones left out. */
  documents() {
    const ranges = [];
    let start = 0;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.text(i);
      if (line.startsWith("%")) this.fail(i, 0, "directives aren't supported");
      const marker = DOC_START.test(line) ? 3 : DOC_END.test(line) ? 3 : 0;
      if (!marker) continue;
      const after = line.slice(3);
      if (after.trim() && !after.trim().startsWith("#")) this.fail(i, 3, "content on a document marker isn't supported");
      ranges.push([start, i]);
      start = i + 1;
    }
    ranges.push([start, this.lines.length]);
    const docs = [];
    for (const [from, to] of ranges) {
      this.end = to;
      const first = this.nextSignificant(from);
      if (first >= to) continue;
      const { node, next } = this.node(first);
      const extra = this.nextSignificant(next);
      if (extra < to) this.fail(extra, this.col[extra], "unexpected content after the document's root node");
      docs.push({ node, line: first });
    }
    return docs;
  }

  isSeqEntry(rest) {
    return rest === "-" || rest.startsWith("- ");
  }

  /** A block node whose content starts at this.col[i]: { node, next }. */
  node(i) {
    const c = this.col[i];
    const rest = this.rest(i);
    if (this.isSeqEntry(rest)) return this.sequence(i, c);
    if (rest === "?" || rest.startsWith("? ") || this.key(i, c)) return this.mapping(i, c);
    const { node, end } = this.inline(i, c);
    this.lineEnd(i, end);
    return { node, next: i + 1 };
  }

  /** The block value after an indicator (`key:`, `? key` then `:`) whose content may start at column `at` of line i. */
  value(i, at, indent, { compact = false } = {}) {
    const line = this.text(i);
    const p = at + /^ */.exec(line.slice(at))[0].length;
    const rest = line.slice(p);
    if (rest === "" || rest.startsWith("#")) {
      if (rest === "" && p < line.length) this.fail(i, p, "unexpected whitespace");
      const m = this.nextSignificant(i + 1);
      if (m < this.end && this.col[m] > indent) return this.node(m);
      if (m < this.end && this.col[m] === indent && this.isSeqEntry(this.rest(m))) return this.sequence(m, indent);
      return { node: this.scalar("", "empty", i, p, p), next: i + 1 };
    }
    if (p === at && at < line.length) this.fail(i, p, "a value needs a space after the colon");
    if (/^[|>]/.test(rest)) return this.blockScalar(i, p, indent);
    if (compact && (this.isSeqEntry(rest) || this.key(i, p))) {
      this.col[i] = p;
      return this.node(i);
    }
    if (this.isSeqEntry(rest)) this.fail(i, p, "a sequence can't start on its key's line");
    const { node, end } = this.inline(i, p);
    this.lineEnd(i, end);
    const m = this.nextSignificant(i + 1);
    if (m < this.end && this.col[m] > indent) this.fail(m, this.col[m], "multi-line scalars aren't supported (or the indentation is wrong)");
    return { node, next: i + 1 };
  }

  /**
   * A `|` (literal) or `>` (folded) scalar whose header is at column p of line i,
   * a value of the node at column `indent`: { node, next }. Its content is the
   * lines after the header indented as deeply as the first non-empty one, which
   * must be deeper than `indent`; an explicit indentation indicator isn't supported.
   */
  blockScalar(i, p, indent) {
    if (!this.blockScalars) this.fail(i, p, "block scalars aren't supported");
    const header = /^([|>])([+-]?)( +#.*)? *$/.exec(this.text(i).slice(p));
    if (!header) this.fail(i, p, "a block scalar header must be | or >, optionally + or -, then only a comment (indentation indicators aren't supported)");
    const [, style, chomp] = header;
    const blank = (k) => this.text(k).trim() === "";
    let k = i + 1;
    while (k < this.end && blank(k)) k++;
    const content = k < this.end && this.col[k] > indent ? this.col[k] : null;
    const lines = [];
    let last = i;
    if (content !== null) {
      for (k = i + 1; k < this.end && (blank(k) || this.col[k] >= content); k++) {
        lines.push(this.text(k).slice(content));
        last = k;
      }
    }
    // Trailing empty lines are left to chomping.
    let body = lines.length;
    while (body > 0 && lines[body - 1].trim() === "") body--;
    const kept = lines.slice(0, body);
    let text = style === "|" ? kept.join("\n") : fold(kept);
    const trailing = lines.length - body;
    if (chomp === "+") text += body ? "\n".repeat(trailing + 1) : "\n".repeat(trailing);
    else if (chomp === "" && body) text += "\n";
    const node = { type: "scalar", style: style === "|" ? "literal" : "folded", text, line: i, start: this.offset(i, p), end: this.offset(last, this.text(last).length) };
    return { node, next: last + 1 };
  }

  mapping(i, indent) {
    const entries = [];
    const seen = new Set();
    let j = i;
    for (;;) {
      j = this.nextSignificant(j);
      if (j >= this.end || this.col[j] < indent) break;
      if (this.col[j] > indent) this.fail(j, this.col[j], "bad indentation");
      const rest = this.rest(j);
      let key;
      let value;
      if (rest === "?" || rest.startsWith("? ")) {
        if (rest.trim() === "?") this.fail(j, indent, "block keys aren't supported");
        const at = indent + 1 + /^ */.exec(rest.slice(1))[0].length;
        const parsed = this.inline(j, at);
        if (parsed.node.type !== "scalar") this.fail(j, at, "only scalar keys are supported");
        this.lineEnd(j, parsed.end);
        key = parsed.node;
        const m = this.nextSignificant(j + 1);
        if (m < this.end && this.col[m] === indent && /^:(?= |$)/.test(this.rest(m))) value = this.value(m, indent + 1, indent, { compact: true });
        else value = { node: this.scalar("", "empty", j, parsed.end, parsed.end), next: j + 1 };
      } else {
        const found = this.key(j, indent);
        if (!found) this.fail(j, indent, this.isSeqEntry(rest) ? "a sequence entry where a mapping key belongs" : "expected a mapping key");
        key = found.node;
        value = this.value(j, found.after, indent);
      }
      if (seen.has(key.text)) this.fail(j, indent, `duplicate key ${key.text}`);
      seen.add(key.text);
      entries.push({ key, value: value.node });
      j = value.next;
    }
    return { node: { type: "map", entries, line: i }, next: j };
  }

  sequence(i, indent) {
    const items = [];
    let j = i;
    for (;;) {
      j = this.nextSignificant(j);
      if (j >= this.end || this.col[j] < indent) break;
      if (this.col[j] > indent) this.fail(j, this.col[j], "bad indentation");
      if (!this.isSeqEntry(this.rest(j))) break;
      const line = this.text(j);
      const p = indent + 1 + /^ */.exec(line.slice(indent + 1))[0].length;
      const after = line.slice(p);
      let item;
      if (after === "" || after.startsWith("#")) {
        const m = this.nextSignificant(j + 1);
        item = m < this.end && this.col[m] > indent ? this.node(m) : { node: this.scalar("", "empty", j, p, p), next: j + 1 };
      } else {
        if (/^[|>]/.test(after)) item = this.blockScalar(j, p, indent);
        else {
          this.col[j] = p;
          item = this.node(j);
        }
      }
      items.push(item.node);
      j = item.next;
    }
    return { node: { type: "seq", items, line: i }, next: j };
  }

  /** A block mapping key at column c of line i: { node, after } (after: the column past its colon), or null. */
  key(i, c) {
    const line = this.text(i);
    if (line[c] === '"' || line[c] === "'") {
      const { node, end } = this.quoted(i, c);
      const k = end + /^ */.exec(line.slice(end))[0].length;
      return line[k] === ":" && (k + 1 === line.length || line[k + 1] === " ") ? { node, after: k + 1 } : null;
    }
    if (!this.plainStart(line, c, false)) return null;
    for (let k = c; k < line.length; k++) {
      if (line[k] === "#" && line[k - 1] === " ") return null;
      if (line[k] === ":" && (k + 1 === line.length || line[k + 1] === " ")) {
        const text = line.slice(c, k).trimEnd();
        return { node: this.scalar(text, "plain", i, c, c + text.length), after: k + 1 };
      }
    }
    return null;
  }

  plainStart(line, c, flow) {
    const ch = line[c];
    if (ch === undefined || "#,[]{}&*!|>'\"%@`".includes(ch)) return false;
    if ("-?:".includes(ch)) {
      const next = line[c + 1];
      return next !== undefined && next !== " " && !(flow && ",[]{}".includes(next));
    }
    return true;
  }

  /** A scalar or flow collection on line i from column p: { node, end }. */
  inline(i, p, flow = false) {
    const line = this.text(i);
    const ch = line[p];
    if (ch === '"' || ch === "'") return this.quoted(i, p);
    if (ch === "{" || ch === "[") return this.flow(i, p);
    if ("&*!".includes(ch)) this.fail(i, p, "anchors, aliases and tags aren't supported");
    if (!this.plainStart(line, p, flow)) this.fail(i, p, `unexpected ${JSON.stringify(ch ?? "end of line")}`);
    let k = p;
    for (; k < line.length; k++) {
      if (line[k] === "#" && line[k - 1] === " ") break;
      if (line[k] === ":" && (k + 1 === line.length || line[k + 1] === " " || (flow && ",[]{}".includes(line[k + 1])))) {
        if (flow) break;
        this.fail(i, k, "a mapping value isn't allowed here");
      }
      if (flow && ",[]{}".includes(line[k])) break;
    }
    const text = line.slice(p, k).trimEnd();
    return { node: this.scalar(text, "plain", i, p, p + text.length), end: p + text.length };
  }

  quoted(i, p) {
    const line = this.text(i);
    const quote = line[p];
    let out = "";
    for (let k = p + 1; k < line.length; k++) {
      const ch = line[k];
      if (quote === "'") {
        if (ch !== "'") out += ch;
        else if (line[k + 1] === "'") (out += "'"), k++;
        else return { node: this.scalar(out, "single", i, p, k + 1), end: k + 1 };
        continue;
      }
      if (ch === '"') return { node: this.scalar(out, "double", i, p, k + 1), end: k + 1 };
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = line[++k];
      if (esc in ESCAPES) out += ESCAPES[esc];
      else if (esc in HEX_ESCAPES) {
        const hex = line.slice(k + 1, k + 1 + HEX_ESCAPES[esc]);
        if (!new RegExp(`^[0-9a-fA-F]{${HEX_ESCAPES[esc]}}$`).test(hex)) this.fail(i, k, "bad escape");
        out += String.fromCodePoint(parseInt(hex, 16));
        k += HEX_ESCAPES[esc];
      } else this.fail(i, k, esc === undefined ? "multi-line quoted scalars aren't supported" : `unknown escape \\${esc}`);
    }
    return this.fail(i, p, "multi-line quoted scalars aren't supported");
  }

  flow(i, p) {
    const line = this.text(i);
    const isMap = line[p] === "{";
    const close = isMap ? "}" : "]";
    const entries = [];
    const items = [];
    const seen = new Set();
    let k = p + 1;
    const skip = () => {
      while (line[k] === " ") k++;
      if (k >= line.length || (line[k] === "#" && line[k - 1] === " ")) this.fail(i, k, "multi-line flow collections aren't supported");
    };
    for (;;) {
      skip();
      if (line[k] === close) break;
      const first = this.inline(i, k, true);
      k = first.end;
      skip();
      if (isMap) {
        if (first.node.type !== "scalar") this.fail(i, k, "only scalar keys are supported");
        let value = this.scalar("", "empty", i, k, k);
        if (line[k] === ":") {
          k++;
          skip();
          if (line[k] !== "," && line[k] !== close) {
            const parsed = this.inline(i, k, true);
            value = parsed.node;
            k = parsed.end;
            skip();
          }
        }
        if (seen.has(first.node.text)) this.fail(i, k, `duplicate key ${first.node.text}`);
        seen.add(first.node.text);
        entries.push({ key: first.node, value });
      } else {
        if (line[k] === ":") this.fail(i, k, "mappings inside flow sequences aren't supported");
        items.push(first.node);
      }
      if (line[k] === ",") k++;
      else if (line[k] !== close) this.fail(i, k, `expected , or ${close}`);
    }
    return { node: isMap ? { type: "map", entries, line: i, flow: true } : { type: "seq", items, line: i, flow: true }, end: k + 1 };
  }

  lineEnd(i, end) {
    const after = this.text(i).slice(end);
    if (after && !/^ +(#.*)?$/.test(after) && !/^ *$/.test(after)) this.fail(i, end, "unexpected text after a value");
  }
}

/** A folded scalar's lines joined: a single break between plain lines is a space; empty and more-indented lines keep theirs. */
function fold(lines) {
  let out = "";
  let empty = 0;
  let previousIndented = false;
  lines.forEach((line, n) => {
    if (line.trim() === "") {
      empty++;
      return;
    }
    const indented = /^[ \t]/.test(line);
    if (n === empty) out += "\n".repeat(empty);
    else if (indented || previousIndented) out += "\n".repeat(empty + 1);
    else out += empty ? "\n".repeat(empty) : " ";
    out += line;
    empty = 0;
    previousIndented = indented;
  });
  return out;
}

/** Each document's root node: { type: "map", entries: [{ key, value }] } | { type: "seq", items } | { type: "scalar", style, text, start, end }. */
export function parseDocuments(text, opts = {}) {
  return new Parser(String(text), opts).documents().map(({ node }) => node);
}

/** A plain scalar as YAML 1.2's core schema reads it. */
function resolvePlain(text) {
  if (/^(?:~|null|Null|NULL|)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

/** A node as plain JavaScript values (keys as strings). */
export function toValue(node) {
  if (node.type === "scalar") return node.style === "empty" ? null : node.style === "plain" ? resolvePlain(node.text) : node.text;
  if (node.type === "seq") return node.items.map(toValue);
  const out = {};
  for (const { key, value } of node.entries) {
    Object.defineProperty(out, String(toValue(key)), { value: toValue(value), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Every document, as plain values. */
export const parseYaml = (text, opts = {}) => parseDocuments(text, opts).map(toValue);

/** The entry of mapping `node` whose key reads `name`, or undefined. */
export const entryOf = (node, name) => (node?.type === "map" ? node.entries.find(({ key }) => key.text === name) : undefined);
