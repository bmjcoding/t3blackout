// Copied to apps/server/src/ in a stripped upstream checkout and run there
// (rules server/static-assets-csp, shared/csp-policy-file).
import { expect, it } from "@effect/vitest";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { T3BLACKOUT_ASSET_CSP } from "@t3tools/shared/t3blackoutCsp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";

// As upstream's http.test.ts serves its static route.
const makeStaticRequest = Effect.fn("BlackoutStaticCsp.makeStaticRequest")(function* (staticDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerApp = Layer.merge(ServerHttp.layerStaticAndDevRoute, ServerHttp.layerHttpCompression).pipe(
    Layer.provideMerge(NodeHttpPlatform.layer),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true }).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  return (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3b-static-csp-" }).pipe(Layer.provideMerge(NodeServices.layer)),
)("blackout static CSP", (it) => {
  it.effect("sends the loopback-only policy with scripts (workers), pages and 304s", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-static-csp-" });
      yield* fs.writeFileString(path.join(staticDir, "worker.js"), "fetch('https://example.com/');");
      yield* fs.writeFileString(path.join(staticDir, "index.html"), "<!doctype html><title>x</title>");
      const request = yield* makeStaticRequest(staticDir);
      const worker = yield* request("/worker.js");
      expect(worker.status).toBe(200);
      expect(worker.headers["content-security-policy"]).toBe(T3BLACKOUT_ASSET_CSP);
      expect(worker.headers["content-security-policy"]).not.toMatch(/(?:^|\s)(?:https?|wss?):(?:\s|;|$)/);
      const page = yield* request("/");
      expect(page.headers["content-security-policy"]).toBe(T3BLACKOUT_ASSET_CSP);
      const unchanged = yield* request("/worker.js", { headers: { "if-none-match": worker.headers["etag"]! } });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers["content-security-policy"]).toBe(T3BLACKOUT_ASSET_CSP);
    }),
  );
  it.effect("sends it when the file is read whole (no handle, as in an asar)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-static-csp-asar-" });
      const filePath = path.join(staticDir, "worker.js");
      yield* fs.writeFileString(filePath, "self.onmessage = () => {};");
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          candidate === filePath
            ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "open", pathOrDescriptor: candidate }))
            : fs.open(candidate, options),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      const worker = yield* request("/worker.js");
      expect(worker.status).toBe(200);
      expect(worker.headers["content-security-policy"]).toBe(T3BLACKOUT_ASSET_CSP);
    }),
  );
});
