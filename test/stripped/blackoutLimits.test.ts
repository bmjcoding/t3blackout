// Copied to apps/server/src/provider/ in a stripped upstream checkout and run there
// (rules provider/usage-limits-clear-probe-failure, provider/claude-usage-unified-windows).
import { describe, expect, it } from "vite-plus/test";
import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";
import { claudeRateLimitEventToUpdate } from "./claudeUsageLimits.ts";

const event = {
  status: "allowed",
  resetsAt: 1793377200,
  rateLimitType: "five_hour",
  utilization: 0.09,
  unifiedWindows: {
    five_hour: { utilization: 0.09, resetsAt: 1793377200, status: "allowed" },
    seven_day: { utilization: 0.02, resetsAt: 1793890800, status: "allowed" },
  },
} as never;

const read = (info: unknown, overageIncluded?: string) =>
  claudeRateLimitEventToUpdate(info as never, { overageIncluded })?.windows.map((w) => [w.id, w.usedPercent]);

describe("blackout usage limits", () => {
  it("reads every unified window from one Claude event", () => {
    expect(read(event)).toEqual([["five_hour", 9], ["seven_day", 2]]);
  });
  it("clears a failed probe once session and weekly windows arrive", () => {
    const update = claudeRateLimitEventToUpdate(event, { overageIncluded: undefined })!;
    const failed = { checkedAt: "2026-10-30T00:00:00.000Z", windows: [], unavailable: { reason: "probeFailed" as const } };
    const merged = applyUsageLimitsUpdate({ previous: failed, update, checkedAt: "2026-10-30T00:01:00.000Z" });
    expect(merged?.unavailable).toBeUndefined();
    expect(merged?.windows).toHaveLength(2);
  });
  it("still falls back to the single window without unifiedWindows", () => {
    expect(read({ status: "allowed", rateLimitType: "seven_day", utilization: 0.5 })).toEqual([["seven_day", 50]]);
  });
  it("keeps the base windows of a scoped event whose scope isn't named yet", () => {
    const scoped = { ...(event as object), rateLimitType: "seven_day_overage_included", utilization: 0.4 };
    expect(read(scoped)).toEqual([["five_hour", 9], ["seven_day", 2]]);
  });
  it("adds a named scope's reading to the base windows", () => {
    const scoped = { ...(event as object), rateLimitType: "seven_day_overage_included", utilization: 0.4 };
    expect(read(scoped, "Opus")).toEqual([["five_hour", 9], ["seven_day", 2], ["seven_day_opus", 40]]);
  });
  it("keeps the event's own window when unifiedWindows lacks it", () => {
    const weekly = { status: "allowed", rateLimitType: "seven_day", utilization: 0.3, unifiedWindows: { five_hour: { utilization: 0.1 } } };
    expect(read(weekly)).toEqual([["five_hour", 10], ["seven_day", 30]]);
  });
  it("lets the event's own reading win over unifiedWindows for its window", () => {
    const stale = { ...(event as object), utilization: 0.12 };
    expect(read(stale)).toEqual([["five_hour", 12], ["seven_day", 2]]);
  });
  it("reads nothing from an event with neither", () => {
    expect(claudeRateLimitEventToUpdate({ status: "allowed" } as never, { overageIncluded: undefined })).toBeUndefined();
  });
});
