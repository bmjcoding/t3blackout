// What an install resolved: its role (install.sh --role) and the locations its
// environment chose (T3BLACKOUT_HOME, the apps folder, the update request
// folder, XDG directories). `t3blackout configure` saves them in
// state/install.json; every later run, whether scheduled, started by the app
// or by hand, applies them before anything reads those variables
// (lib/load-install-config.mjs, imported first by bin/t3blackout), so it builds
// into, records and installs the same places the install did.
//
// A missing file means no saved config (an install from before configure). A
// file that's there but unreadable or malformed is an error, never "no config":
// falling back to the default locations would build into, install and serve
// requests from places this install doesn't use.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./atomic-file.mjs";

export const ROLES = ["ui", "host", "both"];
export const CONFIG_KEYS = ["T3BLACKOUT_HOME", "T3BLACKOUT_APPS", "T3BLACKOUT_UPDATE_REQUESTS", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
/**
 * Where a host's agent accounts find the app and reach the updater. Provisioning
 * (scripts/add-agent-account.sh), the SSH runner (lib/files/ssh-runner-blackout.sh)
 * and the servers' update requests (lib/files/blackoutHostUpdate.ts) all use these,
 * in accounts that never see this file, so the host and both roles can't move them.
 */
export const HOST_LOCATIONS = {
  T3BLACKOUT_APPS: "/Applications",
  T3BLACKOUT_UPDATE_REQUESTS: "/Users/Shared/t3blackout/update-requests",
};
const ROOT = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))));
export const INSTALL_CONFIG = path.join(ROOT, "state", "install.json");

/** The environment as this process started, before a saved config was applied. */
export const startEnv = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));

const normal = (dir) => path.resolve(dir).replace(/(.)\/+$/, "$1");

/** Whether `dir` (which needn't exist yet) is `root` or inside it, by folder identity: symlinks and letter case don't hide it. */
function isWithin(dir, root) {
  try {
    const top = fs.statSync(root);
    let at = dir;
    while (!fs.existsSync(at)) at = path.dirname(at);
    for (at = fs.realpathSync(at); ; at = path.dirname(at)) {
      const stat = fs.statSync(at);
      if (stat.dev === top.dev && stat.ino === top.ino) return true;
      if (at === path.dirname(at)) return false;
    }
  } catch {
    return false;
  }
}

/**
 * Why `value` can't be location `key`, or null. Each must be absolute (a
 * relative one would move with each run's working folder); T3BLACKOUT_HOME
 * can't be this clone or inside it, where its bin/t3blackout (the CLI shim)
 * would be the CLI itself.
 */
function locationProblem(key, value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\0\n\r]/.test(value)) return `${key}=${value} isn't an absolute path`;
  if (key === "T3BLACKOUT_HOME" && isWithin(value, ROOT)) return `T3BLACKOUT_HOME=${value} is this clone (${ROOT}) or inside it`;
  return null;
}

/**
 * The locations in `env` as every run uses them and configure saves them:
 * empty is unset (null), the rest checked (locationProblem) and normalized.
 * Throws on the first that can't be used.
 */
export function locationsOf(env) {
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => {
      const value = env[key];
      if (value === undefined || value === null || value === "") return [key, null];
      const problem = locationProblem(key, value);
      if (problem) throw new Error(`${problem}; set it to an absolute path outside the clone, or unset it, and run install.sh again`);
      return [key, normal(value)];
    }),
  );
}

/** Makes `env`'s locations the ones locationsOf gives: empty ones unset first, so nothing reads "" as a path even if another is refused. */
export function useLocations(env = process.env) {
  for (const key of CONFIG_KEYS) if (env[key] === "") delete env[key];
  for (const [key, value] of Object.entries(locationsOf(env))) if (value !== null) env[key] = value;
}

/** Why the host and both roles can't use `env`'s locations, or null. */
export function hostLocationProblem(role, env) {
  if (role === "ui") return null;
  for (const [key, required] of Object.entries(HOST_LOCATIONS)) {
    const value = env[key];
    if (value && normal(value) !== required) {
      return `--role ${role} can't use ${key}=${value}: agent accounts only look in ${required}; unset it and run install.sh again`;
    }
  }
  return null;
}

/** Throws unless `config` is what saveInstallConfig writes: a known role, and each location absent, null or an absolute path. */
export function validateInstallConfig(config, file = INSTALL_CONFIG) {
  const bad = (why) => new Error(`${file} is invalid (${why}); rerun ./install.sh, or bin/t3blackout configure --role ui|host|both`);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw bad("not a JSON object");
  if (!ROLES.includes(config.role)) throw bad(`unknown role ${JSON.stringify(config.role)}`);
  if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) throw bad("no env object");
  for (const [key, value] of Object.entries(config.env)) {
    if (!CONFIG_KEYS.includes(key)) throw bad(`unknown setting ${key}`);
    const problem = value === null ? null : locationProblem(key, value);
    if (problem) throw bad(problem);
  }
  const host = hostLocationProblem(config.role, config.env);
  if (host) throw bad(host);
  return config;
}

/** The saved config, or null when there's none; throws if the file is there but unreadable or invalid. */
export function readInstallConfig(file = INSTALL_CONFIG) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`can't read ${file} (${error.code ?? error.message}); rerun ./install.sh, or bin/t3blackout configure --role ui|host|both`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} isn't valid JSON (${error.message}); rerun ./install.sh, or bin/t3blackout configure --role ui|host|both`);
  }
  return validateInstallConfig(config, file);
}

/**
 * Sets `env` to the saved locations (a variable unset at install is unset
 * again). Returns the variables the environment had set differently.
 */
export function applyInstallConfig(config, env = process.env) {
  const overridden = [];
  for (const key of CONFIG_KEYS) {
    if (!config || !(key in config.env)) continue;
    const saved = config.env[key];
    if (env[key] !== undefined && env[key] !== saved) overridden.push(key);
    if (typeof saved === "string") env[key] = saved;
    else delete env[key];
  }
  return overridden;
}

/**
 * Saves `role` (else the saved one, else "ui") and the locations in `env`,
 * replacing the file whole. An invalid saved file is overwritten only when a
 * role is given, since its role can't be trusted.
 */
export function saveInstallConfig({ role, env = startEnv, file = INSTALL_CONFIG } = {}) {
  let previous = null;
  try {
    previous = readInstallConfig(file);
  } catch (error) {
    if (!role) throw new Error(`${error.message.replace(/; rerun .*$/, "")}; give the role: bin/t3blackout configure --role ui|host|both`);
  }
  const chosen = role ?? previous?.role ?? "ui";
  if (!ROLES.includes(chosen)) throw new Error(`unknown role ${chosen} (ui, host or both)`);
  const locations = locationsOf(env);
  const host = hostLocationProblem(chosen, locations);
  if (host) throw new Error(host);
  const config = { role: chosen, env: locations, savedAt: new Date().toISOString() };
  validateInstallConfig(config, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, config);
  return config;
}
