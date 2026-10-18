// @effect-diagnostics nodeBuiltinImport:off - Placement builds folders and symlinks with node:fs's own calls.
// Injected by t3blackout. Ships the skills in the repo's skills/ folder to every
// agent harness that's installed, and lets Settings -> Skills turn each one off.
//
// Each skill is written once to <T3 home>/skills/<name> on launch, from the
// copy baked into this build (blackoutSkills.generated.ts). Every installed
// harness gets a symlink to it in the folder it reads skills from. The CLIs and
// T3's own skill scanners follow the link; verified for Claude Code and Codex.
//
// A link that resolves into <T3 home>/skills is ours: we add, replace and remove
// only those. A folder, file or foreign link of the same name is the person's
// own skill and is never touched; the setting reports it as skipped. A harness
// counts as installed when its home folder exists; we create only the skills/
// folder inside it, so nothing appears for harnesses that aren't there.

import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BLACKOUT_SKILLS } from "../../blackoutSkills.generated.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  BLACKOUT_SKILLS_GET_STATE_CHANNEL,
  BLACKOUT_SKILLS_SET_ENABLED_CHANNEL,
} from "../channels.ts";

interface Harness {
  readonly label: string;
  readonly skillsDir: string;
  /** Linked when any of these exists. */
  readonly homes: ReadonlyArray<string>;
}

function harnesses(): ReadonlyArray<Harness> {
  const home = NodeOS.homedir();
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(home, ".claude");
  const codex = process.env.CODEX_HOME?.trim() || NodePath.join(home, ".codex");
  const config = process.env.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
  const own = (label: string, dir: string) => ({
    label,
    skillsDir: NodePath.join(home, dir, "skills"),
    homes: [NodePath.join(home, dir)],
  });
  return [
    { label: "Claude", skillsDir: NodePath.join(claude, "skills"), homes: [claude] },
    {
      // The cross-harness folder. Cursor also reads ~/.claude/skills and keeps
      // the first of a name it finds.
      label: "Codex & other agents",
      skillsDir: NodePath.join(home, ".agents", "skills"),
      homes: [
        NodePath.join(home, ".agents"),
        codex,
        NodePath.join(home, ".cursor"),
        NodePath.join(config, "opencode"),
        NodePath.join(config, "muse"),
        NodePath.join(home, ".copilot"),
        NodePath.join(config, "devin"),
        NodePath.join(config, "goose"),
        NodePath.join(home, ".augment"),
        NodePath.join(home, ".gemini"),
      ],
    },
    {
      label: "Antigravity",
      skillsDir: NodePath.join(home, ".gemini", "config", "skills"),
      homes: [NodePath.join(home, ".gemini")],
    },
    own("Grok", ".grok"),
    // Neither documents ~/.agents/skills.
    own("Qwen Code", ".qwen"),
    own("Junie", ".junie"),
  ];
}

const t3Home = () => process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3blackout");
const storeDir = () => NodePath.join(t3Home(), "skills");
const prefsFile = () => NodePath.join(t3Home(), "blackout-skills.json");
const shipped = new Set(BLACKOUT_SKILLS.map((skill) => skill.name));

const SkillState = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  /** Harnesses it's linked into. */
  placed: Schema.Array(Schema.String),
  /** Harnesses where a skill of the same name that isn't ours holds the spot. */
  skipped: Schema.Array(Schema.String),
});
const SkillsState = Schema.Array(SkillState);
type SkillsState = typeof SkillsState.Type;

const exists = (path: string) =>
  NodeFS.stat(path).then(
    () => true,
    () => false,
  );

async function readDisabled(): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await NodeFS.readFile(prefsFile(), "utf8"));
    const disabled = (parsed as { disabled?: unknown }).disabled;
    return new Set(Array.isArray(disabled) ? disabled.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

async function writeDisabled(disabled: ReadonlySet<string>): Promise<void> {
  const file = prefsFile();
  await NodeFS.mkdir(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await NodeFS.writeFile(temporary, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + "\n");
  await NodeFS.rename(temporary, file);
}

/** Rewrites the store from this build; each skill swaps in whole, so links never see half of one. */
async function writeStore(): Promise<void> {
  const store = storeDir();
  await NodeFS.mkdir(store, { recursive: true });
  for (const skill of BLACKOUT_SKILLS) {
    const staging = NodePath.join(store, `.staging-${skill.name}`);
    await NodeFS.rm(staging, { recursive: true, force: true });
    for (const file of skill.files) {
      const full = NodePath.join(staging, file.path);
      await NodeFS.mkdir(NodePath.dirname(full), { recursive: true });
      await NodeFS.writeFile(full, Buffer.from(file.base64, "base64"), {
        mode: file.executable ? 0o755 : 0o644,
      });
    }
    const final = NodePath.join(store, skill.name);
    await NodeFS.rm(final, { recursive: true, force: true });
    await NodeFS.rename(staging, final);
  }
  for (const entry of await NodeFS.readdir(store)) {
    if (!shipped.has(entry)) await NodeFS.rm(NodePath.join(store, entry), { recursive: true, force: true });
  }
}

async function isOurLink(path: string): Promise<boolean> {
  try {
    if (!(await NodeFS.lstat(path)).isSymbolicLink()) return false;
    const target = NodePath.resolve(NodePath.dirname(path), await NodeFS.readlink(path));
    return target.startsWith(storeDir() + NodePath.sep);
  } catch {
    return false;
  }
}

/** False when the spot holds the person's own skill. */
async function ensureLink(skillsDir: string, name: string): Promise<boolean> {
  const path = NodePath.join(skillsDir, name);
  const target = NodePath.join(storeDir(), name);
  const present = await NodeFS.lstat(path).then(
    () => true,
    () => false,
  );
  if (present) {
    if (!(await isOurLink(path))) return false;
    if ((await NodeFS.readlink(path)) === target) return true;
    await NodeFS.unlink(path);
  }
  await NodeFS.mkdir(skillsDir, { recursive: true });
  await NodeFS.symlink(target, path, "dir");
  return true;
}

/** Brings every harness folder in line with what's shipped and enabled, and reports it. */
async function reconcile(): Promise<SkillsState> {
  const disabled = await readDisabled();
  const placed = new Map(BLACKOUT_SKILLS.map((skill) => [skill.name, [] as string[]]));
  const skipped = new Map(BLACKOUT_SKILLS.map((skill) => [skill.name, [] as string[]]));

  for (const harness of harnesses()) {
    try {
      const installed = (await Promise.all(harness.homes.map(exists))).some(Boolean);
      const entries = await NodeFS.readdir(harness.skillsDir).catch((): string[] => []);
      for (const entry of entries) {
        const wanted = installed && shipped.has(entry) && !disabled.has(entry);
        const path = NodePath.join(harness.skillsDir, entry);
        if (!wanted && (await isOurLink(path))) await NodeFS.unlink(path);
      }
      if (!installed) continue;
      for (const skill of BLACKOUT_SKILLS) {
        if (disabled.has(skill.name)) continue;
        const linked = await ensureLink(harness.skillsDir, skill.name);
        (linked ? placed : skipped).get(skill.name)?.push(harness.label);
      }
    } catch (error) {
      Effect.runSync(Effect.logWarning(`Could not place skills for ${harness.label}`, error));
    }
  }

  return BLACKOUT_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
    enabled: !disabled.has(skill.name),
    placed: placed.get(skill.name) ?? [],
    skipped: skipped.get(skill.name) ?? [],
  }));
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
    return `Could not update Blackout skills: ${String(this.cause)}`;
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
      // Reconciling on read also links a harness installed since launch.
      handler: () => run(reconcile),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: BLACKOUT_SKILLS_SET_ENABLED_CHANNEL,
      payload: Schema.Struct({ name: Schema.String, enabled: Schema.Boolean }),
      result: SkillsState,
      handler: ({ name, enabled }) =>
        run(async () => {
          const disabled = await readDisabled();
          if (enabled) disabled.delete(name);
          else if (shipped.has(name)) disabled.add(name);
          await writeDisabled(disabled);
          return reconcile();
        }),
    }),
  );
});
