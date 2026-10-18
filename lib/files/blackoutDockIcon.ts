// Injected by t3blackout. The dock icon in the theme's accent, on macOS.
//
// The bundle's icon is a Liquid Glass .icon compiled at build time, so its
// orange is fixed. When the renderer's accent isn't Blackout's orange it draws
// the same mark in that accent, light and dark (t3blackoutDockIcon.ts), and this
// shows the one matching the macOS icon appearance in the dock while the app
// runs. null hands the dock back to the bundle's glass icon.

import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_BLACKOUT_DOCK_ICON_CHANNEL } from "../channels.ts";

const PngDataUrl = Schema.String.check(
  Schema.isMaxLength(4_000_000),
  Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
);

const DockIcon = Schema.NullOr(Schema.Struct({ light: PngDataUrl, dark: PngDataUrl }));

/** Settings -> Appearance -> Icon & widget style, else the system appearance. */
function prefersDarkIcon(): boolean {
  const iconStyle = Electron.systemPreferences.getUserDefault("AppleIconAppearanceTheme", "string");
  if (iconStyle.includes("Dark")) return true;
  if (iconStyle.includes("Light")) return false;
  return Electron.systemPreferences.getUserDefault("AppleInterfaceStyle", "string") === "Dark";
}

let icon: typeof DockIcon.Type = null;
let shown: string | null = null;

function applyDockIcon(): void {
  const next = icon ? (prefersDarkIcon() ? icon.dark : icon.light) : null;
  if (next === shown) return;
  shown = next;
  try {
    Electron.app.dock?.setIcon(
      // Electron takes null to restore the bundle icon; its types don't say so.
      next ? Electron.nativeImage.createFromDataURL(next) : (null as unknown as Electron.NativeImage),
    );
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update the dock icon", error));
  }
}

export const installBlackoutDockIcon = Effect.fn("desktop.ipc.installBlackoutDockIcon")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin") return;

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_BLACKOUT_DOCK_ICON_CHANNEL,
        payload: DockIcon,
        result: Schema.Void,
        handler: (next) =>
          Effect.sync(() => {
            icon = next;
            applyDockIcon();
          }),
      }),
    );

    const subscription = Electron.systemPreferences.subscribeNotification(
      "AppleInterfaceThemeChangedNotification",
      applyDockIcon,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => Electron.systemPreferences.unsubscribeNotification(subscription)),
    );
  },
);
