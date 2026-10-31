// Copied to apps/web/src/components/ in a stripped upstream checkout and run there
// (rules web/blackout-brand-file, web/blackout-css, web/blackout-interface-file).
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../t3blackout.css";
import { render } from "../../test/render";
import { BlackoutRedactedArt, BlackoutVersionStamp } from "./BlackoutBrand";

const REPORT = "<!doctype html><h1>Report</h1><p><a href='#end'>Down</a></p><p id='end'>End</p>";

function fakeBridge() {
  (window as { desktopBridge?: unknown }).desktopBridge = {
    onUpdateState: () => () => {},
    getUpdateState: async () => null,
    getBlackoutDriftReport: async () => REPORT,
  };
}

afterEach(() => {
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

const inDialog = () => Boolean(document.activeElement?.closest('[role="dialog"]'));

describe("blackout brand", () => {
  it("opens the report as a modal dialog that holds focus and gives it back", async () => {
    fakeBridge();
    await using screen = await render(
      <>
        <button type="button">Before</button>
        <BlackoutVersionStamp />
      </>,
    );
    await userEvent.hover(screen.container.querySelector(".t3b-version-stamp")!);
    const open = page.getByRole("button", { name: "See what changed" });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(page.getByRole("dialog", { name: "What changed" })).toBeVisible();
    await expect.poll(inDialog).toBe(true);
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      expect(inDialog() || document.activeElement?.tagName === "IFRAME").toBe(true);
      expect(document.activeElement?.textContent).not.toBe("Before");
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement?.textContent).toBe("See what changed");
  });

  it("draws the accent strike where the bars' mask can't hide it", async () => {
    const container = document.createElement("div");
    container.style.cssText = "width: 480px; height: 52px; --sidebar: #000; --sidebar-foreground: #fff; --t3b-accent: #ff0000;";
    document.body.append(container);
    await using screen = await render(<BlackoutRedactedArt fallback={<span>stars</span>} />, { container, router: false });
    const art = screen.container.querySelector(".t3b-redacted") as HTMLElement;
    // Tailwind's h-full, which this test doesn't load.
    art.style.height = "52px";
    const bars = art.querySelector(".t3b-redacted-bars") as HTMLElement;
    const strike = art.querySelector(".t3b-redacted-strike") as HTMLElement;
    expect(strike.parentElement).toBe(art);
    expect(strike.offsetLeft - bars.offsetLeft).toBe(26);
    // A string with save: false; { path, base64 } in other versions.
    const shot = (await page.screenshot({ element: art, base64: true, save: false })) as unknown as string | { base64: string };
    const base64 = typeof shot === "string" ? shot : shot.base64;
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const scale = image.width / art.getBoundingClientRect().width;
    const red = (x: number, y: number) => context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data[0]!;
    // Mid-strike against the gap just before it, on the same row.
    expect(red(strike.offsetLeft + 22, 28)).toBeGreaterThan(40);
    expect(red(strike.offsetLeft - 3, 28)).toBeLessThan(12);
  });
});
