// Injected by t3blackout. Adds a fail-closed Content-Security-Policy <meta> to the
// built index.html so the UI can only reach loopback (the local T3 server),
// in a plain browser and in Electron alike. Browsers enforce every policy they
// receive, so this also tightens the desktop's own header policy. The policy
// itself is @t3tools/shared/t3blackoutCsp, which the server and the desktop
// also send as a header (workers get only their own response's policy).
//
// Remote images, third-party favicons, CDN icons and anything upstream adds
// later fail here first; their existing UI fallbacks take over.

import { createHash } from "node:crypto";
import { t3blackoutContentSecurityPolicy } from "@t3tools/shared/t3blackoutCsp";
import type { Plugin } from "vite-plus";

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
        const policy = t3blackoutContentSecurityPolicy(inlineHashes);
        return html.replace(
          /<head>/i,
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        );
      },
    },
  };
}
