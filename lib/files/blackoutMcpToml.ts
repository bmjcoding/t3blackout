// Injected by t3blackout. Codex keeps MCP servers in config.toml, and no TOML
// library ships with the desktop app, so this reads and writes only the
// [mcp_servers.<name>] tables (and their subtables) and leaves every other
// byte of the file alone. It parses the values TOML allows there: strings of
// all four kinds, numbers, booleans, dates (kept as text), arrays and inline
// tables. Anything else throws, and the caller leaves that server alone.

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

const HEADER = /^\s*\[(?!\[)(.+?)\]\s*(?:#.*)?$/;

class Reader {
  index = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  /** A method rather than a getter, so TypeScript doesn't narrow it across moves. */
  private char(): string | undefined {
    return this.text[this.index];
  }

  private fail(what: string): never {
    throw new Error(`TOML: ${what} at offset ${this.index}`);
  }

  private spaces() {
    while (this.char() === " " || this.char() === "\t") this.index++;
  }

  /** Spaces, newlines and comments. */
  private gaps() {
    for (;;) {
      this.spaces();
      if (this.char() === "#") while (this.char() !== undefined && this.char() !== "\n") this.index++;
      if (this.char() === "\n" || this.char() === "\r") this.index++;
      else return;
    }
  }

  private take(literal: string) {
    if (!this.text.startsWith(literal, this.index)) return false;
    this.index += literal.length;
    return true;
  }

  private basic(multiline: boolean): string {
    const close = multiline ? '"""' : '"';
    if (multiline && this.char() === "\n") this.index++;
    else if (multiline && this.text.startsWith("\r\n", this.index)) this.index += 2;
    let out = "";
    for (;;) {
      if (this.char() === undefined) this.fail("unterminated string");
      if (this.take(close)) return out;
      const char = this.char()!;
      if (!multiline && char === "\n") this.fail("newline in string");
      this.index++;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const escape = this.char();
      this.index++;
      const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\u001b" };
      if (escape !== undefined && escape in simple) out += simple[escape];
      else if (escape === "u" || escape === "U") {
        const length = escape === "u" ? 4 : 8;
        const hex = this.text.slice(this.index, this.index + length);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) this.fail("bad unicode escape");
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        this.index += length;
      } else if (multiline && (escape === "\n" || escape === "\r" || escape === " " || escape === "\t")) {
        // A line-ending backslash trims the newline and the whitespace after it.
        while (/\s/.test(this.char() ?? "")) this.index++;
      } else this.fail("bad escape");
    }
  }

  private literal(multiline: boolean): string {
    const close = multiline ? "'''" : "'";
    if (multiline && this.char() === "\n") this.index++;
    else if (multiline && this.text.startsWith("\r\n", this.index)) this.index += 2;
    const end = this.text.indexOf(close, this.index);
    if (end < 0) this.fail("unterminated string");
    const out = this.text.slice(this.index, end);
    if (!multiline && out.includes("\n")) this.fail("newline in string");
    this.index = end + close.length;
    return out;
  }

  keyPart(): string {
    if (this.take('"')) return this.basic(false);
    if (this.take("'")) return this.literal(false);
    const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.index));
    if (!match) this.fail("expected a key");
    this.index += match[0].length;
    return match[0];
  }

  key(): string[] {
    const parts = [this.keyPart()];
    for (;;) {
      this.spaces();
      if (!this.take(".")) return parts;
      this.spaces();
      parts.push(this.keyPart());
    }
  }

  value(): TomlValue {
    if (this.take('"""')) return this.basic(true);
    if (this.take('"')) return this.basic(false);
    if (this.take("'''")) return this.literal(true);
    if (this.take("'")) return this.literal(false);
    if (this.take("[")) {
      const items: TomlValue[] = [];
      for (;;) {
        this.gaps();
        if (this.take("]")) return items;
        items.push(this.value());
        this.gaps();
        if (!this.take(",") && this.char() !== "]") this.fail("expected , or ]");
      }
    }
    if (this.take("{")) {
      const table: TomlTable = {};
      this.spaces();
      if (this.take("}")) return table;
      for (;;) {
        this.spaces();
        const key = this.key();
        this.spaces();
        if (!this.take("=")) this.fail("expected =");
        this.spaces();
        assign(table, key, this.value());
        this.spaces();
        if (this.take("}")) return table;
        if (!this.take(",")) this.fail("expected , or }");
      }
    }
    if (this.take("true")) return true;
    if (this.take("false")) return false;
    const match = /^[+-]?[0-9A-Za-z_.:+-]+(?: [0-9][0-9:.+-Z]*)?/.exec(this.text.slice(this.index));
    if (!match) this.fail("expected a value");
    this.index += match[0].length;
    const number = Number(match[0].replace(/_/g, ""));
    return Number.isFinite(number) ? number : match[0];
  }

  /** `key = value` lines up to the end of the text. */
  body(): TomlTable {
    const table: TomlTable = {};
    for (;;) {
      this.gaps();
      if (this.char() === undefined) return table;
      const key = this.key();
      this.spaces();
      if (!this.take("=")) this.fail("expected =");
      this.spaces();
      assign(table, key, this.value());
      this.spaces();
      if (this.char() === "#") while (this.char() !== undefined && this.char() !== "\n") this.index++;
      if (this.char() !== undefined && this.char() !== "\n" && this.char() !== "\r") this.fail("expected end of line");
    }
  }
}

function assign(table: TomlTable, key: ReadonlyArray<string>, value: TomlValue) {
  let at = table;
  for (const part of key.slice(0, -1)) {
    const next = at[part];
    if (next === undefined) at = at[part] = {};
    else if (typeof next === "object" && !Array.isArray(next)) at = next;
    else throw new Error(`TOML: ${key.join(".")} is defined twice`);
  }
  at[key[key.length - 1]!] = value;
}

interface Section {
  readonly path: ReadonlyArray<string>;
  /** Line indexes, end exclusive; the header line included. */
  readonly start: number;
  readonly end: number;
}

function sections(lines: ReadonlyArray<string>): Section[] {
  const found: Array<{ path: string[]; start: number }> = [];
  lines.forEach((line, index) => {
    const header = HEADER.exec(line);
    if (!header) return;
    try {
      found.push({ path: new Reader(header[1]!).key(), start: index });
    } catch {
      // A header we can't read isn't one of ours.
    }
  });
  return found.map((section, index) => ({ ...section, end: found[index + 1]?.start ?? lines.length }));
}

const isServerSection = (section: Section, name?: string) =>
  section.path[0] === "mcp_servers" && section.path.length >= 2 && (name === undefined || section.path[1] === name);

export interface TomlServer {
  /** Its tables as written, header lines included. */
  readonly raw: string;
  /** Null when its values couldn't be read. */
  readonly table: TomlTable | null;
}

/** Every [mcp_servers.<name>] in the file, with its subtables. */
export function readTomlServers(text: string): Map<string, TomlServer> {
  const lines = text.split("\n");
  const byName = new Map<string, Section[]>();
  for (const section of sections(lines)) {
    if (!isServerSection(section)) continue;
    const name = section.path[1]!;
    byName.set(name, [...(byName.get(name) ?? []), section]);
  }
  const servers = new Map<string, TomlServer>();
  for (const [name, list] of byName) {
    const raw = list.map((section) => lines.slice(section.start, section.end).join("\n").trimEnd()).join("\n");
    let table: TomlTable | null = {};
    try {
      for (const section of list) {
        const body = new Reader(lines.slice(section.start + 1, section.end).join("\n")).body();
        const sub = section.path.slice(2);
        if (sub.length === 0) Object.assign(table, body);
        else assign(table, sub, body);
      }
    } catch {
      table = null;
    }
    servers.set(name, { raw, table });
  }
  return servers;
}

/** Removes the named servers' tables and appends the given ones, leaving the rest of the file as it was. */
export function writeTomlServers(
  text: string,
  remove: ReadonlySet<string>,
  append: ReadonlyArray<string>,
): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const section of sections(lines)) {
    if (!isServerSection(section) || !remove.has(section.path[1]!)) continue;
    // Keep the comments and blank lines that lead into the next table.
    let end = section.end;
    while (end > section.start + 1 && /^\s*(#.*)?$/.test(lines[end - 1]!) && end !== lines.length) end--;
    for (let index = section.start; index < end; index++) drop.add(index);
  }
  let out = lines.filter((_, index) => !drop.has(index)).join("\n").replace(/\n{3,}/g, "\n\n");
  if (append.length > 0) out = `${out.trimEnd()}\n\n${append.join("\n\n")}\n`;
  return out;
}

const bareKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** JSON string escapes are valid TOML basic-string escapes. */
const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return `{ ${Object.entries(value)
    .map(([key, entry]) => `${bareKey(key)} = ${tomlValue(entry)}`)
    .join(", ")} }`;
};

/** One [mcp_servers.<name>] table; nested tables are written inline. */
export function tomlServerTable(name: string, table: TomlTable): string {
  const lines = [`[mcp_servers.${bareKey(name)}]`];
  for (const [key, value] of Object.entries(table)) lines.push(`${bareKey(key)} = ${tomlValue(value)}`);
  return lines.join("\n");
}

export type { TomlTable, TomlValue };
