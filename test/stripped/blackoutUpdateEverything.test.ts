// Copied to apps/web/src/components/sidebar/ in a stripped upstream checkout and run there
// (rules web/self-update-blackout-host*, contracts/self-update-blackout-host, web/no-stock-manual-update-command).
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { manualServerUpdateCommand, resolveServerSelfUpdateCapability } from "~/versionSkew";
import { collectServerUpdateTargets, type UpdateEverythingMachine } from "./updateEverything.logic";

function machine(id: string, capabilities: Record<string, unknown>): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.6-nightly.20261030.3917",
        capabilities: { repositoryIdentity: true, ...capabilities },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    } as never,
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
  };
}

describe("blackout host updates", () => {
  it("updates a host whose T3 Blackout updater takes requests, without waiting for npm", () => {
    const { targets, skipped, waitForNpm } = collectServerUpdateTargets(
      [machine("build-host", { blackoutHostUpdate: true }), machine("manual", {})],
      "0.1.6-nightly.20261031.4000",
      false,
    );
    expect(targets.map((target) => [target.serverLabel, target.selfUpdate])).toEqual([["build-host", "blackout-host"]]);
    expect(waitForNpm).toEqual([]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([["manual", "needs a manual update"]]);
  });
  it("keeps upstream's capability when a server has one", () => {
    expect(resolveServerSelfUpdateCapability(machine("svc", { serverSelfUpdate: "boot-service", blackoutHostUpdate: true }).serverConfig)).toBe(
      "boot-service",
    );
    expect(resolveServerSelfUpdateCapability(machine("build-host", { blackoutHostUpdate: true }).serverConfig)).toBe("blackout-host");
    expect(resolveServerSelfUpdateCapability(machine("x", {}).serverConfig)).toBeNull();
  });
  it("never offers stock T3 as the manual update", () => {
    for (const installation of [undefined, { kind: "npx" as const }, { kind: "npm-global" as const, prefix: "/usr/local" }]) {
      const command = manualServerUpdateCommand("0.1.6", installation);
      expect(command).toBe("~/.t3blackout/bin/t3blackout update");
      expect(command).not.toMatch(/\bt3@|npx|npm install/);
    }
  });
});
