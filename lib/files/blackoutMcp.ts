// @effect-diagnostics nodeBuiltinImport:off - Agent config files are read and swapped in with node:fs's own calls.
// Injected by t3blackout. Keeps the MCP servers set up in any installed agent
// in every installed agent, and lets Settings -> MCP Servers turn each one off,
// everywhere or for one agent. Only user-level servers: project files
// (.mcp.json and the like), plugins and hosted connectors are left alone.
//
// Each agent has an adapter that reads its config file into a common spec and
// writes a spec back in the agent's own format. <T3 home>/blackout-mcp.json
// keeps the servers' specs, the switches, a hash of every entry last seen in
// each agent (so an edit is told apart from our own write), and the entries of
// the person's own that a switch took out, so turning it back on restores them
// exactly. Agents with their own per-server off switch (Codex, Grok, OpenCode,
// Antigravity, Pi) get that flipped instead, and the entry stays put. An entry the person edits becomes theirs and its spec flows to the
// copies; one they delete is switched off for that agent; deleting the last
// one of their own deletes the server everywhere. A config file that won't
// parse (comments in a strict-JSON file, say) is never written.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { BLACKOUT_MCP_GET_STATE_CHANNEL, BLACKOUT_MCP_SET_CHANNEL } from "../channels.ts";
import {
  applyChange,
  parsePlacementPrefs,
  PlacementChange,
  PlacementItem,
  serializePlacementPrefs,
  writeJsonAtomic,
  writeTextAtomic,
} from "./blackoutPlacement.ts";
import { readTomlServers, tomlServerTable, type TomlTable, writeTomlServers } from "./blackoutMcpToml.ts";

type Strings = Record<string, string>;

export type McpSpec =
  | { readonly type: "stdio"; readonly command: string; readonly args: string[]; readonly env: Strings; readonly cwd?: string }
  | {
      readonly type: "http" | "sse";
      readonly url: string;
      readonly headers: Strings;
      /** Codex's bearer_token_env_var; other agents get an Authorization header that expands it. */
      readonly bearerTokenEnvVar?: string;
    };

/** What an adapter makes of one entry. A null spec can't be copied to other agents; `reason` says why. */
interface Parsed {
  readonly spec: McpSpec | null;
  readonly reason?: string;
  /** The agent's own off switch for it (Codex's and OpenCode's `enabled = false`). */
  readonly disabled: boolean;
}

interface Entry {
  readonly raw: unknown;
  readonly hash: string;
  readonly parsed: Parsed;
}

interface Plan {
  readonly set: Map<string, unknown>;
  readonly remove: Set<string>;
}

interface Agent {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly installed: () => Promise<boolean>;
  /** Throws when the file can't be parsed; a missing file reads as empty. */
  readonly read: () => Promise<Map<string, Entry>>;
  readonly write: (plan: Plan) => Promise<void>;
  /** The entry for a spec in this agent's format, or why it can't take it. */
  readonly encode: (name: string, spec: McpSpec) => unknown;
  /** Shown on the agent's row for every server. */
  readonly note?: string;
  /** An entry of the person's own with the agent's own off switch cleared. */
  readonly enable: (raw: unknown) => unknown;
  /** With it set, where the agent has one; otherwise switching off takes the entry out. */
  readonly disable?: (raw: unknown) => unknown;
  /** Equal for entries the agent reads the same, so our own writes aren't taken for edits. */
  readonly hash: (raw: unknown) => string;
}

class Unsupported {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const home = () => NodeOS.homedir();
const tilde = (path: string) => (path.startsWith(home()) ? `~${path.slice(home().length)}` : path);
const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

/** Key order doesn't matter to any agent, so it doesn't to the hash either. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringsOf = (value: unknown): Strings =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** A server started from a relative path only works from its own agent's folder. */
function portable(spec: McpSpec, label: string): Parsed {
  const relative = (path: string | undefined) => path !== undefined && !NodePath.isAbsolute(path) && /[\\/]/.test(path);
  if (spec.type === "stdio" && (relative(spec.command) || (spec.cwd !== undefined && !NodePath.isAbsolute(spec.cwd)))) {
    return { spec: null, reason: `Starts from a path relative to ${label}'s settings`, disabled: false };
  }
  return { spec, disabled: false };
}

function stdio(command: unknown, args: unknown, env: unknown, cwd: unknown): McpSpec | null {
  const program = text(command);
  if (!program) return null;
  const folder = text(cwd);
  return { type: "stdio", command: program, args: listOf(args), env: stringsOf(env), ...(folder ? { cwd: folder } : {}) };
}

function remote(type: "http" | "sse", url: unknown, headers: unknown): McpSpec | null {
  const address = text(url);
  return address ? { type, url: address, headers: stringsOf(headers) } : null;
}

/** Headers for agents without Codex's bearer_token_env_var, in the agent's own env-var syntax. */
const headersOf = (spec: Extract<McpSpec, { url: string }>, variable = (name: string) => `\${${name}}`) =>
  spec.bearerTokenEnvVar ? { Authorization: `Bearer ${variable(spec.bearerTokenEnvVar)}`, ...spec.headers } : spec.headers;

const omitEmpty = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) =>
        value !== undefined && !(Array.isArray(value) && value.length === 0) && !(isRecord(value) && Object.keys(value).length === 0),
    ),
  );

const noFolder = (label: string) => new Unsupported(`${label} can't start a server in a set folder`);
const noSse = (label: string) => new Unsupported(`${label} can't connect to SSE servers`);

const readText = (file: string) =>
  NodeFSP.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });

interface JsonFormat {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  /** Installed when any exists. */
  readonly homes: ReadonlyArray<string>;
  /** Where the servers object sits in the file. */
  readonly key: string;
  readonly decode: (raw: Record<string, unknown>) => McpSpec | null;
  readonly encode: (spec: McpSpec) => Record<string, unknown> | Unsupported;
  /** The entry's own off switch, where the agent has one. */
  readonly offFlag?: { readonly key: string; readonly off: unknown };
  /** A shape this adapter doesn't know (a newer config format), so the file is left alone. */
  readonly foreign?: (servers: Record<string, unknown>) => boolean;
  readonly note?: string;
}

async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  const contents = await readText(file);
  if (contents.trim() === "") return {};
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) throw new Error("not a JSON object");
  return parsed;
}

function jsonAgent(format: JsonFormat): Agent {
  const { file } = format;
  return {
    id: format.id,
    label: format.label,
    file,
    ...(format.note ? { note: format.note } : {}),
    installed: async () => (await Promise.all(format.homes.map(exists))).some(Boolean),
    read: async () => {
      const servers = (await readJsonFile(file))[format.key];
      const entries = new Map<string, Entry>();
      if (!isRecord(servers)) return entries;
      if (format.foreign?.(servers)) throw new Error("a newer format Blackout doesn't know yet");
      for (const [name, raw] of Object.entries(servers)) {
        if (!isRecord(raw)) continue;
        const spec = format.decode(raw);
        const disabled = format.offFlag !== undefined && raw[format.offFlag.key] === format.offFlag.off;
        const parsed = spec
          ? { ...portable(spec, format.label), disabled }
          : { spec: null, reason: `${format.label} uses a setup Blackout can't copy`, disabled };
        entries.set(name, { raw, hash: stable(raw), parsed });
      }
      return entries;
    },
    write: async (plan) => {
      // Read again right before writing: agents rewrite these files themselves.
      const config = await readJsonFile(file);
      const servers = isRecord(config[format.key]) ? { ...(config[format.key] as Record<string, unknown>) } : {};
      for (const name of plan.remove) delete servers[name];
      for (const [name, raw] of plan.set) servers[name] = raw;
      await writeJsonAtomic(file, { ...config, [format.key]: servers });
    },
    encode: (_name, spec) => format.encode(spec),
    enable: (raw) => {
      if (!format.offFlag || !isRecord(raw)) return raw;
      const { [format.offFlag.key]: _off, ...rest } = raw;
      return rest;
    },
    ...(format.offFlag
      ? { disable: (raw: unknown) => ({ ...(raw as Record<string, unknown>), [format.offFlag!.key]: format.offFlag!.off }) }
      : {}),
    hash: stable,
  };
}

const typedRemote = (raw: Record<string, unknown>) =>
  raw.type === "http" || raw.type === "sse" || raw.type === "streamable-http"
    ? remote(raw.type === "sse" ? "sse" : "http", raw.url, raw.headers)
    : null;

/** Codex's and Grok's config.toml, which share the [mcp_servers.<name>] tables. */
function tomlAgent(options: {
  readonly id: string;
  readonly label: string;
  readonly home: string;
  readonly headersKey: "http_headers" | "headers";
  /** Grok takes `type = "sse"`; Codex has no SSE. */
  readonly sse: boolean;
}): Agent {
  const file = NodePath.join(options.home, "config.toml");
  /** Layout and blank lines don't change what the agent reads. */
  const hash = (raw: unknown) => stable(String(raw).split("\n").map((line) => line.trim()).filter(Boolean));
  return {
    id: options.id,
    label: options.label,
    file,
    installed: () => exists(options.home),
    read: async () => {
      const entries = new Map<string, Entry>();
      for (const [name, server] of readTomlServers(await readText(file))) {
        const table = server.table;
        const spec = !table
          ? null
          : table.url !== undefined
            ? remote(options.sse && table.type === "sse" ? "sse" : "http", table.url, table[options.headersKey])
            : stdio(table.command, table.args, table.env, table.cwd);
        const withToken =
          spec && spec.type !== "stdio" && text(table?.bearer_token_env_var)
            ? { ...spec, bearerTokenEnvVar: String(table!.bearer_token_env_var) }
            : spec;
        const parsed = withToken
          ? portable(withToken, options.label)
          : { spec: null, reason: table ? `${options.label} uses a setup Blackout can't copy` : "Blackout couldn't read its settings" };
        entries.set(name, { raw: server.raw, hash: hash(server.raw), parsed: { ...parsed, disabled: table?.enabled === false } });
      }
      return entries;
    },
    write: async (plan) => {
      const current = await readText(file);
      const replaced = new Set([...plan.remove, ...plan.set.keys()]);
      await writeTextAtomic(file, writeTomlServers(current, replaced, [...plan.set.values()].map(String)));
    },
    encode: (name, spec) => {
      if (spec.type === "sse" && !options.sse) return noSse(options.label);
      const table =
        spec.type === "stdio"
          ? omitEmpty({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env })
          : omitEmpty({
              url: spec.url,
              ...(spec.type === "sse" ? { type: "sse" } : {}),
              bearer_token_env_var: spec.bearerTokenEnvVar,
              [options.headersKey]: spec.headers,
            });
      return tomlServerTable(name, table as TomlTable);
    },
    enable: (raw) =>
      String(raw)
        .split("\n")
        .filter((line) => !/^\s*enabled\s*=\s*false\s*(#.*)?$/.test(line))
        .join("\n"),
    // Right under the server's own header, before any subtable.
    disable: (raw) => {
      const [header, ...rest] = String(raw)
        .split("\n")
        .filter((line) => !/^\s*enabled\s*=/.test(line));
      return [header, "enabled = false", ...rest].join("\n");
    },
    hash,
  };
}

/**
 * Every agent Blackout keeps MCP servers in, each in its own format. An agent
 * T3 adds later needs an entry here, and its skills folder in blackoutSkills.ts.
 */
function agents(): ReadonlyArray<Agent> {
  const env = (key: string) => process.env[key]?.trim() || undefined;
  const claudeDir = env("CLAUDE_CONFIG_DIR");
  const copilotHome = env("COPILOT_HOME") ?? NodePath.join(home(), ".copilot");
  const geminiHome = NodePath.join(env("GEMINI_CLI_HOME") ?? home(), ".gemini");
  const qwenHome = env("QWEN_HOME") ?? NodePath.join(home(), ".qwen");
  const piHome = env("PI_CODING_AGENT_DIR") ?? NodePath.join(home(), ".pi", "agent");
  const openCodeDir = NodePath.join(env("XDG_CONFIG_HOME") ?? NodePath.join(home(), ".config"), "opencode");

  return [
    jsonAgent({
      id: "claude",
      label: "Claude",
      file: claudeDir ? NodePath.join(claudeDir, ".claude.json") : NodePath.join(home(), ".claude.json"),
      homes: [claudeDir ?? NodePath.join(home(), ".claude")],
      key: "mcpServers",
      decode: (raw) => typedRemote(raw) ?? stdio(raw.command, raw.args, raw.env, undefined),
      encode: (spec) =>
        spec.type === "stdio"
          ? spec.cwd
            ? noFolder("Claude")
            : omitEmpty({ type: "stdio", command: spec.command, args: spec.args, env: spec.env })
          : omitEmpty({ type: spec.type, url: spec.url, headers: headersOf(spec) }),
    }),
    tomlAgent({ id: "codex", label: "Codex", home: env("CODEX_HOME") ?? NodePath.join(home(), ".codex"), headersKey: "http_headers", sse: false }),
    jsonAgent({
      id: "copilot",
      label: "Copilot",
      file: NodePath.join(copilotHome, "mcp-config.json"),
      homes: [copilotHome],
      key: "mcpServers",
      decode: (raw) => typedRemote(raw) ?? stdio(raw.command, raw.args, raw.env, raw.cwd),
      encode: (spec) =>
        spec.type === "stdio"
          ? spec.cwd
            ? noFolder("Copilot")
            : omitEmpty({ type: "local", command: spec.command, args: spec.args, env: spec.env, tools: ["*"] })
          : omitEmpty({ type: spec.type, url: spec.url, headers: headersOf(spec), tools: ["*"] }),
    }),
    jsonAgent({
      id: "cursor",
      label: "Cursor",
      file: NodePath.join(home(), ".cursor", "mcp.json"),
      homes: [NodePath.join(home(), ".cursor")],
      key: "mcpServers",
      // Cursor tells HTTP from SSE itself.
      decode: (raw) => (raw.url !== undefined ? remote("http", raw.url, raw.headers) : stdio(raw.command, raw.args, raw.env, undefined)),
      encode: (spec) =>
        spec.type === "stdio"
          ? spec.cwd
            ? noFolder("Cursor")
            : omitEmpty({ type: "stdio", command: spec.command, args: spec.args, env: spec.env })
          : omitEmpty({ url: spec.url, headers: headersOf(spec, (name) => `\${env:${name}}`) }),
    }),
    jsonAgent({
      id: "antigravity",
      label: "Antigravity",
      file: NodePath.join(home(), ".gemini", "config", "mcp_config.json"),
      // Upstream keeps MCP servers out of the profile T3 runs Antigravity in
      // (docs/internals/providers.md): its text generation refuses profiles with them.
      note: "Used when you run Antigravity yourself. T3 keeps MCP servers out of its Antigravity sessions by design.",
      homes: [NodePath.join(home(), ".gemini", "config"), NodePath.join(home(), ".gemini", "antigravity-cli")],
      key: "mcpServers",
      offFlag: { key: "disabled", off: true },
      decode: (raw) =>
        raw.serverUrl !== undefined ? remote("http", raw.serverUrl, raw.headers) : stdio(raw.command, raw.args, raw.env, raw.cwd),
      encode: (spec) =>
        spec.type === "stdio"
          ? omitEmpty({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd })
          : spec.type === "sse"
            ? noSse("Antigravity")
            : omitEmpty({ serverUrl: spec.url, headers: headersOf(spec) }),
    }),
    jsonAgent({
      id: "gemini",
      label: "Gemini CLI",
      file: NodePath.join(geminiHome, "settings.json"),
      // ~/.gemini alone is Antigravity's too; Gemini CLI writes settings.json.
      homes: [NodePath.join(geminiHome, "settings.json")],
      key: "mcpServers",
      decode: (raw) =>
        raw.httpUrl !== undefined
          ? remote("http", raw.httpUrl, raw.headers)
          : raw.url !== undefined
            ? remote(raw.type === "sse" ? "sse" : "http", raw.url, raw.headers)
            : stdio(raw.command, raw.args, raw.env, raw.cwd),
      encode: (spec) =>
        spec.type === "stdio"
          ? omitEmpty({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd })
          : omitEmpty({ type: spec.type, url: spec.url, headers: headersOf(spec) }),
    }),
    jsonAgent({
      id: "qwen",
      label: "Qwen Code",
      file: NodePath.join(qwenHome, "settings.json"),
      homes: [qwenHome],
      key: "mcpServers",
      // Qwen reads a bare url as SSE.
      decode: (raw) =>
        raw.httpUrl !== undefined
          ? remote("http", raw.httpUrl, raw.headers)
          : raw.url !== undefined
            ? remote("sse", raw.url, raw.headers)
            : stdio(raw.command, raw.args, raw.env, raw.cwd),
      encode: (spec) =>
        spec.type === "stdio"
          ? omitEmpty({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd })
          : omitEmpty({ [spec.type === "http" ? "httpUrl" : "url"]: spec.url, headers: headersOf(spec) }),
    }),
    jsonAgent({
      id: "opencode",
      label: "OpenCode",
      file: NodePath.join(openCodeDir, "opencode.json"),
      homes: [openCodeDir],
      key: "mcp",
      offFlag: { key: "enabled", off: false },
      // OpenCode's next release moves servers under mcp.servers.
      foreign: (servers) => isRecord(servers.servers) && servers.servers.type === undefined,
      decode: (raw) => {
        if (raw.type === "remote") return remote("http", raw.url, raw.headers);
        const command = listOf(raw.command);
        return stdio(command[0], command.slice(1), raw.environment, raw.cwd);
      },
      encode: (spec) =>
        spec.type === "stdio"
          ? omitEmpty({ type: "local", command: [spec.command, ...spec.args], environment: spec.env, cwd: spec.cwd })
          : omitEmpty({ type: "remote", url: spec.url, headers: headersOf(spec, (name) => `{env:${name}}`) }),
    }),
    jsonAgent({
      id: "pi",
      label: "Pi",
      file: NodePath.join(piHome, "mcp.json"),
      homes: [piHome],
      key: "mcpServers",
      offFlag: { key: "enabled", off: false },
      decode: (raw) => (raw.url !== undefined ? remote("http", raw.url, raw.headers) : stdio(raw.command, raw.args, raw.env, raw.cwd)),
      encode: (spec) =>
        spec.type === "stdio"
          ? omitEmpty({ command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd })
          : spec.type === "sse"
            ? noSse("Pi")
            : omitEmpty({ type: "http", url: spec.url, headers: headersOf(spec) }),
    }),
    tomlAgent({ id: "grok", label: "Grok", home: env("GROK_HOME") ?? NodePath.join(home(), ".grok"), headersKey: "headers", sse: true }),
    jsonAgent({
      id: "junie",
      label: "Junie",
      file: NodePath.join(home(), ".junie", "mcp", "mcp.json"),
      homes: [NodePath.join(home(), ".junie")],
      key: "mcpServers",
      decode: (raw) => (raw.url !== undefined ? remote("http", raw.url, raw.headers) : stdio(raw.command, raw.args, raw.env, undefined)),
      encode: (spec) =>
        spec.type === "stdio"
          ? spec.cwd
            ? noFolder("Junie")
            : omitEmpty({ command: spec.command, args: spec.args, env: spec.env })
          : spec.type === "sse"
            ? noSse("Junie")
            : omitEmpty({ url: spec.url, headers: headersOf(spec) }),
    }),
  ];
}

interface Server {
  spec: McpSpec | null;
  reason?: string;
  /** The agent it was first found in. */
  origin: string;
}

interface Registry {
  servers: Record<string, Server>;
  /** Agent to entry name to the hash last seen, and whether we wrote it. */
  seen: Record<string, Record<string, { hash: string; ours: boolean }>>;
  /** Agent to entry name to the person's own entry a switch took out. */
  stashed: Record<string, Record<string, unknown>>;
  disabled: string[];
  excluded: Record<string, string[]>;
}

const t3Home = () => process.env.T3CODE_HOME?.trim() || NodePath.join(home(), ".t3blackout");
const registryFile = () => NodePath.join(t3Home(), "blackout-mcp.json");

async function readRegistry(): Promise<Registry> {
  const empty: Registry = { servers: {}, seen: {}, stashed: {}, disabled: [], excluded: {} };
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(registryFile(), "utf8"));
    return isRecord(parsed) ? { ...empty, ...(parsed as Partial<Registry>) } : empty;
  } catch {
    return empty;
  }
}

const McpState = Schema.Struct({
  servers: Schema.Array(PlacementItem),
  /** Config files that couldn't be read, and so aren't touched. */
  problems: Schema.Array(Schema.String),
});
type McpState = typeof McpState.Type;

function summary(server: Server): string {
  const spec = server.spec;
  if (!spec) return server.reason ?? "Can't be copied to other agents";
  if (spec.type !== "stdio") return `${spec.type} · ${spec.url}`;
  return `stdio · ${[NodePath.basename(spec.command), ...spec.args].join(" ")}`;
}

async function reconcile(): Promise<McpState> {
  const registry = await readRegistry();
  const prefs = parsePlacementPrefs(registry);
  const problems: string[] = [];
  const live: Array<{ agent: Agent; entries: Map<string, Entry> }> = [];
  const unreadable = new Map<string, string>();

  for (const agent of agents()) {
    if (!(await agent.installed())) continue;
    try {
      live.push({ agent, entries: await agent.read() });
    } catch (error) {
      const reason = `Couldn't read ${tilde(agent.file)} (${error instanceof Error ? error.message : String(error)}), so Blackout leaves it alone`;
      unreadable.set(agent.id, reason);
      problems.push(reason);
    }
  }

  const exclude = (name: string, agent: string, off: boolean) => {
    const agents = prefs.excluded.get(name) ?? new Set<string>();
    if (off) agents.add(agent);
    else agents.delete(agent);
    prefs.excluded.set(name, agents);
  };
  const forget = (name: string) => {
    delete registry.servers[name];
    prefs.disabled.delete(name);
    prefs.excluded.delete(name);
    for (const stash of Object.values(registry.stashed)) delete stash[name];
  };

  // 1. Take in what changed in each agent since we last looked.
  for (const { agent, entries } of live) {
    const seen = (registry.seen[agent.id] ??= {});
    for (const [name, last] of Object.entries(seen)) {
      if (entries.has(name)) continue;
      delete seen[name];
      const theirsElsewhere = live.some(
        (other) => other.agent.id !== agent.id && other.entries.has(name) && !registry.seen[other.agent.id]?.[name]?.ours,
      );
      if (!last.ours && !theirsElsewhere && registry.stashed[agent.id]?.[name] === undefined) forget(name);
      else exclude(name, agent.id, true);
    }
    for (const [name, entry] of entries) {
      if (seen[name]?.hash === entry.hash) continue;
      seen[name] = { hash: entry.hash, ours: false };
      delete registry.stashed[agent.id]?.[name];
      const known = registry.servers[name];
      if (!known) {
        registry.servers[name] = {
          spec: entry.parsed.spec,
          ...(entry.parsed.reason ? { reason: entry.parsed.reason } : {}),
          origin: agent.id,
        };
        if (entry.parsed.disabled) prefs.disabled.add(name);
      } else {
        if (entry.parsed.spec) {
          known.spec = entry.parsed.spec;
          delete known.reason;
        }
        exclude(name, agent.id, entry.parsed.disabled);
      }
    }
  }

  // 2. Write each agent's entries to match the servers and the switches.
  const blocked = new Map<string, Map<string, string>>();
  const block = (name: string, agent: string, reason: string) =>
    blocked.set(name, (blocked.get(name) ?? new Map()).set(agent, reason));

  for (const { agent, entries } of live) {
    const seen = registry.seen[agent.id]!;
    const stash = (registry.stashed[agent.id] ??= {});
    const before = structuredClone({ seen, stash });
    const plan: Plan = { set: new Map(), remove: new Set() };
    const put = (name: string, raw: unknown, ours: boolean) => {
      plan.set.set(name, raw);
      seen[name] = { hash: agent.hash(raw), ours };
    };

    for (const name of new Set([...Object.keys(registry.servers), ...entries.keys()])) {
      const server = registry.servers[name];
      const current = entries.get(name);
      const ours = seen[name]?.ours === true;
      if (!server) {
        if (current && ours) {
          plan.remove.add(name);
          delete seen[name];
        }
        continue;
      }
      const wanted = !prefs.disabled.has(name) && !prefs.excluded.get(name)?.has(agent.id);
      if (!wanted) {
        // Off through the agent's own switch where it has one, so the entry (and
        // any app that manages it) stays put.
        if (current && !ours && current.parsed.disabled) continue;
        if (current && !ours && agent.disable) {
          put(name, agent.disable(current.raw), false);
          continue;
        }
        if (current) {
          if (!ours) stash[name] = current.raw;
          plan.remove.add(name);
          delete seen[name];
        }
        continue;
      }
      if (current && !ours) {
        if (current.parsed.disabled) put(name, agent.enable(current.raw), false);
        continue;
      }
      if (stash[name] !== undefined) {
        put(name, agent.enable(stash[name]), false);
        delete stash[name];
        continue;
      }
      if (!server.spec) {
        if (!current) block(name, agent.id, server.reason ?? "Can't be copied here");
        continue;
      }
      const raw = agent.encode(name, server.spec);
      if (raw instanceof Unsupported) {
        block(name, agent.id, raw.reason);
        if (current) {
          plan.remove.add(name);
          delete seen[name];
        }
        continue;
      }
      if (!current || current.hash !== agent.hash(raw)) put(name, raw, true);
    }

    if (plan.set.size === 0 && plan.remove.size === 0) continue;
    try {
      await agent.write(plan);
    } catch (error) {
      // Nothing landed, so nothing changed for this agent.
      registry.seen[agent.id] = before.seen;
      registry.stashed[agent.id] = before.stash;
      problems.push(`Couldn't update ${tilde(agent.file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await writeJsonAtomic(registryFile(), { ...registry, ...serializePlacementPrefs(prefs) });

  const shown = live.map(({ agent }) => agent);
  return {
    servers: Object.keys(registry.servers)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const server = registry.servers[name]!;
        return {
          name,
          description: summary(server),
          enabled: !prefs.disabled.has(name),
          agents: [
            ...shown.map((agent) => {
              const reason = blocked.get(name)?.get(agent.id);
              return {
                id: agent.id,
                label: agent.label,
                detail: tilde(agent.file),
                on: !prefs.excluded.get(name)?.has(agent.id),
                ...(reason ? { blocked: reason } : {}),
                ...(agent.note ? { note: agent.note } : {}),
              };
            }),
            ...[...unreadable].map(([id, reason]) => ({
              id,
              label: agents().find((agent) => agent.id === id)?.label ?? id,
              detail: reason,
              on: false,
              blocked: "Its settings file couldn't be read",
            })),
          ],
        };
      }),
    problems,
  };
}

// Launch, toggles and Settings reads all touch the same files; one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export class BlackoutMcpError extends Data.TaggedError("BlackoutMcpError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not update MCP servers: ${String(this.cause)}`;
  }
}

const run = <A>(task: () => Promise<A>) =>
  Effect.tryPromise({
    try: () => serial(task),
    catch: (cause) => new BlackoutMcpError({ cause }),
  });

export const installBlackoutMcp = Effect.fn("desktop.ipc.installBlackoutMcp")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  void serial(reconcile).catch((error: unknown) => {
    Effect.runSync(Effect.logWarning("Could not sync MCP servers", error));
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BLACKOUT_MCP_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: McpState,
      // Reconciling on read also picks up a server added, or an agent installed, since launch.
      handler: () => run(reconcile),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BLACKOUT_MCP_SET_CHANNEL,
      payload: PlacementChange,
      result: McpState,
      handler: (change) =>
        run(async () => {
          const registry = await readRegistry();
          await writeJsonAtomic(registryFile(), { ...registry, ...applyChange(parsePlacementPrefs(registry), change) });
          return reconcile();
        }),
    }),
  );
});
