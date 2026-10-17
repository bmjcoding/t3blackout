// Injected by t3blackout. Adds a fail-closed Content-Security-Policy <meta> to the
// built index.html so the UI can only reach loopback (the local T3 server),
// in a plain browser and in Electron alike. Browsers enforce every policy they
// receive, so this also tightens the desktop's own permissive header policy.
//
// Remote images, third-party favicons, CDN icons and anything upstream adds
// later fail here first; their existing UI fallbacks take over.

import { createHash } from "node:crypto";
import type { Plugin } from "vite-plus";

const LOOPBACK_HTTP = ["http://127.0.0.1:*", "http://localhost:*"];
const LOOPBACK_WS = ["ws://127.0.0.1:*", "ws://localhost:*"];
const DESKTOP_SCHEMES = ["t3code:", "t3code-dev:"];

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

export function t3blackoutCspPlugin(): Plugin {
  return {
    name: "t3blackout-csp",
    // Dev needs Vite's inline preamble and HMR socket; only builds ship.
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const inlineHashes = [...html.matchAll(INLINE_SCRIPT)].map(
          (match) => `'sha256-${createHash("sha256").update(match[1] ?? "").digest("base64")}'`,
        );
        const local = ["'self'", ...DESKTOP_SCHEMES, ...LOOPBACK_HTTP];
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${inlineHashes.join(" ")} 'wasm-unsafe-eval'`,
          `connect-src ${[...local, ...LOOPBACK_WS, "blob:"].join(" ")}`,
          `img-src ${[...local, "data:", "blob:"].join(" ")}`,
          `media-src ${[...local, "data:", "blob:"].join(" ")}`,
          `font-src ${[...local, "data:"].join(" ")}`,
          `frame-src ${[...local, "data:", "blob:"].join(" ")}`,
          "style-src 'self' 'unsafe-inline'",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; ");
        return html.replace(
          /<head>/i,
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        );
      },
    },
  };
}
