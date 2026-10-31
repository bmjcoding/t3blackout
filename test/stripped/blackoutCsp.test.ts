// Copied to packages/shared/src/ in a stripped upstream checkout and run there
// (rules shared/csp-policy-file, server/static-assets-csp, desktop/protocol-csp, web/csp-plugin-file).
import { describe, expect, it } from "vite-plus/test";

import { T3BLACKOUT_ASSET_CSP, t3blackoutContentSecurityPolicy } from "./t3blackoutCsp.ts";

const directives = (policy: string) =>
  new Map(policy.split("; ").map((directive) => [directive.split(" ")[0]!, directive.split(" ").slice(1)] as const));

describe("blackout CSP", () => {
  it("reaches only this app and loopback", () => {
    const policy = directives(T3BLACKOUT_ASSET_CSP);
    for (const name of ["connect-src", "img-src", "media-src", "font-src", "frame-src"]) {
      for (const source of policy.get(name)!) {
        expect(source).toMatch(/^(?:'self'|t3code:|t3code-dev:|(?:http|ws):\/\/(?:127\.0\.0\.1|localhost):\*|data:|blob:)$/);
      }
    }
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("worker-src")).toEqual(["'self'", "blob:"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
  });
  it("puts the page's inline hashes in script-src, and never eval", () => {
    const page = directives(t3blackoutContentSecurityPolicy(["'sha256-abc'"]));
    expect(page.get("script-src")).toEqual(["'self'", "'sha256-abc'", "'wasm-unsafe-eval'"]);
    expect(directives(T3BLACKOUT_ASSET_CSP).get("script-src")).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
  });
});
