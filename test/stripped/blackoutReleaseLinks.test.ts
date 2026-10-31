// Copied to apps/web/src/components/ in a stripped upstream checkout and run there
// (rule web/no-stock-release-links): the updater's "Read more" and release-history links, as the app
// computes them, show upstream's commits, never a release page with stock T3 downloads (decision M).
import { describe, expect, it } from "vite-plus/test";

import { getDesktopUpdateReleaseHistoryUrl, getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic.ts";

/** lib/rules.mjs's STOCK_GUIDANCE, passed in by .github/scripts/stripped-tests.mjs. */
function stockIn(text: string): Array<string> {
  const json = process.env.T3BLACKOUT_STOCK_GUIDANCE;
  if (!json) throw new Error("run this through .github/scripts/stripped-tests.mjs, which passes lib/rules.mjs's STOCK_GUIDANCE");
  const patterns = JSON.parse(json) as Array<{ label: string; source: string; flags: string }>;
  return patterns.filter(({ source, flags }) => new RegExp(source, flags).test(text)).map(({ label }) => label);
}

describe("blackout release links", () => {
  it("shows upstream's commits up to the release, not its release page", () => {
    for (const version of ["0.1.7", "0.1.6-nightly.20261030.3917", " 1.2.3 "]) {
      const url = getDesktopUpdateReleaseUrl(version);
      expect(url).toBe(`https://github.com/pingdotgg/t3code/commits/v${encodeURIComponent(version.trim())}`);
      expect(stockIn(url!)).toEqual([]);
    }
    expect(getDesktopUpdateReleaseUrl(null)).toBeNull();
  });

  it("shows upstream's commit history for older releases", () => {
    const url = getDesktopUpdateReleaseHistoryUrl();
    expect(url).toBe("https://github.com/pingdotgg/t3code/commits");
    expect(stockIn(url)).toEqual([]);
  });

  it("never links a release page, whichever repository the build names", () => {
    for (const repository of [undefined, "pingdotgg/t3code", "someone/fork", "../t3code", "a/b/c"]) {
      for (const url of [getDesktopUpdateReleaseUrl("1.2.3", repository), getDesktopUpdateReleaseHistoryUrl(repository)]) {
        const { host, pathname } = new URL(url!);
        expect(host).toBe("github.com");
        expect(pathname).toMatch(/^\/[\w.-]+\/[\w.-]+\/commits(?:\/v1\.2\.3)?$/);
        expect(stockIn(url!)).toEqual([]);
      }
    }
  });

  it("checks against the stock-guidance patterns, which catch upstream's links", () => {
    expect(stockIn("https://github.com/pingdotgg/t3code/releases/tag/v0.1.7")).toEqual(["stock releases"]);
  });
});
