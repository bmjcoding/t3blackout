// Copied to apps/web/src/components/settings/ in a stripped upstream checkout and run there
// (rules web/update-track-pinned, web/no-npm-release-poll).
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UpdateTrackSwitchDialog } from "./UpdateTrackSwitchDialog";

afterEach(() => vi.restoreAllMocks());

describe("blackout update track", () => {
  it("explains pinned tracks instead of looking up npm", async () => {
    const fetches = vi.spyOn(window, "fetch");
    await using _screen = await render(<UpdateTrackSwitchDialog channel="latest" onClose={() => {}} />);
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(page.getByText(/pin\.json pins for each track/)).toBeVisible();
    await expect.element(page.getByText(/t3blackout update --channel stable/)).toBeVisible();
    expect(page.getByText(/npm\. Try again later/).query()).toBeNull();
    expect(fetches.mock.calls.filter(([url]) => String(url).includes("npmjs"))).toEqual([]);
  });
});
