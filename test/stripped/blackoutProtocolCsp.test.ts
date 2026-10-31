// Copied to apps/desktop/src/electron/ in a stripped upstream checkout and run there
// (rules desktop/protocol-csp, shared/csp-policy-file).
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { T3BLACKOUT_ASSET_CSP } from "@t3tools/shared/t3blackoutCsp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

const layerProtocol = ElectronProtocol.layer.pipe(Layer.provide(NodeServices.layer));

describe("blackout desktop protocol CSP", () => {
  it.effect("sends the loopback-only policy with the page and its worker scripts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(`${directory}/index.html`, "<html>app</html>");
      yield* fileSystem.writeFileString(`${directory}/worker.js`, "fetch('https://example.com/');");
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      const protocol = yield* ElectronProtocol.ElectronProtocol;
      yield* protocol.registerDesktopProtocol({ scheme: "t3code", assetDirectory: directory, clerkFrontendApiHostname: undefined });
      for (const pathname of ["/", "/worker.js"]) {
        const response = yield* Effect.promise(() => handler!(new Request(`t3code://app${pathname}`)));
        const policy = response.headers.get("content-security-policy") ?? "";
        assert.equal(policy, T3BLACKOUT_ASSET_CSP);
        assert.notMatch(policy, /(?:^|\s)(?:https?|wss?):(?:\s|;|$)/);
      }
    }).pipe(Effect.provide(Layer.merge(layerProtocol, NodeServices.layer)), Effect.scoped),
  );
});
