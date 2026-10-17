// Linux: unpacked app build (electron-builder "dir" target) copied to a fixed
// directory (nothing to execute at install time, no FUSE, and a stable path for
// Ubuntu's AppArmor profile), launcher entry in ~/.local/share/applications,
// scheduled with a systemd user timer.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LAUNCHER, commandExists, findPaths, log, renderTemplate, run, stableNodePath, trackStageDirs } from "../util.mjs";

const DATA = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
const CONFIG = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
const INSTALL_DIR = path.join(DATA, "t3blackout");
const APP_DIR = path.join(INSTALL_DIR, "app");
const APP_STAGED = path.join(INSTALL_DIR, "app.new");
// A verified build waiting for the running app to restart.
const APP_PENDING = path.join(INSTALL_DIR, "app.pending");
const APP_PREVIOUS = path.join(INSTALL_DIR, "app.previous");
const ICON = path.join(INSTALL_DIR, "icon.png");
// electron-builder's linux executableName upstream; Ubuntu's AppArmor profile
// (install.sh) is keyed to this path.
const EXECUTABLE = path.join(APP_DIR, "t3code");
const BUNDLED_ICON = "t3blackout-icon.png";
const DESKTOP_ENTRY = path.join(DATA, "applications", "t3blackout.desktop");
const UNIT_DIR = path.join(CONFIG, "systemd", "user");
const UNIT = "t3blackout-update";

function writeDesktopEntry() {
  const bundledIcon = path.join(APP_DIR, BUNDLED_ICON);
  if (fs.existsSync(bundledIcon)) fs.copyFileSync(bundledIcon, ICON);
  fs.mkdirSync(path.dirname(DESKTOP_ENTRY), { recursive: true });
  fs.writeFileSync(
    DESKTOP_ENTRY,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=T3 Blackout",
      "Comment=T3 Code with telemetry stripped",
      `Exec="${EXECUTABLE}" %U`,
      `Icon=${ICON}`,
      "Categories=Development;",
      "StartupWMClass=t3code",
      "Terminal=false",
      "",
    ].join("\n"),
  );
  if (commandExists("update-desktop-database")) {
    childProcess.spawnSync("update-desktop-database", [path.dirname(DESKTOP_ENTRY)], { stdio: "ignore" });
  }
}

const systemctl = (...args) => childProcess.spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });

export default {
  name: "Linux",
  installedPath: APP_DIR,
  pendingPath: APP_PENDING,

  isRunning() {
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (fs.readlinkSync(`/proc/${pid}/exe`).startsWith(`${APP_DIR}/`)) return true;
      } catch {
        // Gone, or another user's process.
      }
    }
    return false;
  },

  buildArgs: () => ["--platform", "linux", "--target", "dir", "--arch", process.arch === "arm64" ? "arm64" : "x64", "--keep-stage"],

  beginBuild() {
    const stages = trackStageDirs("linux");
    return {
      findArtifact() {
        const roots = stages.ours();
        const [dir] = findPaths(
          roots,
          (entry, full) => entry.isDirectory() && entry.name.endsWith("-unpacked") && fs.existsSync(path.join(full, "resources", "app.asar")),
        );
        if (!dir) throw new Error("build finished but no unpacked Linux app was found in the build stage");
        const [icon] = findPaths(roots, (entry) => entry.isFile() && /^(512x512|icon)\.png$/.test(entry.name));
        return { dir, icon };
      },
      cleanup: stages.cleanup,
    };
  },

  stage({ dir, icon }) {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.rmSync(APP_STAGED, { recursive: true, force: true });
    run("cp", ["-a", dir, APP_STAGED]);
    if (icon) fs.copyFileSync(icon, path.join(APP_STAGED, BUNDLED_ICON));
    if (!fs.existsSync(path.join(APP_STAGED, "t3code"))) {
      throw new Error(`unpacked app has no 't3code' executable (upstream renamed it?): ${fs.readdirSync(APP_STAGED).join(", ")}`);
    }
    return APP_STAGED;
  },

  scanRoots: (staged) => [path.join(staged, "resources")],

  activate(staged) {
    fs.rmSync(APP_PREVIOUS, { recursive: true, force: true });
    if (fs.existsSync(APP_DIR)) fs.renameSync(APP_DIR, APP_PREVIOUS);
    fs.renameSync(staged, APP_DIR);
    writeDesktopEntry();
  },

  rollback() {
    if (!fs.existsSync(APP_PREVIOUS)) throw new Error("no previous build to roll back to");
    const tmp = path.join(INSTALL_DIR, "app.swap");
    fs.renameSync(APP_DIR, tmp);
    fs.renameSync(APP_PREVIOUS, APP_DIR);
    fs.renameSync(tmp, APP_PREVIOUS);
  },

  launch() {
    if (!fs.existsSync(EXECUTABLE)) throw new Error(`${APP_DIR} is not installed; run \`t3blackout update\` first`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|T3CODE_)/.test(key)));
    childProcess.spawn(EXECUTABLE, [], { detached: true, stdio: "ignore", env }).unref();
  },

  schedule(hour) {
    if (!commandExists("systemctl") || systemctl("show-environment").status !== 0) {
      throw new Error("no systemd user session; run `t3blackout update` from cron or by hand instead");
    }
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    const values = {
      __NODE__: stableNodePath(),
      __LAUNCHER__: LAUNCHER,
      __PATH__: process.env.PATH ?? "/usr/bin:/bin",
      __HOUR__: String(hour).padStart(2, "0"),
    };
    for (const ext of ["service", "timer"]) {
      fs.writeFileSync(path.join(UNIT_DIR, `${UNIT}.${ext}`), renderTemplate(`systemd/${UNIT}.${ext}`, values));
    }
    systemctl("daemon-reload");
    const enabled = systemctl("enable", "--now", `${UNIT}.timer`);
    if (enabled.status !== 0) throw new Error(`systemctl --user enable failed: ${enabled.stderr}`);
  },

  unschedule() {
    systemctl("disable", "--now", `${UNIT}.timer`);
    for (const ext of ["service", "timer"]) fs.rmSync(path.join(UNIT_DIR, `${UNIT}.${ext}`), { force: true });
    systemctl("daemon-reload");
  },

  isScheduled: () => commandExists("systemctl") && systemctl("is-enabled", `${UNIT}.timer`).status === 0,

  notify(title, message) {
    if (commandExists("notify-send")) childProcess.spawnSync("notify-send", [title, message], { stdio: "ignore" });
  },

  statusLines: () => [],

  commands: {
    signing: () => {
      log("signing isn't needed on Linux: desktop keyrings don't tie access to an app signature");
    },
  },
};
