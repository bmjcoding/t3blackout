// Injected by t3blackout as @t3tools/shared/t3blackoutCsp. The one
// Content-Security-Policy for everything the UI loads: only loopback (the local
// T3 server, or an SSH host's forwarded port) is reachable.
//
// The web build puts it in index.html's <meta> with its inline scripts' hashes
// (apps/web/vite/t3blackout-csp.ts). The server's static assets, the files it
// serves from grants, and the desktop's t3code:// protocol also send it as a
// header, because a worker loaded from a URL gets the policy of its own
// response, not the page's: without the header a worker could fetch anywhere.
// Sandboxed documents (agent HTML, MCP apps) keep their sandbox and get the
// same reach (T3BLACKOUT_SANDBOXED_CSP). A document gets both policies, and
// browsers enforce every policy they receive, so the header's 'unsafe-inline'
// never loosens the page's hashes.

const LOOPBACK_HTTP = ["http://127.0.0.1:*", "http://localhost:*"];
const LOOPBACK_WS = ["ws://127.0.0.1:*", "ws://localhost:*"];
const DESKTOP_SCHEMES = ["t3code:", "t3code-dev:"];

/**
 * `scripts`: inline script sources for script-src: the page's hashes, or
 * "'unsafe-inline'" for a header that also covers the page.
 */
export function t3blackoutContentSecurityPolicy(scripts: ReadonlyArray<string> = []): string {
  const local = ["'self'", ...DESKTOP_SCHEMES, ...LOOPBACK_HTTP];
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scripts, "'wasm-unsafe-eval'"].join(" "),
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
}

/** The response header for the server's static files and the desktop protocol. */
export const T3BLACKOUT_ASSET_CSP = t3blackoutContentSecurityPolicy(["'unsafe-inline'"]);

/**
 * A second policy for what the server shows under its own sandbox policy (agent
 * HTML, MCP apps, SVGs, downloads), sent in the same header after it: a header
 * may list several policies, and a browser enforces each one. The sandbox stays
 * as upstream wrote it; this adds the UI's loopback-only reach. Scripts may still
 * be inline or eval'd, as the sandbox alone allows.
 */
export const T3BLACKOUT_SANDBOXED_CSP = (() => {
  const local = ["'self'", ...DESKTOP_SCHEMES, ...LOOPBACK_HTTP];
  return [
    `default-src ${[...local, "data:", "blob:"].join(" ")}`,
    `script-src ${[...local, "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "data:", "blob:"].join(" ")}`,
    `style-src ${[...local, "'unsafe-inline'", "data:", "blob:"].join(" ")}`,
    `connect-src ${[...local, ...LOOPBACK_WS, "data:", "blob:"].join(" ")}`,
    "object-src 'none'",
    `base-uri ${local.join(" ")}`,
    `form-action ${local.join(" ")}`,
  ].join("; ");
})();

/**
 * The Content-Security-Policy header for a file the server serves from a grant
 * (assetResponseHeaders): upstream's sandbox policy, when it sets one, followed by
 * T3BLACKOUT_SANDBOXED_CSP; otherwise the UI's own policy, since a granted
 * script can be loaded as a worker. An inline PDF gets none: Chrome's PDF viewer
 * won't render under object-src 'none', and a PDF runs no page script.
 */
export function t3blackoutGrantedFileCsp(input: {
  readonly upstream: string | undefined;
  readonly contentType: string | undefined;
  readonly path: string;
}): string | undefined {
  if (input.upstream !== undefined) return `${input.upstream}, ${T3BLACKOUT_SANDBOXED_CSP}`;
  const type = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "application/pdf" || (type === undefined && /\.pdf$/i.test(input.path))) return undefined;
  return T3BLACKOUT_ASSET_CSP;
}
