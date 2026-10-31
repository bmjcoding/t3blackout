// @effect-diagnostics globalTimers:off - Part of stream.ts's transport, which runs without an Effect runtime.
// t3blackout (lib/rules.mjs, desktop/webrtc-window): in T3 Blackout's desktop app no frame
// in the app's window may send WebRTC over UDP (apps/desktop/src/boot.ts), so the device
// stream makes its peer connections in a hidden window of the app's own, which may
// (apps/desktop/src/window/blackoutWebRtcWindow.ts). Anywhere else, a browser or the
// mobile app's WebView, it's this page's own RTCPeerConnection.
export const BLACKOUT_WEBRTC_WINDOW = "t3blackout-device-webrtc";

// Each document asks by a name of its own, so a frame that names itself the fixed one
// can't be handed the helper's place and starve the stream.
let helperName: string | null = null;
export const blackoutWebRtcWindowName = () => (helperName ??= `${BLACKOUT_WEBRTC_WINDOW}-${crypto.randomUUID()}`);

const READY_TIMEOUT_MS = 5_000;

export async function blackoutPeerConnection(): Promise<typeof RTCPeerConnection> {
  if (typeof window === "undefined" || !("desktopBridge" in window) || window.top !== window) {
    return RTCPeerConnection;
  }
  try {
    const realm = window.open("", blackoutWebRtcWindowName()) as
      | (Window & typeof globalThis & { t3blackoutWebRtc?: boolean })
      | null;
    // The app marks the window once it may use UDP; a connection made before then can't.
    for (let waited = 0; realm && !realm.closed && waited < READY_TIMEOUT_MS; waited += 20) {
      if (realm.t3blackoutWebRtc === true) return realm.RTCPeerConnection;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch {}
  return RTCPeerConnection;
}
