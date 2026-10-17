// The build half of an update: checkout, strip, build, scan, smoke test. Runs as
// the build account when there is one (lib/builder.mjs), otherwise as you. The
// result is an unsigned app in OUT; signing and installing happen as you.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { progress } from "./events.mjs";
import { forbiddenInBuild, makeRules } from "./rules.mjs";
import { smokeTest } from "./smoke.mjs";
import { applyRules, scanForbidden } from "./strip-engine.mjs";
import { IS_BUILDER, LAUNCHER, MIRROR, OUT, STATE, WORK, copyTree, gitMirror, log, readJson, run, stableNodePath } from "./util.mjs";

/** Whether WORK is a checkout of the current mirror (it moves when the build account is set up). */
function workBelongsToMirror() {
  if (!fs.existsSync(path.join(WORK, ".git"))) return false;
  const common = spawnSync("git", ["-C", WORK, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return common.status === 0 && fs.existsSync(path.join(MIRROR, ".git")) && common.stdout.trim() === fs.realpathSync(path.join(MIRROR, ".git"));
}

export function checkoutWork(ref) {
  if (workBelongsToMirror()) {
    // Reuse the checkout and its node_modules: deleting them took most of a
    // minute, and `pnpm install --frozen-lockfile` brings node_modules back in
    // line with the new lockfile. Everything else, build output included, goes.
    run("git", ["-C", WORK, "checkout", "--quiet", "--force", "--detach", ref]);
    run("git", ["-C", WORK, "clean", "-fdxq", "-e", "node_modules"]);
  } else {
    fs.rmSync(WORK, { recursive: true, force: true });
    run("git", gitMirror(["worktree", "prune"]));
    run("git", gitMirror(["worktree", "add", "--quiet", "--detach", WORK, ref]));
  }
  // Upstream's .env.example holds production Clerk/relay values; a stray .env
  // would bake them in. The rules already force those constants empty.
  for (const name of [".env", ".env.local"]) fs.rmSync(path.join(WORK, name), { force: true });
}

/**
 * What the app's update button runs (BlackoutUpdater.ts): the CLI in your clone
 * with your node and PATH. The build account gets these from you via env.
 */
function updaterPaths() {
  return {
    node: process.env.T3BLACKOUT_APP_NODE ?? stableNodePath(),
    launcher: process.env.T3BLACKOUT_APP_LAUNCHER ?? LAUNCHER,
    path: process.env.T3BLACKOUT_APP_PATH ?? process.env.PATH ?? "/usr/bin:/bin",
  };
}

export function strip() {
  log("applying strip rules");
  const failures = applyRules(WORK, makeRules({ updater: updaterPaths() }));
  if (failures.length) {
    throw new Error(
      `${failures.length} strip rule(s) no longer match upstream. Nothing was installed.\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\nUpdate lib/rules.mjs for the new upstream code, then rerun.",
    );
  }
}

/** Build-time env: no cloud keys, no publish tokens, nothing inherited by accident. */
function buildEnv() {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  // Upstream's build spawns `vp` by name; use the repo's own vite-plus so the
  // machine doesn't need it installed globally.
  env.PATH = [path.join(WORK, "node_modules", ".bin"), process.env.PATH ?? "/usr/bin:/bin"].join(":");
  return {
    ...env,
    CI: "1",
    T3CODE_DESKTOP_SIGNED: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
  };
}

function buildApp(version, platform) {
  const opts = { cwd: WORK, env: buildEnv() };
  log("installing dependencies");
  run("pnpm", ["install", "--frozen-lockfile"], opts);
  progress(40);
  // The injected updater implements upstream's ElectronUpdater service; if that
  // interface moves, stop here instead of shipping an app that fails at runtime.
  // Upstream's own script, run directly: `pnpm run` re-verifies the install.
  log("typechecking the desktop app");
  const desktop = path.join(WORK, "apps", "desktop");
  const typecheck = readJson(path.join(desktop, "package.json"), {}).scripts?.typecheck;
  if (!typecheck) throw new Error("apps/desktop has no typecheck script anymore; update lib/build.mjs");
  run("/bin/sh", ["-c", typecheck], { ...opts, cwd: desktop });
  progress(50);
  log(`building desktop app ${version} (${platform.name}, unsigned)`);
  run(process.execPath, ["scripts/build-desktop-artifact.ts", ...platform.buildArgs(), "--build-version", version], opts);
}

function scanDist() {
  log("scanning build output for forbidden endpoints");
  const hits = scanForbidden(
    ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"].map((dir) => path.join(WORK, dir)),
    forbiddenInBuild,
  );
  if (hits.length) {
    throw new Error(`forbidden endpoints found in build output:\n${hits.map((h) => `  - ${h}`).join("\n")}`);
  }
  const html = path.join(WORK, "apps", "web", "dist", "index.html");
  if (fs.existsSync(html) && !fs.readFileSync(html, "utf8").includes("Content-Security-Policy")) {
    throw new Error("built index.html is missing the t3blackout CSP");
  }
}

/** Copies the packaged app out of upstream's temporary stage into OUT. */
function collect(found) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (typeof found === "string") {
    const app = path.join(OUT, path.basename(found));
    copyTree(found, app);
    return app;
  }
  const dir = path.join(OUT, "app");
  copyTree(found.dir, dir);
  const icon = found.icon ? path.join(OUT, "icon.png") : null;
  if (icon) fs.copyFileSync(found.icon, icon);
  return { dir, icon };
}

/** Weekly, and only in the build account's own store: yours is shared with your other projects. */
function pruneStore() {
  if (!IS_BUILDER) return;
  const stamp = path.join(STATE, "store-pruned");
  if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < 7 * 24 * 3600 * 1000) return;
  log("pruning unused packages from the pnpm store");
  run("pnpm", ["store", "prune"], { cwd: WORK, env: buildEnv(), stdio: "ignore" });
  fs.writeFileSync(stamp, "");
}

/** Builds `sha` into an unsigned, smoke-tested app; returns where it is in OUT. */
export async function buildArtifact({ sha, version, platform }) {
  const stages = platform.beginBuild();
  try {
    checkoutWork(sha);
    strip();
    progress(20);
    buildApp(version, platform);
    progress(70);
    scanDist();
    const artifact = collect(stages.findArtifact());
    progress(80);
    await smokeTest();
    progress(90);
    pruneStore();
    return artifact;
  } finally {
    stages.cleanup();
  }
}

/** Dry run: checkout and strip only. */
export function checkRules(ref) {
  log(`checking strip rules against ${ref}`);
  checkoutWork(ref);
  strip();
  log("all rules apply cleanly");
}
