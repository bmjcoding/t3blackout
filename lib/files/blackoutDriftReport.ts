// @effect-diagnostics nodeBuiltinImport:off - Reads one file the CLI wrote, outside any fiber.
// Injected by t3blackout. Hands the version stamp this build's report from the
// clone that built it (state/drift/<version>.html, lib/drift.mjs): before/after
// screenshots and what upstream changed. It's written after the build, so the
// app can't carry it; the copy baked into the bundle has no screenshots.

import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_BLACKOUT_DRIFT_REPORT_CHANNEL } from "../channels.ts";

// Written in by t3blackout: bin/t3blackout in the clone that built this app.
const LAUNCHER: string = __T3BLACKOUT_LAUNCHER__;

const MAX_BYTES = 40_000_000;

function readReport(): string | null {
  const file = NodePath.join(NodePath.dirname(NodePath.dirname(LAUNCHER)), "state", "drift", `${Electron.app.getVersion()}.html`);
  try {
    return NodeFs.statSync(file).size <= MAX_BYTES ? NodeFs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export const installBlackoutDriftReport = Effect.fn("desktop.ipc.installBlackoutDriftReport")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_BLACKOUT_DRIFT_REPORT_CHANNEL,
      payload: Schema.Void,
      result: Schema.NullOr(Schema.String),
      handler: () => Effect.sync(readReport),
    }),
  );
});
