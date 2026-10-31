// Copied to apps/web/src/components/sidebar/ in a stripped upstream checkout and run there
// (rules web/self-update-blackout-host-requested-*): a host whose T3 Blackout updater only took
// the request is reported as requested, never as updated.
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  closeFinishedUpdateRun,
  collectUpdateEverythingResult,
  describeUpdateCapsule,
  getUpdateEverythingToastView,
  RUN_STATUS_LABELS,
  resolveUpdateRunMachineStatus,
  type UpdateEverythingRun,
  type UpdateRunMachine,
} from "./updateEverything.logic";

const machine = (id: string, result: UpdateRunMachine["result"]): UpdateRunMachine => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  updatesProviders: false,
  server: null,
  handedOffVersion: null,
  startedAt: 0,
  result,
  failure: null,
  providerFailure: null,
});
const run = (machines: ReadonlyArray<UpdateRunMachine>): UpdateEverythingRun => ({ localVersion: null, phase: "servers", restartAt: null, machines });

describe("blackout requested host updates", () => {
  it("counts a requested host apart from updated ones", () => {
    const result = collectUpdateEverythingResult({
      localVersion: null,
      localFailures: [],
      servers: [
        { label: "build-host", outcome: { status: "requested" } },
        { label: "svc", outcome: { status: "updated" } },
      ],
      providers: [],
    });
    expect(result).toMatchObject({ updatedServers: 1, requestedServers: 1, failures: [] });
  });
  it("never says a requested host was updated", () => {
    const only = getUpdateEverythingToastView(
      { localVersion: null, updatedServers: 0, requestedServers: 1, updatedProviders: 0, failures: [], restarting: [] },
      "0.1.6",
    );
    expect(only?.type).toBe("success");
    expect(only?.title).toBe("Update requested on 1 server");
    expect(only?.title).not.toMatch(/^Updated/);
    expect(only?.description).toContain("T3 Blackout updater builds the signed pin");

    const mixed = getUpdateEverythingToastView(
      { localVersion: null, updatedServers: 0, requestedServers: 2, updatedProviders: 1, failures: [], restarting: [] },
      "0.1.6",
    );
    expect(mixed?.title).toBe("Updated 1 provider");
    expect(mixed?.description).toContain("Requested an update of 2 servers");

    const failed = getUpdateEverythingToastView(
      { localVersion: null, updatedServers: 0, requestedServers: 1, updatedProviders: 0, failures: ["svc: no"], restarting: [] },
      "0.1.6",
    );
    expect(failed?.title).toBe("Update failed");
    expect(failed?.description).toContain("Requested an update of 1 server");
  });
  it("settles a requested row as requested, and the run as finished", () => {
    const view = { machine: machine("build-host", "requested"), status: resolveUpdateRunMachineStatus(machine("build-host", "requested"), "servers", { status: "idle" } as never) };
    expect(view.status).toBe("requested");
    expect(RUN_STATUS_LABELS.requested).toBe("update requested");
    expect(describeUpdateCapsule(run([view.machine]), [view], null, 0).label).toBe("0 of 1 updated");
    expect(closeFinishedUpdateRun(run([machine("build-host", "requested"), machine("svc", "done")]))).toBeNull();
    expect(closeFinishedUpdateRun(run([machine("build-host", "requested"), machine("svc", null)]))).not.toBeNull();
  });
});
