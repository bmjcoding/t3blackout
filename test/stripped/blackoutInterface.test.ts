// Copied to apps/web/src/ in a stripped upstream checkout and run there
// (rules web/blackout-interface-file, web/blackout-interface-setting-search).
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const attributes = new Map<string, string>();

function stubDom(storage: Partial<Storage>) {
  vi.stubGlobal("document", { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } });
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => {} });
}

const load = () => import("./t3blackoutInterface");

describe("blackout interface switches", () => {
  beforeEach(() => {
    attributes.clear();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads with every switch on when storage can't be read", async () => {
    stubDom({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const { BLACKOUT_INTERFACE_KEYS } = await load();
    for (const key of BLACKOUT_INTERFACE_KEYS) expect(attributes.get(`data-t3b-${key}`)).toBe("on");
  });
  it("switches in this window even when storage is full", async () => {
    stubDom({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    const { setBlackoutInterface } = await load();
    expect(() => setBlackoutInterface("art", false)).not.toThrow();
    expect(attributes.get("data-t3b-art")).toBe("off");
  });
  it("reads stored switches", async () => {
    stubDom({ getItem: (key: string) => (key === "t3blackout:interface:stamp" ? "off" : null), setItem: () => {} });
    await load();
    expect(attributes.get("data-t3b-stamp")).toBe("off");
    expect(attributes.get("data-t3b-wordmark")).toBe("on");
  });
  it("registers each switch with Settings search under its title", async () => {
    stubDom({ getItem: () => null });
    const { BLACKOUT_INTERFACE, BLACKOUT_INTERFACE_KEYS, BLACKOUT_INTERFACE_SEARCH_ITEMS } = await load();
    const { searchableSetting } = await import("./components/settings/settingsSearch");
    expect(BLACKOUT_INTERFACE_SEARCH_ITEMS.map((item) => item.id)).toEqual(BLACKOUT_INTERFACE_KEYS.map((key) => `t3blackout-${key}`));
    for (const key of BLACKOUT_INTERFACE_KEYS) {
      expect(searchableSetting(`t3blackout-${key}`)).toEqual({ id: `t3blackout-${key}`, title: BLACKOUT_INTERFACE[key].title });
    }
  });
});
