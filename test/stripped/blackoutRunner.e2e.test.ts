// Copied to packages/ssh/src/ in a stripped upstream checkout. Real ssh to localhost:
// T3B_E2E_VERSION=<installed version> vp test run src/blackoutRunner.e2e.test.ts
// (rules ssh/runner-installed-blackout-only, ssh/blackout-home).
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as SshTunnel from "./tunnel.ts";

const target = { alias: "localhost", hostname: "localhost", username: null, port: null };
const version = process.env.T3B_E2E_VERSION ?? "";
const auth = { batchMode: true } as never;

describe.skipIf(!process.env.T3B_E2E_VERSION)("blackout SSH runner (real ssh to localhost)", () => {
  it.effect("launches or adopts the installed Blackout server at the desktop's version", () =>
    Effect.gen(function* () {
      const launched = yield* SshTunnel.launchOrReuseRemoteServer(target, auth, { archiveVersion: version });
      console.log("launch:", JSON.stringify(launched));
      assert.isTrue(Number.isInteger(launched.remotePort));
      const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${launched.remotePort}/.well-known/t3/environment`));
      const descriptor = (yield* Effect.promise(() => response.json())) as { serverVersion: string };
      console.log("descriptor version:", descriptor.serverVersion);
      assert.strictEqual(descriptor.serverVersion, version);
      const pairing = yield* SshTunnel.issueRemotePairingToken(target, auth, { archiveVersion: version });
      assert.isTrue(pairing.credential.length > 10);
      console.log("pairing token minted (length", pairing.credential.length + ")");
    }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );
  it.effect("runs the host's build even when the desktop is a different version", () =>
    Effect.gen(function* () {
      const launched = yield* SshTunnel.launchOrReuseRemoteServer(target, auth, { archiveVersion: "9.9.9" });
      assert.isTrue(Number.isInteger(launched.remotePort));
    }).pipe(Effect.provide(NodeServices.layer)),
    120_000,
  );
});
