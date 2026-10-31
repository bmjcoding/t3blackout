// Copied to apps/web/src/components/ in a stripped upstream checkout and run there
// (rules web/self-update-blackout-host-wording, web/self-update-blackout-host-requested-*): a host
// update its T3 Blackout updater only queued comes back as "requested", quiet or not, and settles
// its Update everything row as requested.
import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({ updateServer: vi.fn(), toast: vi.fn(), sessionAtom: null as unknown }));

vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return { ...actual, environmentSession: { ...actual.environmentSession, sessionStateAtom: (() => testState.sessionAtom) as never } };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { type ServerUpdateOutcome, type ServerUpdateTarget, useServerUpdate } from "./ServerUpdateAction";
import { setUpdateEverythingRun, settleUpdateRunMachine } from "./sidebar/updateEverythingRun";

const session = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

const target = (selfUpdate: ServerUpdateTarget["selfUpdate"]): ServerUpdateTarget =>
  ({ environmentId: EnvironmentId.make("build-host"), serverLabel: "Build host", selfUpdate, targetVersion: "0.1.6" }) as ServerUpdateTarget;

async function runUpdate(method: string, quiet: boolean): Promise<ServerUpdateOutcome> {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.sessionAtom = Atom.make(AsyncResult.success(session));
  testState.updateServer.mockResolvedValue(AsyncResult.success({ targetVersion: "0.1.6", method }));
  let update: ReturnType<typeof useServerUpdate> | null = null;
  function Probe() {
    update = useServerUpdate();
    return null;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
    { router: false },
  );
  let outcome: ServerUpdateOutcome | null = null;
  await act(async () => {
    outcome = await update!(target(method === "blackout-host" ? "blackout-host" : "boot-service"), { quiet });
  });
  return outcome!;
}

describe("blackout requested host update", () => {
  it("reports a queued host build as requested, quiet (Update everything) or not", async () => {
    expect(await runUpdate("blackout-host", true)).toEqual({ status: "requested" });
    expect(testState.toast).not.toHaveBeenCalled();
    expect(await runUpdate("blackout-host", false)).toEqual({ status: "requested" });
    expect(testState.toast.mock.calls[0]?.[0]).toMatchObject({ title: "Build host update requested" });
    expect(await runUpdate("boot-service", true)).toEqual({ status: "updated" });
  });
  it("settles the host's Update everything row as requested", () => {
    const row = (id: string) => ({
      environmentId: EnvironmentId.make(id),
      label: id,
      updatesProviders: false,
      server: null,
      handedOffVersion: null,
      startedAt: 0,
      result: null,
      failure: null,
      providerFailure: null,
    });
    setUpdateEverythingRun(() => ({ localVersion: null, phase: "servers", restartAt: null, machines: [row("build-host"), row("svc")] }));
    settleUpdateRunMachine(EnvironmentId.make("build-host"), null, { serverUpdated: true, serverRequested: true });
    let results: Array<[string, unknown]> = [];
    setUpdateEverythingRun((run) => {
      results = (run?.machines ?? []).map((m) => [m.label, m.result]);
      return null;
    });
    expect(results).toEqual([
      ["build-host", "requested"],
      ["svc", null],
    ]);
  });
});
