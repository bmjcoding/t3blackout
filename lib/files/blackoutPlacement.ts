// @effect-diagnostics nodeBuiltinImport:off - Preferences are small JSON files written with node:fs's own calls.
// Injected by t3blackout. What Settings -> Skills and Settings -> MCP Servers
// share: an item (a skill or an MCP server) is on or off for every installed
// agent, and can be switched off for single agents. Off for an agent is saved
// as an exclusion, so an agent installed later gets everything that's on.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export const PlacementAgent = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** The folder or config file it's written to. */
  detail: Schema.String,
  on: Schema.Boolean,
  /** Why it can't be placed for this agent; its switch is disabled. */
  blocked: Schema.optional(Schema.String),
  /** Something to know about this agent that doesn't stop it. */
  note: Schema.optional(Schema.String),
});

export const PlacementItem = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  agents: Schema.Array(PlacementAgent),
});
export type PlacementItem = typeof PlacementItem.Type;

export const PlacementChange = Schema.Struct({
  name: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  agent: Schema.optional(Schema.Struct({ id: Schema.String, on: Schema.Boolean })),
});
export type PlacementChange = typeof PlacementChange.Type;

export interface PlacementPrefs {
  readonly disabled: Set<string>;
  /** Item name to the agents it's switched off for. */
  readonly excluded: Map<string, Set<string>>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function parsePlacementPrefs(parsed: unknown): PlacementPrefs {
  const record = (parsed ?? {}) as { disabled?: unknown; excluded?: unknown };
  const excluded = new Map<string, Set<string>>();
  if (record.excluded && typeof record.excluded === "object") {
    for (const [name, agents] of Object.entries(record.excluded)) {
      const set = new Set(strings(agents));
      if (set.size > 0) excluded.set(name, set);
    }
  }
  return { disabled: new Set(strings(record.disabled)), excluded };
}

export const serializePlacementPrefs = (prefs: PlacementPrefs) => ({
  disabled: [...prefs.disabled].sort(),
  excluded: Object.fromEntries(
    [...prefs.excluded]
      .filter(([, agents]) => agents.size > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, agents]) => [name, [...agents].sort()]),
  ),
});

export async function readPlacementPrefs(file: string): Promise<PlacementPrefs> {
  try {
    return parsePlacementPrefs(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  } catch {
    return parsePlacementPrefs(null);
  }
}

/** The main switch keeps the per-agent choices, so turning an item back on restores them. */
export function applyChange(prefs: PlacementPrefs, change: PlacementChange) {
  if (change.enabled === true) prefs.disabled.delete(change.name);
  if (change.enabled === false) prefs.disabled.add(change.name);
  if (change.agent) {
    const agents = prefs.excluded.get(change.name) ?? new Set<string>();
    if (change.agent.on) agents.delete(change.agent.id);
    else agents.add(change.agent.id);
    prefs.excluded.set(change.name, agents);
  }
  return serializePlacementPrefs(prefs);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

/** Swaps the file in whole, keeping its mode, so a reader never sees half of it. A symlinked file (dotfiles) is written through. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const file = await NodeFSP.realpath(path).catch(() => path);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const mode = await NodeFSP.stat(file).then(
    (stat) => stat.mode & 0o777,
    () => 0o644,
  );
  const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  await NodeFSP.writeFile(temporary, text, { mode });
  await NodeFSP.rename(temporary, file);
}
