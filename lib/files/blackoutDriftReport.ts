// @effect-diagnostics nodeBuiltinImport:off - Reads files and starts one process for the CLI, outside any fiber.
// Injected by t3blackout. Hands the version stamp a build's report from the
// clone that built it (state/drift/<version>.html, lib/drift.mjs): before/after
// screenshots and what upstream changed. It's written after the build, so the
// app can't carry it; the copy baked into the bundle has no screenshots. Also
// opens a staged build's preview (`t3blackout preview`, lib/preview.mjs).

import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_BLACKOUT_DRIFT_REPORT_CHANNEL, PREVIEW_BLACKOUT_BUILD_CHANNEL } from "../channels.ts";

// Written in by t3blackout: the CLI that built this app, and the node and PATH it ran with.
const NODE: string = __T3BLACKOUT_NODE__;
const LAUNCHER: string = __T3BLACKOUT_LAUNCHER__;
const PATH: string = __T3BLACKOUT_PATH__;

const STATE = NodePath.join(NodePath.dirname(NodePath.dirname(LAUNCHER)), "state");
const MAX_BYTES = 40_000_000;
const VERSION = /^[\w.+-]+$/;

/** The report for `version` (default: this build's), or null. */
function readReport(version: string | null): string | null {
  const wanted = version ?? Electron.app.getVersion();
  if (!VERSION.test(wanted)) return null;
  const file = NodePath.join(STATE, "drift", `${wanted}.html`);
  try {
    return NodeFs.statSync(file).size <= MAX_BYTES ? NodeFs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

const EVENT_PREFIX = "t3blackout:event ";
/** Copying the profile, booting the sandboxed server and opening Chrome. */
const PREVIEW_START_TIMEOUT_MS = 180_000;

/**
 * Starts `t3blackout preview` on its own and waits for its window to open
 * (its "preview-open" event); resolves with why it couldn't, or null. The
 * preview outlives this app's answer: it runs until its window closes.
 * `cli`: the CLI that built this app, unless a test says otherwise.
 */
export function startPreview(
  cli: { readonly node: string; readonly launcher: string; readonly state: string; readonly timeoutMs?: number } = {
    node: NODE,
    launcher: LAUNCHER,
    state: STATE,
  },
): Promise<string | null> {
  if (!NodeFs.existsSync(NodePath.join(cli.state, "pending.json"))) return Promise.resolve("No update is waiting to be previewed.");
  if (!NodeFs.existsSync(cli.node) || !NodeFs.existsSync(cli.launcher)) {
    return Promise.resolve(`The t3blackout CLI isn't at ${cli.launcher} anymore.`);
  }
  return new Promise((resolve) => {
    let settled = false;
    let failure: string | null = null;
    let stderrTail = "";
    const settle = (problem: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(problem);
    };
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(cli.node, [cli.launcher, "preview", "--json"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH, ELECTRON_RUN_AS_NODE: undefined },
      });
    } catch (error) {
      resolve(`The preview couldn't start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const timer = setTimeout(
      () => settle("The preview is still starting; it opens in a window of its own when it's ready."),
      cli.timeoutMs ?? PREVIEW_START_TIMEOUT_MS,
    );
    // Its output is read to the end, so a full pipe never stalls it.
    child.stdout?.setEncoding("utf8");
    let buffered = "";
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(EVENT_PREFIX)) continue;
        let event: { readonly type?: unknown; readonly message?: unknown };
        try {
          event = JSON.parse(line.slice(EVENT_PREFIX.length));
        } catch {
          continue;
        }
        if (event.type === "preview-open") settle(null);
        else if (event.type === "error") failure = String(event.message);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.once("error", (error) => settle(`The preview couldn't start: ${error.message}`));
    // "close", not "exit": its last lines (the error event) are read by then.
    child.once("close", (code, signal) =>
      settle(`The preview couldn't start: ${failure ?? (stderrTail.trim().split("\n").at(-1) || `t3blackout preview exited with ${code ?? signal}`)}`),
    );
    child.unref();
    for (const stream of [child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
  });
}

export const installBlackoutDriftReport = Effect.fn("desktop.ipc.installBlackoutDriftReport")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_BLACKOUT_DRIFT_REPORT_CHANNEL,
      payload: Schema.NullOr(Schema.String),
      result: Schema.NullOr(Schema.String),
      handler: (version) => Effect.sync(() => readReport(version)),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: PREVIEW_BLACKOUT_BUILD_CHANNEL,
      payload: Schema.Void,
      result: Schema.NullOr(Schema.String),
      handler: () => Effect.promise(() => startPreview()),
    }),
  );
});
