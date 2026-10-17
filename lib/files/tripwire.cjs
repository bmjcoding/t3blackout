// Network tripwire for the update smoke test, loaded via NODE_OPTIONS=--require.
//
// Blocks every non-loopback connection attempt (TCP, TLS, HTTP, fetch, WebSocket,
// UDP) and every DNS lookup for a non-local name, and appends each one to
// $T3BLACKOUT_TRIPWIRE_LOG. NODE_OPTIONS is inherited, so child Node processes
// are covered too. Native code and non-Node programs are not; the smoke test
// hides harness credentials so the only traffic left to catch is T3's own.

"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");
const os = require("node:os");

const LOG = process.env.T3BLACKOUT_TRIPWIRE_LOG;
const localNames = new Set(["localhost", "", os.hostname().toLowerCase()]);

function isLocal(host) {
  if (host === undefined || host === null) return true;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");
  if (localNames.has(h) || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  return /^127\./.test(h);
}

function record(kind, host, port) {
  const line = JSON.stringify({ kind, host: String(host), port: port ?? null, pid: process.pid });
  try {
    if (LOG) fs.appendFileSync(LOG, line + "\n");
  } catch {}
}

function refused(host) {
  return Object.assign(new Error(`t3blackout tripwire: blocked connection to ${host}`), {
    code: "ECONNREFUSED",
  });
}

// net.connect, tls.connect, http(s), undici/fetch and WebSocket all end here.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  let host;
  let port;
  if (options !== null && typeof options === "object") {
    if (options.path) return originalConnect.apply(this, args); // unix socket
    host = options.host ?? options.hostname;
    port = options.port;
  } else if (typeof first === "string" && Number.isNaN(Number(first))) {
    return originalConnect.apply(this, args); // unix socket path
  } else {
    port = first;
    host = typeof args[1] === "string" ? args[1] : undefined;
  }
  if (isLocal(host ?? "localhost")) return originalConnect.apply(this, args);
  record("connect", host, port);
  process.nextTick(() => this.destroy(refused(host)));
  return this;
};

function guardLookup(original, kind) {
  return function (hostname, ...rest) {
    if (isLocal(hostname)) return original.call(this, hostname, ...rest);
    record(kind, hostname);
    const callback = rest.find((arg) => typeof arg === "function");
    const error = Object.assign(new Error(`t3blackout tripwire: blocked lookup of ${hostname}`), {
      code: "ENOTFOUND",
      hostname,
    });
    if (callback) process.nextTick(() => callback(error));
  };
}
dns.lookup = guardLookup(dns.lookup, "dns");
for (const name of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt"]) {
  dns[name] = guardLookup(dns[name], "dns");
}
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function (hostname, ...rest) {
  if (isLocal(hostname)) return originalPromiseLookup.call(this, hostname, ...rest);
  record("dns", hostname);
  return Promise.reject(Object.assign(new Error(`t3blackout tripwire: blocked lookup of ${hostname}`), { code: "ENOTFOUND" }));
};

const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = args.find((arg, i) => i > 0 && typeof arg === "string");
  if (address !== undefined && !isLocal(address)) {
    record("udp", address);
    return;
  }
  return originalSend.apply(this, args);
};
