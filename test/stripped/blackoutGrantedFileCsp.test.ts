// Copied to apps/server/src/ in a stripped upstream checkout and run there
// (rules server/static-assets-csp, shared/csp-policy-file).
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { T3BLACKOUT_ASSET_CSP, T3BLACKOUT_SANDBOXED_CSP } from "@t3tools/shared/t3blackoutCsp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { assetFileResponse, assetResponseHeaders } from "./http.ts";

const csp = (path: string, options?: Parameters<typeof assetResponseHeaders>[1]) => assetResponseHeaders(path, options)["Content-Security-Policy"];
// A policy with no scheme-wide or outside source: only 'self', loopback and the desktop schemes.
const loopbackOnly = (policy: string) =>
  policy
    .split(",")
    .some((part) => /connect-src/.test(part) && !/(?:^|\s)(?:https?:|wss?:|\*)(?:\s|;|$)/.test(part) && !/https:\/\/(?!127\.0\.0\.1|localhost)/.test(part));

describe("blackout granted-file CSP", () => {
  it("gives a granted script (a worker) the UI's loopback-only policy", () => {
    expect(csp("/work/notes/worker.js")).toBe(T3BLACKOUT_ASSET_CSP);
    expect(csp("/work/data.json")).toBe(T3BLACKOUT_ASSET_CSP);
    expect(csp("/work/clip.mp4", { mimeType: "video/mp4" })).toBe(T3BLACKOUT_ASSET_CSP);
  });
  it("keeps the sandbox on agent HTML, SVGs and downloads and adds the loopback-only reach", () => {
    for (const [policy, sandbox] of [
      [csp("/work/report.html"), "sandbox allow-scripts allow-forms allow-popups allow-downloads"],
      [csp("/work/report.bin", { mimeType: "text/html" }), "sandbox allow-scripts allow-forms allow-popups allow-downloads"],
      [csp("/work/logo.svg"), "default-src 'none'; style-src 'unsafe-inline'; sandbox"],
      [csp("/work/report.html", { download: true }), "default-src 'none'; sandbox"],
    ] as const) {
      expect(policy).toBe(`${sandbox}, ${T3BLACKOUT_SANDBOXED_CSP}`);
      expect(loopbackOnly(policy!)).toBe(true);
    }
    expect(T3BLACKOUT_SANDBOXED_CSP).toContain("script-src 'self'");
    expect(T3BLACKOUT_SANDBOXED_CSP).toContain("'unsafe-inline'");
    expect(T3BLACKOUT_SANDBOXED_CSP).not.toContain("sandbox");
  });
  it("leaves an inline PDF to the browser's viewer", () => {
    expect(csp("/work/paper.pdf")).toBeUndefined();
    expect(csp("/work/paper", { mimeType: "application/pdf" })).toBeUndefined();
  });
});

// assetFileResponse streams through HttpPlatform, as upstream's own file-response tests provide.
it.layer(Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer))("blackout MCP app CSP", (it) => {
  it.effect("serves an MCP app with its sandbox and the loopback-only policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-mcp-csp-" });
      const file = path.join(dir, "app-html");
      yield* fs.writeFileString(file, "<!doctype html><script>fetch('https://example.com/')</script>");
      const response = yield* assetFileResponse({ path: file, mimeType: "text/html", renderIntent: "mcp-app" });
      const policy = response.headers["content-security-policy"] ?? response.headers["Content-Security-Policy"];
      expect(policy).toBe(`sandbox allow-scripts allow-forms allow-popups allow-downloads, ${T3BLACKOUT_SANDBOXED_CSP}`);
    }).pipe(Effect.scoped),
  );
});
