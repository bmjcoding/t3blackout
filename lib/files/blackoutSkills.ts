// @effect-diagnostics nodeBuiltinImport:off - Placement builds folders and symlinks with node:fs's own calls.
// Injected by t3blackout. Puts every skill on this machine in front of every
// installed agent harness, and lets Settings -> Skills turn each one off,
// everywhere or for one harness.
//
// Two libraries feed the harnesses: <T3 home>/skills holds the skills in the
// repo's skills/ folder, rewritten on launch from the copy baked into this
// build (blackoutSkills.generated.ts); <T3 home>/my-skills holds the person's
// own. A skill found in any harness's skills folder is moved into my-skills
// (adopted) and replaced by a link, so it reaches the other harnesses too.
// Same-named copies elsewhere are moved to <T3 home>/skills-replaced rather
// than deleted. Every installed harness gets a symlink per enabled skill in the
// folder it reads skills from; the CLIs and T3's own skill scanners follow the
// link (verified for Claude Code and Codex).
//
// A link that resolves into one of the two libraries is ours: we add, replace
// and remove only those. A skill of the person's own named like a shipped one
// stays where it is and takes that harness's spot; Settings shows the shipped
// one as blocked there. A harness counts as installed when its home folder
// exists; we create only the skills/ folder inside it.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BLACKOUT_SKILLS } from "../../blackoutSkills.generated.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  BLACKOUT_SKILLS_GET_STATE_CHANNEL,
  BLACKOUT_SKILLS_SET_ENABLED_CHANNEL,
} from "../channels.ts";
import {
  applyChange,
  PlacementChange,
  PlacementItem,
  readPlacementPrefs,
  writeJsonAtomic,
} from "./blackoutPlacement.ts";

interface Harness {
  /** Stable; saved in the preferences. */
  readonly id: string;
  readonly label: string;
  readonly skillsDir: string;
  /** Linked when any of these exists. */
  readonly homes: ReadonlyArray<string>;
}

interface Member {
  readonly label: string;
  readonly home: string;
}

const home = () => NodeOS.homedir();
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(home(), ".claude");
const codexHome = () => process.env.CODEX_HOME?.trim() || NodePath.join(home(), ".codex");
const configHome = () => process.env.XDG_CONFIG_HOME?.trim() || NodePath.join(home(), ".config");
const piHome = () => process.env.PI_CODING_AGENT_DIR?.trim() || NodePath.join(home(), ".pi", "agent");

/** Agents that read the shared ~/.agents/skills folder, and their own folder for skills (adopted from). */
function sharedMembers(): ReadonlyArray<Member & { readonly ownSkills: string }> {
  const at = (label: string, dir: string) => ({ label, home: dir, ownSkills: NodePath.join(dir, "skills") });
  return [
    at("Codex", codexHome()),
    at("Cursor", NodePath.join(home(), ".cursor")),
    at("OpenCode", NodePath.join(configHome(), "opencode")),
    at("Pi", piHome()),
    at("Copilot", NodePath.join(home(), ".copilot")),
    at("Gemini CLI", NodePath.join(home(), ".gemini")),
    at("Goose", NodePath.join(configHome(), "goose")),
    at("Augment", NodePath.join(home(), ".augment")),
    at("Devin", NodePath.join(configHome(), "devin")),
  ];
}

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

async function installedMembers(): Promise<ReadonlyArray<string>> {
  const members = sharedMembers();
  const present = await Promise.all(members.map((member) => exists(member.home)));
  return members.filter((_, index) => present[index]).map((member) => member.label);
}

function harnesses(shared: ReadonlyArray<string>): ReadonlyArray<Harness> {
  const own = (id: string, label: string, dir: string) => ({
    id,
    label,
    skillsDir: NodePath.join(home(), dir, "skills"),
    homes: [NodePath.join(home(), dir)],
  });
  return [
    { id: "claude", label: "Claude", skillsDir: NodePath.join(claudeHome(), "skills"), homes: [claudeHome()] },
    {
      // The cross-harness folder. Cursor and OpenCode also read
      // ~/.claude/skills and keep the first of a name.
      id: "agents",
      label: shared.length > 0 ? shared.join(", ") : "Other agents",
      skillsDir: NodePath.join(home(), ".agents", "skills"),
      homes: sharedMembers().map((member) => member.home),
    },
    {
      id: "antigravity",
      label: "Antigravity",
      skillsDir: NodePath.join(home(), ".gemini", "config", "skills"),
      homes: [NodePath.join(home(), ".gemini", "config"), NodePath.join(home(), ".gemini", "antigravity-cli")],
    },
    own("grok", "Grok", ".grok"),
    // Neither documents ~/.agents/skills.
    own("qwen", "Qwen Code", ".qwen"),
    own("junie", "Junie", ".junie"),
  ];
}

const t3Home = () => process.env.T3CODE_HOME?.trim() || NodePath.join(home(), ".t3blackout");
const storeDir = () => NodePath.join(t3Home(), "skills");
const mineDir = () => NodePath.join(t3Home(), "my-skills");
const replacedDir = () => NodePath.join(t3Home(), "skills-replaced");
const prefsFile = () => NodePath.join(t3Home(), "blackout-skills.json");
const shipped = new Set(BLACKOUT_SKILLS.map((skill) => skill.name));

const SkillsState = Schema.Struct({
  shipped: Schema.Array(PlacementItem),
  onMachine: Schema.Array(PlacementItem),
});
type SkillsState = typeof SkillsState.Type;

/** Rewrites the store from this build; each skill swaps in whole, so links never see half of one. */
async function writeStore(): Promise<void> {
  const store = storeDir();
  await NodeFSP.mkdir(store, { recursive: true });
  for (const skill of BLACKOUT_SKILLS) {
    const staging = NodePath.join(store, `.staging-${skill.name}`);
    await NodeFSP.rm(staging, { recursive: true, force: true });
    for (const file of skill.files) {
      const full = NodePath.join(staging, file.path);
      await NodeFSP.mkdir(NodePath.dirname(full), { recursive: true });
      await NodeFSP.writeFile(full, Buffer.from(file.base64, "base64"), {
        mode: file.executable ? 0o755 : 0o644,
      });
    }
    const final = NodePath.join(store, skill.name);
    await NodeFSP.rm(final, { recursive: true, force: true });
    await NodeFSP.rename(staging, final);
  }
  for (const entry of await NodeFSP.readdir(store)) {
    if (!shipped.has(entry)) await NodeFSP.rm(NodePath.join(store, entry), { recursive: true, force: true });
  }
}

const libraryOf = (name: string) => NodePath.join(shipped.has(name) ? storeDir() : mineDir(), name);

async function isOurLink(path: string): Promise<boolean> {
  try {
    if (!(await NodeFSP.lstat(path)).isSymbolicLink()) return false;
    const target = NodePath.resolve(NodePath.dirname(path), await NodeFSP.readlink(path));
    return target.startsWith(storeDir() + NodePath.sep) || target.startsWith(mineDir() + NodePath.sep);
  } catch {
    return false;
  }
}

/** False when the spot holds the person's own skill. */
async function ensureLink(skillsDir: string, name: string): Promise<boolean> {
  const path = NodePath.join(skillsDir, name);
  const target = libraryOf(name);
  const present = await NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );
  if (present) {
    if (!(await isOurLink(path))) return false;
    if ((await NodeFSP.readlink(path)) === target) return true;
    await NodeFSP.unlink(path);
  }
  await NodeFSP.mkdir(skillsDir, { recursive: true });
  await NodeFSP.symlink(target, path, "dir");
  return true;
}

/**
 * A frontmatter value as a line of text: plain, quoted, or a folded/literal
 * block. Enough for a description in Settings; the harnesses parse it fully.
 */
function frontmatterField(contents: string, key: string): string {
  const lines = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.split(/\r?\n/) ?? [];
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return "";
  let value = lines[at]!.slice(key.length + 1).trim();
  if (value === "" || /^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    value = block.filter(Boolean).join(" ");
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

const stamp = () => Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso))).replace(/[:.]/g, "-");

/** Moves a path aside instead of deleting it. */
async function setAside(path: string, from: string, name: string): Promise<void> {
  const dir = NodePath.join(replacedDir(), from);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.rename(path, NodePath.join(dir, `${name}-${stamp()}`));
}

/**
 * Moves every skill of the person's own found in a skills folder into
 * my-skills and leaves nothing of it behind there, so placement can link it
 * everywhere. A skill already in my-skills is replaced by a newer copy found
 * in a folder (an installer updating it); the old one is set aside.
 */
async function adopt(folders: ReadonlyArray<{ id: string; dir: string }>): Promise<void> {
  interface Found {
    readonly folder: string;
    readonly path: string;
    readonly real: string;
    readonly isLink: boolean;
  }
  const byName = new Map<string, Found[]>();
  for (const folder of folders) {
    const entries = await NodeFSP.readdir(folder.dir).catch((): string[] => []);
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || shipped.has(entry)) continue;
      const path = NodePath.join(folder.dir, entry);
      if (await isOurLink(path)) continue;
      if (!(await exists(NodePath.join(path, "SKILL.md")))) continue;
      const real = await NodeFSP.realpath(path).catch(() => null);
      if (real === null || real.startsWith(mineDir() + NodePath.sep)) continue;
      const isLink = (await NodeFSP.lstat(path)).isSymbolicLink();
      byName.set(entry, [...(byName.get(entry) ?? []), { folder: folder.id, path, real, isLink }]);
    }
  }
  if (byName.size === 0) return;
  await NodeFSP.mkdir(mineDir(), { recursive: true });
  const insideFolders = (real: string) => folders.some((folder) => real.startsWith(folder.dir + NodePath.sep));

  for (const [name, found] of byName) {
    const library = NodePath.join(mineDir(), name);
    if (await NodeFSP.lstat(library).then(() => true, () => false)) await setAside(library, "my-skills", name);
    // A real folder wins over a link to one; links resolve before anything moves.
    const source = found.find((entry) => !entry.isLink) ?? found[0]!;
    if (insideFolders(source.real) || !source.isLink) {
      await NodeFSP.rename(source.real, library);
    } else {
      // A link to a folder outside the harnesses (a git checkout, say): keep pointing there.
      await NodeFSP.symlink(source.real, library, "dir");
    }
    for (const entry of found) {
      const still = await NodeFSP.lstat(entry.path).then(() => true, () => false);
      if (!still) continue;
      if (entry.isLink && (entry.real === source.real || !(await exists(entry.path)))) await NodeFSP.unlink(entry.path);
      else await setAside(entry.path, entry.folder, name);
    }
  }
}

async function describe(dir: string): Promise<string> {
  const contents = await NodeFSP.readFile(NodePath.join(dir, "SKILL.md"), "utf8").catch(() => "");
  return frontmatterField(contents, "description");
}

/** Brings every harness folder in line with the libraries and the switches, and reports it. */
async function reconcile(): Promise<SkillsState> {
  const shared = await installedMembers();
  const all = harnesses(shared);
  await adopt([
    ...all.map((harness) => ({ id: harness.id, dir: harness.skillsDir })),
    ...sharedMembers().map((member) => ({ id: member.label.toLowerCase().replace(/\W+/g, "-"), dir: member.ownSkills })),
  ]);

  const prefs = await readPlacementPrefs(prefsFile());
  const mine = (await NodeFSP.readdir(mineDir()).catch((): string[] => []))
    .filter((name) => !name.startsWith(".") && !shipped.has(name))
    .sort();
  const names = new Set([...shipped, ...mine]);
  const installed: Harness[] = [];
  const blocked = new Map<string, Set<string>>();

  for (const harness of all) {
    try {
      const present = (await Promise.all(harness.homes.map(exists))).some(Boolean);
      const wanted = (name: string) =>
        present && names.has(name) && !prefs.disabled.has(name) && !prefs.excluded.get(name)?.has(harness.id);
      const entries = await NodeFSP.readdir(harness.skillsDir).catch((): string[] => []);
      for (const entry of entries) {
        const path = NodePath.join(harness.skillsDir, entry);
        if (!wanted(entry) && (await isOurLink(path))) await NodeFSP.unlink(path);
      }
      if (!present) continue;
      installed.push(harness);
      for (const name of names) {
        if (!wanted(name)) continue;
        if (!(await ensureLink(harness.skillsDir, name))) {
          blocked.set(name, (blocked.get(name) ?? new Set()).add(harness.id));
        }
      }
    } catch (error) {
      Effect.runSync(Effect.logWarning(`Could not place skills for ${harness.label}`, error));
    }
  }

  const item = (name: string, description: string) => ({
    name,
    description,
    enabled: !prefs.disabled.has(name),
    agents: installed.map((harness) => ({
      id: harness.id,
      label: harness.label,
      detail: harness.skillsDir.replace(home(), "~"),
      on: !prefs.excluded.get(name)?.has(harness.id),
      ...(blocked.get(name)?.has(harness.id) ? { blocked: `Your own /${name} is used here` } : {}),
    })),
  });

  return {
    shipped: BLACKOUT_SKILLS.map((skill) => item(skill.name, skill.description)),
    onMachine: await Promise.all(mine.map(async (name) => item(name, await describe(NodePath.join(mineDir(), name))))),
  };
}

// Launch, toggles and Settings reads all touch the same folders; one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serial<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export class BlackoutSkillsError extends Data.TaggedError("BlackoutSkillsError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return `Could not update skills: ${String(this.cause)}`;
  }
}

const run = <A>(task: () => Promise<A>) =>
  Effect.tryPromise({
    try: () => serial(task),
    catch: (cause) => new BlackoutSkillsError({ cause }),
  });

export const installBlackoutSkills = Effect.fn("desktop.ipc.installBlackoutSkills")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;

  void serial(async () => {
    await writeStore();
    return reconcile();
  }).catch((error: unknown) => {
    Effect.runSync(Effect.logWarning("Could not place Blackout skills", error));
  });

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BLACKOUT_SKILLS_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: SkillsState,
      // Reconciling on read also links a harness installed, or a skill added, since launch.
      handler: () => run(reconcile),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BLACKOUT_SKILLS_SET_ENABLED_CHANNEL,
      payload: PlacementChange,
      result: SkillsState,
      handler: (change) =>
        run(async () => {
          const prefs = await readPlacementPrefs(prefsFile());
          await writeJsonAtomic(prefsFile(), applyChange(prefs, change));
          return reconcile();
        }),
    }),
  );
});
