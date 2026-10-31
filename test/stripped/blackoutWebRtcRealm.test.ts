// Copied to packages/client-runtime/src/device/ in a stripped upstream checkout and run there
// (rules desktop/webrtc-window-realm*, APP4-01): in the desktop app the device stream makes its
// peer connections in the app's WebRTC window, once the app has marked it, and nowhere else;
// in a browser or a subframe it's the page's own RTCPeerConnection.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BLACKOUT_WEBRTC_WINDOW, blackoutPeerConnection } from "./blackoutWebRtcRealm.ts";
import { createDeviceStreamClient } from "./stream.ts";

class PagePeer {}
class RealmPeer {}

function desktopPage(realm: unknown, { top = true } = {}) {
  const open = vi.fn(() => realm);
  const page: Record<string, unknown> = { desktopBridge: {}, open };
  page.top = top ? page : {};
  vi.stubGlobal("window", page);
  vi.stubGlobal("RTCPeerConnection", PagePeer);
  return open;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("blackoutPeerConnection", () => {
  it("is the page's own outside the desktop app", async () => {
    vi.stubGlobal("RTCPeerConnection", PagePeer);
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    const open = vi.fn();
    vi.stubGlobal("window", { open, top: null });
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    expect(open).not.toHaveBeenCalled();
  });

  it("is the app's WebRTC window's in the desktop app's top frame, once marked", async () => {
    const open = desktopPage({ closed: false, t3blackoutWebRtc: true, RTCPeerConnection: RealmPeer });
    expect(await blackoutPeerConnection()).toBe(RealmPeer);
    expect(open).toHaveBeenCalledWith("", expect.stringMatching(new RegExp(`^${BLACKOUT_WEBRTC_WINDOW}-[0-9a-f-]{36}$`)));
  });

  it("waits for the app's mark, then gives up on the window after 5 s", async () => {
    vi.useFakeTimers();
    const realm: Record<string, unknown> = { closed: false, RTCPeerConnection: RealmPeer };
    desktopPage(realm);
    const marked = blackoutPeerConnection();
    await vi.advanceTimersByTimeAsync(200);
    realm.t3blackoutWebRtc = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(await marked).toBe(RealmPeer);

    delete realm.t3blackoutWebRtc;
    const never = blackoutPeerConnection();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await never).toBe(PagePeer);
  });

  it("never uses a window it can't reach, a closed one, or one from a subframe", async () => {
    desktopPage(null);
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    desktopPage({ closed: true, t3blackoutWebRtc: true, RTCPeerConnection: RealmPeer });
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    const crossOrigin = {
      closed: false,
      get t3blackoutWebRtc(): boolean {
        throw new DOMException("Blocked a frame", "SecurityError");
      },
    };
    desktopPage(crossOrigin);
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    const open = desktopPage({ closed: false, t3blackoutWebRtc: true, RTCPeerConnection: RealmPeer }, { top: false });
    expect(await blackoutPeerConnection()).toBe(PagePeer);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the device stream (stream.ts, rule desktop/webrtc-window-realm)", () => {
  function setup(realm: Record<string, unknown>) {
    vi.useFakeTimers();
    const pagePeers: unknown[] = [];
    const realmPeers: unknown[] = [];
    const peer = (into: unknown[]) =>
      class {
        iceGatheringState = "complete";
        connectionState = "new";
        localDescription = { type: "offer", sdp: "offer-sdp" };
        ontrack = null;
        onconnectionstatechange = null;
        close = vi.fn();
        createOffer = vi.fn(async () => this.localDescription);
        setLocalDescription = vi.fn(async () => {});
        setRemoteDescription = vi.fn(async () => {});
        addTransceiver = vi.fn(() => ({ setCodecPreferences: vi.fn() }));
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        constructor() {
          into.push(this);
        }
      };
    realm.RTCPeerConnection = peer(realmPeers);
    desktopPage(realm);
    vi.stubGlobal("RTCPeerConnection", peer(pagePeers));
    vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [] }) });
    vi.stubGlobal("document", {
      createElement: () => ({ style: {}, setAttribute: vi.fn(), remove: vi.fn(), play: vi.fn(async () => {}) }),
      body: { append: vi.fn() },
    });
    class Socket {
      static OPEN = 1;
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal("WebSocket", Socket);
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/api?")
          ? Response.json({ serial: "emulator-5554", stream: { transport: "webrtc" } })
          : Response.json({ type: "answer", sdp: "answer-sdp" }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const client = createDeviceStreamClient(
      {
        platform: "android",
        deviceId: "session-1",
        videoOnly: true,
        access: { httpBase: "https://test/hub", wsBase: "wss://test/hub", credentials: true, query: {} },
      },
      { present: vi.fn(() => true) },
      { onStatus: vi.fn(), onScreen: vi.fn(), onUnauthorized: vi.fn(), onMjpegFallback: vi.fn(), onInputConnected: vi.fn() },
    );
    return { client, fetch, pagePeers, realmPeers };
  }

  it("makes its peer connection in the app's WebRTC window and offers it as before", async () => {
    const { client, fetch, pagePeers, realmPeers } = setup({ closed: false, t3blackoutWebRtc: true });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(realmPeers).toHaveLength(1);
    expect(pagePeers).toHaveLength(0);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://test/hub/vendor/serve-emu/api?device=session-1",
      "https://test/hub/vendor/serve-emu/webrtc/offer?device=session-1",
    ]);
    client.stop();
  });

  it("makes none if the stream stops while it waits for the window", async () => {
    const realm: Record<string, unknown> = { closed: false };
    const { client, fetch, pagePeers, realmPeers } = setup(realm);
    client.start();
    await vi.advanceTimersByTimeAsync(100);
    client.stop();
    realm.t3blackoutWebRtc = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...realmPeers, ...pagePeers]).toHaveLength(0);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://test/hub/vendor/serve-emu/api?device=session-1"]);
  });
});
