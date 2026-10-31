// --- t3blackout boot env (injected) ----------------------------------------------
// Runs first in the Electron main process. The bundled server and every agent CLI
// it starts inherit this environment.
{
  const os = require("node:os");
  const nodePath = require("node:path");

  // <telemetry-env> (also injected into the server entry for headless hosts; lib/rules.mjs)
  // Second line of defense behind the strip rules: T3's analytics and OTLP
  // export stay off even if a rule's target code moves.
  process.env.T3CODE_TELEMETRY_ENABLED = "false";
  process.env.T3CODE_OTEL_SDK_DISABLED = "true";
  // The agent CLIs' own analytics and crash reporting, where a switch exists.
  // Codex only takes launch flags (rule provider/codex-analytics-off). Cursor's
  // SDK and Antigravity have no local switch.
  process.env.DISABLE_TELEMETRY = "1"; // Claude Code, Grok
  process.env.DISABLE_ERROR_REPORTING = "1"; // Claude Code, Grok (Sentry)
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  process.env.GROK_TELEMETRY_ENABLED = "false";
  process.env.GROK_TELEMETRY_MIXPANEL_ENABLED = "0";
  process.env.GROK_TELEMETRY_TRACE_UPLOAD = "0";
  process.env.PI_TELEMETRY = "0";
  process.env.TBH_DISABLE_TELEMETRY = "1"; // Muse
  // Crash reports from CLIs built on Bun (OpenCode among them) to bun.report.
  process.env.DO_NOT_TRACK = "1";
  process.env.BUN_ENABLE_CRASH_REPORTING = "0";
  // </telemetry-env>
  // Own data directory. Never inherit T3CODE_HOME: a shell inside the official
  // T3 Code points it at the live ~/.t3.
  process.env.T3CODE_HOME = process.env.T3BLACKOUT_HOME || nodePath.join(os.homedir(), ".t3blackout");

  // Electron's spellchecker downloads Hunspell dictionaries from Google's CDN on
  // Linux and Windows (macOS uses the system spellchecker). Off there, and the
  // download URL points nowhere in case anything turns it back on.
  if (process.platform !== "darwin" && process.type === "browser") {
    require("electron").app.on("session-created", (session: Electron.Session) => {
      session.setSpellCheckerEnabled(false);
      session.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
    });
  }

  // Content-Security-Policy doesn't cover WebRTC: an agent's HTML preview or an MCP
  // app (sandboxed frames in the app's window) could reach any host with a peer
  // connection. No web contents may send WebRTC over UDP unless it's proxied, which
  // Chromium never does, and the app's session sends what's left (TURN and ICE over
  // TCP follow the session's proxy) to a proxy that refuses every connection, on a
  // loopback port this process holds so nothing else can answer there. Loopback,
  // all the app's windows talk to, never goes through a proxy; the preview browser,
  // a browser by design, has sessions of its own. One exception, made right after
  // this: the hidden window only the app's own page can open for the device viewer's
  // peer connections may use UDP (apps/desktop/src/window/blackoutWebRtcWindow.ts).
  if (process.type === "browser") {
    const electron = require("electron");
    electron.app.on("web-contents-created", (_event: Electron.Event, contents: Electron.WebContents) => {
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    });
    const refusing = require("node:net").createServer((socket: import("node:net").Socket) => socket.destroy());
    refusing.unref();
    const port = new Promise<number>((resolve, reject) => {
      refusing.once("error", reject);
      refusing.listen(0, "127.0.0.1", () => resolve(refusing.address().port));
    });
    electron.app.once("ready", () => {
      port
        .then((held: number) => electron.session.defaultSession.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${held}` }))
        .catch((error: unknown) => {
          console.error("t3blackout: couldn't hold the app's WebRTC to loopback, so it won't run", error);
          electron.app.exit(1);
        });
    });
  }
}
// --- end t3blackout boot env -----------------------------------------------------
