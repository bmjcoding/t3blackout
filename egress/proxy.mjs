#!/usr/bin/env node
// Fail-closed egress proxy for the sandboxed T3 Code build.
//
// The Seatbelt profile only lets the app talk to loopback, so this proxy is the
// sole path off the machine. Every destination is checked against
// egress/allowlist.txt; anything else gets a 403 and a "deny" log line.
//
// Zero dependencies on purpose: this file is the trust boundary, keep it small
// enough to read in one sitting.
//
// Usage: node egress/proxy.mjs [--port 18080] [--allowlist path] [--log path]

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { parseArgs } from "node:util";

const here = path.dirname(new URL(import.meta.url).pathname);
const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.T3BLACKOUT_PROXY_PORT ?? "18080" },
    allowlist: { type: "string", default: path.join(here, "allowlist.txt") },
    log: { type: "string", default: "" },
  },
});

const ALLOWED_PORTS = new Set([443, 80]);

/** Parses `host` / `*.suffix` / `host:port` lines. `#` starts a comment. */
function loadAllowlist(file) {
  const exact = new Set();
  const suffixes = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*/, "").trim().toLowerCase();
    if (!line) continue;
    if (line.startsWith("*.")) suffixes.push(line.slice(1));
    else exact.add(line);
  }
  return { exact, suffixes };
}

let allowlist = loadAllowlist(args.allowlist);
fs.watchFile(args.allowlist, { interval: 2000 }, () => {
  try {
    allowlist = loadAllowlist(args.allowlist);
    log({ event: "allowlist-reloaded" });
  } catch (error) {
    // Keep the previous list rather than failing open or crashing.
    log({ event: "allowlist-reload-failed", error: String(error) });
  }
});

const logStream = args.log ? fs.createWriteStream(args.log, { flags: "a" }) : null;
function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  if (logStream) logStream.write(line + "\n");
  if (entry.decision === "deny" || !logStream) process.stderr.write(line + "\n");
}

function isAllowed(host, port) {
  const h = host.toLowerCase().replace(/\.$/, "");
  // An explicit `host:port` entry is the only way to open a port besides 80/443
  // (e.g. `github.com:22` for git over SSH via the launcher's ProxyCommand).
  if (allowlist.exact.has(`${h}:${port}`)) return true;
  if (!ALLOWED_PORTS.has(port)) return false;
  // IP literals bypass name-based policy, so they must be listed explicitly.
  if (allowlist.exact.has(h)) return true;
  if (net.isIP(h)) return false;
  return allowlist.suffixes.some((suffix) => h.endsWith(suffix));
}

function splitHostPort(authority, defaultPort) {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(authority);
  if (!match) return null;
  return { host: match[1], port: match[2] ? Number(match[2]) : defaultPort };
}

const server = http.createServer((req, res) => {
  // Plain-HTTP forward proxying (absolute-form request target).
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end("t3blackout egress: absolute URL required\n");
    return;
  }
  const port = Number(target.port || 80);
  if (target.protocol !== "http:" || !isAllowed(target.hostname, port)) {
    log({ decision: "deny", kind: "http", host: target.hostname, port, method: req.method });
    res.writeHead(403).end("t3blackout egress: destination not allowlisted\n");
    return;
  }
  log({ decision: "allow", kind: "http", host: target.hostname, port, method: req.method });
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = http.request(
    { host: target.hostname, port, method: req.method, path: target.pathname + target.search, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", () => res.destroy());
  req.pipe(upstream);
});

server.on("connect", (req, clientSocket, head) => {
  const target = splitHostPort(req.url ?? "", 443);
  if (!target || !isAllowed(target.host, target.port)) {
    log({ decision: "deny", kind: "connect", host: target?.host ?? req.url, port: target?.port });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  log({ decision: "allow", kind: "connect", host: target.host, port: target.port });
  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", close);
  clientSocket.on("error", close);
});

server.on("clientError", (_error, socket) => socket.destroy());

server.listen(Number(args.port), "127.0.0.1", () => {
  log({ event: "listening", port: Number(args.port), allowlist: args.allowlist });
});
