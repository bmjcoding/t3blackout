// @effect-diagnostics nodeBuiltinImport:off -- Mirrors electron-updater: an event emitter driving a child process, outside any fiber.
// t3blackout: updates come from bin/t3blackout, which rebuilds the app from
// upstream source (strip, build, verify, smoke test) instead of downloading a
// release. This implements upstream's ElectronUpdater service on top of that
// CLI, so the sidebar button, app menu and Settings drive it unchanged:
//   check    -> `t3blackout poll`, download -> `t3blackout update --stage-only`,
//   install  -> `t3blackout apply` once this process has quit.
// Only checks the user starts reach the network (isManualCheck); the startup
// and background polls read local state.

import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFs from "node:fs";
import * as NodeReadline from "node:readline";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronUpdater from "./ElectronUpdater.ts";

// Written in by t3blackout when it builds this app: the CLI that built it and
// the PATH that build ran with (git, pnpm and Rust are on it).
const NODE: string = __T3BLACKOUT_NODE__;
const LAUNCHER: string = __T3BLACKOUT_LAUNCHER__;
const PATH: string = __T3BLACKOUT_PATH__;

const EVENT_PREFIX = "t3blackout:event ";
const MANUAL_CHECK_REASONS = new Set(["web-ui", "menu", "remote-update", "channel-change"]);

export const isManualCheck = (reason: string): boolean => MANUAL_CHECK_REASONS.has(reason);

interface CliEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface AvailableUpdate {
  readonly ref: string;
  readonly version: string;
  readonly staged: boolean;
  readonly releaseNotes: ReadonlyArray<{ readonly version: string; readonly note: string }>;
}

const emitter = new NodeEvents.EventEmitter();
let channel = "latest";
let allowDowngrade = false;
let announced: AvailableUpdate | null = null;

// Upstream's messages are fixed ("Electron updater failed to download the
// update…") and the UI shows only the message, so a failed build would never
// say why. These keep upstream's tags and show the CLI's reason instead.
const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

class CheckFailed extends ElectronUpdater.ElectronUpdaterCheckForUpdatesError {
  override get message(): string {
    return `Could not check for updates: ${reasonOf(this.cause)}`;
  }
}

class BuildFailed extends ElectronUpdater.ElectronUpdaterDownloadUpdateError {
  override get message(): string {
    return reasonOf(this.cause);
  }
}

function cliEnv(): NodeJS.ProcessEnv {
  // ELECTRON_RUN_AS_NODE and the app's own T3CODE_* settings must not reach
  // the build or the relaunched app.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|T3CODE_|NODE_OPTIONS$)/.test(key)),
  );
  return { ...env, PATH };
}

function runCli(args: ReadonlyArray<string>, onEvent: (event: CliEvent) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(NODE, [LAUNCHER, ...args, "--json"], {
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: string | null = null;
    let stderrTail = "";
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      let event: CliEvent;
      try {
        event = JSON.parse(line.slice(EVENT_PREFIX.length)) as CliEvent;
      } catch {
        return;
      }
      if (event.type === "error") failure = String(event.message);
      onEvent(event);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(failure ?? (stderrTail.trim() || `t3blackout ${args[0]} exited with ${code}`)));
    });
  });
}

const check = (offline: boolean) =>
  Effect.suspend(() => {
    const checkChannel = channel;
    return Effect.tryPromise({
      try: async () => {
        emitter.emit("checking-for-update");
        const result: { update: AvailableUpdate | null } = { update: null };
        await runCli(
          [
            "poll",
            "--channel",
            checkChannel,
            ...(offline ? ["--offline"] : []),
            ...(allowDowngrade ? ["--allow-downgrade"] : []),
          ],
          (event) => {
            if (event.type === "poll") result.update = (event.update as AvailableUpdate | null) ?? null;
          },
        );
        announced = result.update;
        if (!result.update) {
          emitter.emit("update-not-available");
          return;
        }
        const { version, releaseNotes } = result.update;
        emitter.emit("update-available", { version, releaseNotes });
        if (result.update.staged) emitter.emit("update-downloaded", { version });
      },
      catch: (cause) => new CheckFailed({ channel: checkChannel, cause }),
    });
  });

/** Fetches upstream tags; only for checks the user starts. */
export const checkUpstream = check(false);

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.ElectronUpdater.of({
  setFeedURL: () => Effect.void,
  setAutoDownload: () => Effect.void,
  setAutoInstallOnAppQuit: () => Effect.void,
  setChannel: (value) =>
    Effect.sync(() => {
      channel = value;
    }),
  setAllowPrerelease: () => Effect.void,
  allowDowngrade: Effect.sync(() => allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.sync(() => {
      allowDowngrade = value;
    }),
  setFullChangelog: () => Effect.void,
  setDisableDifferentialDownload: () => Effect.void,
  checkForUpdates: check(true),
  downloadUpdate: Effect.suspend(() => {
    const target = announced;
    const downloadChannel = channel;
    return Effect.tryPromise({
      try: async () => {
        if (!target) throw new Error("No update to build; check for updates first.");
        await runCli(["update", "--ref", target.ref, "--stage-only"], (event) => {
          if (event.type === "progress") emitter.emit("download-progress", { percent: event.percent });
        });
        emitter.emit("update-downloaded", { version: target.version });
      },
      catch: (cause) => new BuildFailed({ channel: downloadChannel, cause }),
    });
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.try({
      try: () => {
        if (!NodeFs.existsSync(NODE) || !NodeFs.existsSync(LAUNCHER)) {
          throw new Error(`t3blackout CLI not found (${NODE} ${LAUNCHER})`);
        }
        // Swaps the staged build in once this process has exited, then relaunches.
        const child = NodeChildProcess.spawn(NODE, [LAUNCHER, "apply", "--wait-pid", String(process.pid)], {
          detached: true,
          stdio: "ignore",
          env: cliEnv(),
        });
        // A failed spawn leaves pid undefined (handled below) and then emits
        // "error"; without a listener that would crash the main process.
        child.once("error", () => {});
        if (child.pid === undefined) throw new Error("could not start t3blackout apply");
        child.unref();
        Electron.app.quit();
      },
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({ channel, isSilent, isForceRunAfter, cause }),
    }),
  on: (eventName, listener) => {
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        emitter.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          emitter.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  },
});

export const layer = Layer.succeed(ElectronUpdater.ElectronUpdater, make);
