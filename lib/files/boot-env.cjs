// --- t3blackout boot env (injected) ----------------------------------------------
// Runs first in the Electron main process. The bundled server and every agent CLI
// it starts inherit this environment.
{
  const os = require("node:os");
  const nodePath = require("node:path");

  // Second line of defense behind the strip rules: T3's analytics and OTLP
  // export stay off even if a rule's target code moves.
  process.env.T3CODE_TELEMETRY_ENABLED = "false";
  process.env.T3CODE_OTEL_SDK_DISABLED = "true";
  // Claude Code's own telemetry, error reporting and other non-essential traffic.
  process.env.DISABLE_TELEMETRY = "1";
  process.env.DISABLE_ERROR_REPORTING = "1";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Own data directory. Never inherit T3CODE_HOME: a shell inside the official
  // T3 Code points it at the live ~/.t3.
  process.env.T3CODE_HOME = process.env.T3BLACKOUT_HOME || nodePath.join(os.homedir(), ".t3blackout");
}
// --- end t3blackout boot env -----------------------------------------------------
