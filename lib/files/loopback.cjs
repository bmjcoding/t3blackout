// Whether an IP address is this machine (loopback, or unspecified: 0.0.0.0, ::),
// for the network tripwire (tripwire.cjs) and the host scan (lib/build.mjs).
// Plain CommonJS without side effects, so both can load it.

"use strict";
const net = require("node:net");

function isLoopbackAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(ip)) return ip.startsWith("127.") || ip === "0.0.0.0";
  if (!net.isIPv6(ip)) return false;
  let short;
  try {
    short = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return false; // a zone id (fe80::1%en0) is a link, not loopback
  }
  if (short === "::1" || short === "::") return true;
  // IPv4-mapped (::ffff:127.0.0.1 is written ::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(short);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16);
  return high >> 8 === 0x7f || (high === 0 && parseInt(mapped[2], 16) === 0);
}

module.exports = { isLoopbackAddress };
