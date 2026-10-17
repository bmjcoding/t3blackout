// --- t3blackout boot guard (injected) -------------------------------------------
// Runs before anything else in the Electron main process.
//  1. Forces telemetry/OTLP/updater off for this process and the server child.
//  2. Keeps state in ~/.t3blackout so the official app's ~/.t3 is never touched.
//  3. Refuses to run outside the Seatbelt egress sandbox. A double-clicked app
//     is relaunched through `t3blackout launch`; if that fails the app just exits.
{
  const childProcess = require("node:child_process");
  const os = require("node:os");
  const nodePath = require("node:path");

  process.env.T3CODE_TELEMETRY_ENABLED = "false";
  process.env.T3CODE_OTEL_SDK_DISABLED = "true";
  process.env.T3CODE_DISABLE_AUTO_UPDATE = "true";
  // Never inherit T3CODE_HOME: a shell inside the official app points it at ~/.t3.
  process.env.T3CODE_HOME = process.env.T3BLACKOUT_HOME || nodePath.join(os.homedir(), ".t3blackout");

  // The t3blackout profile denies reading this one file. EPERM therefore means
  // "inside our sandbox"; a successful read or any other error means not.
  let sandboxed = false;
  try {
    require("node:fs").readFileSync(__T3BLACKOUT_CANARY__);
  } catch (error) {
    sandboxed = error.code === "EPERM";
  }

  const fs = require("node:fs");
  // Synchronous on purpose: this process may exit a moment later.
  const guardLog = (message) => {
    try {
      fs.mkdirSync(process.env.T3CODE_HOME, { recursive: true });
      fs.appendFileSync(
        nodePath.join(process.env.T3CODE_HOME, "guard.log"),
        `${new Date().toISOString()} pid=${process.pid} ${message}\n`,
      );
    } catch {}
  };
  guardLog(`sandboxed=${sandboxed} relaunched=${process.env.T3BLACKOUT_RELAUNCHED === "1"}`);

  if (!sandboxed) {
    if (process.env.T3BLACKOUT_RELAUNCHED !== "1") {
      // Opened from Finder/Dock: macOS tears down an app's child processes when
      // it exits, so hand the relaunch to launchd (an inert LaunchAgent that
      // `t3blackout update` installs). Fall back to a detached child for shells.
      const kick = childProcess.spawnSync("/bin/launchctl", [
        "kickstart",
        `gui/${process.getuid()}/dev.t3blackout.launch`,
      ]);
      guardLog(`kickstart status=${kick.status} error=${kick.error?.code ?? "none"}`);
      if (kick.status !== 0) {
        try {
          childProcess
            // Absolute node path: apps opened from Finder get a PATH without Homebrew.
            .spawn(__T3BLACKOUT_NODE__, [__T3BLACKOUT_LAUNCHER__, "launch"], {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, T3BLACKOUT_RELAUNCHED: "1" },
            })
            .unref();
        } catch {}
      }
    }
    fs.writeSync(2, "t3blackout: not running inside the egress sandbox; refusing to start.\n");
    process.exit(1);
  }

  const { app } = require("electron");
  // macOS refuses nested Seatbelt profiles, so Chromium's helpers can't apply
  // their own; without this the GPU process dies and the app exits.
  app.commandLine.appendSwitch("no-sandbox");
  // Chromium ignores HTTPS_PROXY. Route it explicitly; loopback stays direct.
  if (process.env.T3BLACKOUT_PROXY_PORT) {
    app.commandLine.appendSwitch("proxy-server", `http://127.0.0.1:${process.env.T3BLACKOUT_PROXY_PORT}`);
  }
}
// --- end t3blackout boot guard --------------------------------------------------
