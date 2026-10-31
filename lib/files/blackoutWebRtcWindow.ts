// t3blackout (lib/rules.mjs, desktop/webrtc-window): a window of the app's own for the
// device viewer's peer connections.
//
// No web contents in the app may send WebRTC over UDP, and the app's session refuses the
// TCP that's left (boot-env.ts in apps/desktop/src/boot.ts): agents' HTML previews and
// MCP apps are frames in the app's window, and Content-Security-Policy doesn't cover
// WebRTC. The policy belongs to a whole web contents, so EAS Simulator, whose devices
// stream over WebRTC only, got no video. The app's page, and only its top frame, may open
// one hidden window by a name starting with this and make its peer connections there
// (packages/client-runtime/src/device/blackoutWebRtcRealm.ts): a web contents of its own,
// so those may use UDP while every frame in the app's window still can't. Its TCP still
// goes to the refusing proxy, the session being the app's. It never leaves about:blank,
// opens nothing, and closes with the page that opened it.
import type * as Electron from "electron";

export const BLACKOUT_WEBRTC_WINDOW = "t3blackout-device-webrtc";
// The page asks by this name plus a random UUID of its own (blackoutWebRtcRealm.ts).
const HELPER_NAME = new RegExp(`^${BLACKOUT_WEBRTC_WINDOW}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);

export function blackoutWebRtcWindows(electron: Pick<typeof Electron, "app" | "WebContentsView">) {
  // The top frame of the app window whose window.open asked for one, until it's created.
  let asking: Electron.WebFrameMain | null = null;
  const trusted = new WeakSet<Electron.WebContents>();
  const views = new Set<Electron.WebContentsView>();
  let listening = false;

  // Runs right after boot-env.ts gave the new contents the app's policy.
  const created =(_event: Electron.Event, contents: Electron.WebContents) => {
    const opener = asking;
    if (opener === null || contents.getType() !== "window") return;
    asking = null;
    if (contents.opener !== opener) return;
    trusted.add(contents);
    contents.setWebRTCIPHandlingPolicy("default");
  };

  const adopt = (owner: Electron.WebContents, options: Electron.BrowserWindowConstructorOptions) => {
    asking = null;
    const contents = (options as { readonly webContents?: Electron.WebContents }).webContents;
    if (!contents) throw new Error("t3blackout: Electron didn't hand over the window it made");
    // Never attached to a window: nothing shows, and nothing counts it as one.
    const view = new electron.WebContentsView({ webContents: contents });
    views.add(view);
    const close = () => {
      if (!contents.isDestroyed()) contents.close();
    };
    if (!trusted.has(contents)) {
      // A frame other than the app's page asked: it keeps the app's policy and goes.
      contents.once("destroyed", () => views.delete(view));
      setImmediate(close);
      return contents;
    }
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => {
      event.preventDefault();
      close();
    });
    // The first is the window's own about:blank being committed.
    let committed = false;
    contents.on("did-start-navigation", (event) => {
      if (!committed && event.url === "about:blank") committed = true;
      else if (!event.isSameDocument) close();
    });
    const ownerNavigated = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) close();
    };
    owner.on("did-start-navigation", ownerNavigated);
    owner.on("render-process-gone", close);
    owner.once("destroyed", close);
    contents.once("destroyed", () => {
      views.delete(view);
      if (owner.isDestroyed()) return;
      owner.off("did-start-navigation", ownerNavigated);
      owner.off("render-process-gone", close);
      owner.off("destroyed", close);
    });
    // Its renderer started it with the opener's policy, and ours follows on the same
    // channel as this: the page makes peer connections there only once it sees the mark.
    void contents.executeJavaScript("window.t3blackoutWebRtc = true;").catch(close);
    return contents;
  };

  return {
    /** For an app window's window-open handler: the answer for this window, or null for any other. */
    open(owner: Electron.WebContents, details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse | null {
      if (!HELPER_NAME.test(details.frameName)) return null;
      if (details.url !== "about:blank") return { action: "deny" };
      if (!listening) {
        electron.app.on("web-contents-created", created);
        listening = true;
      }
      asking = owner.mainFrame;
      return { action: "allow", outlivesOpener: false, createWindow: (options) => adopt(owner, options) };
    },
  };
}
