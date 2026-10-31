// Copied to apps/desktop/src/window/ in a stripped upstream checkout and run there (rule
// desktop/context-menu-image-session, APP4-02): Copy Image on a subframe's image fetches it
// through the session that showed it (a preview guest's own; the app's for the app's window),
// never always the app's, with upstream's credential, redirect and timeout limits.
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";

import { copyContextMenuImage } from "./ContextMenuImage.ts";

const native = vi.hoisted(() => ({
  netFetch: vi.fn(),
  createFromBuffer: vi.fn(),
  write: vi.fn(),
  image: { isEmpty: () => false, toPNG: () => Buffer.from("png") },
}));

vi.mock("electron", () => ({
  net: { fetch: native.netFetch },
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: { write: native.write },
  ClipboardItem: class {},
}));

const sourcePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==",
  "base64",
);

function guest() {
  const session = { fetch: vi.fn(function (this: unknown) {
    // Electron's session.fetch needs its session as `this`.
    if (this !== session) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(Uint8Array.from(sourcePng)));
  }) };
  const frame = { isDestroyed: () => false };
  const contents = {
    isDestroyed: () => false,
    copyImageAt: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(),
    mainFrame: { isDestroyed: () => false },
    session,
  };
  const copy = (srcURL: string) =>
    copyContextMenuImage(contents as unknown as Electron.WebContents, { x: 1, y: 2, srcURL, frame } as unknown as Electron.ContextMenuParams);
  return { session, contents, copy };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.createFromBuffer.mockReturnValue(native.image);
  native.write.mockResolvedValue(undefined);
});

it("fetches a subframe's image through the guest's own session, with upstream's limits", async () => {
  const { session, contents, copy } = guest();
  await copy("https://example.com/image.png");
  expect(session.fetch).toHaveBeenCalledWith("https://example.com/image.png", {
    credentials: "omit",
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
  expect(native.netFetch).not.toHaveBeenCalled();
  expect(contents.copyImageAt).not.toHaveBeenCalled();
  expect(native.write).toHaveBeenCalledTimes(1);
});

it("still decodes data: URLs locally and refuses other schemes and credentials", async () => {
  const { session, copy } = guest();
  await copy(`data:image/png;base64,${sourcePng.toString("base64")}`);
  expect(session.fetch).not.toHaveBeenCalled();
  for (const url of ["file:///etc/passwd", "https://user:pass@example.com/image.png", "t3code://app/image.png"]) {
    await expect(copy(url)).rejects.toThrow("Unsupported image URL");
  }
  expect(session.fetch).not.toHaveBeenCalled();
  expect(native.netFetch).not.toHaveBeenCalled();
});
