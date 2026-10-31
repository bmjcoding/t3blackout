// node --test test/*.test.mjs: Content-Security-Policy doesn't cover WebRTC, so the desktop's boot
// block (lib/files/boot-env.ts, rule desktop/boot-env) keeps it off the network (APP3-01, decision L):
// no web contents sends WebRTC over UDP, and the app's session sends TURN and ICE over TCP to a
// proxy that refuses them. With T3BLACKOUT_TEST_ELECTRON=<an Electron binary> it also runs a real
// probe: a sandboxed, opaque-origin frame under T3 Blackout's sandbox CSP aims STUN, TURN and ICE
// at local UDP and TCP listeners, without and with the boot block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";

const BOOT = new URL("../lib/files/boot-env.ts", import.meta.url);
const block = () => {
  const match = /^\{\n[\s\S]*^\}\n/m.exec(fs.readFileSync(BOOT, "utf8"));
  assert.ok(match, "lib/files/boot-env.ts must be one { ... } block");
  return stripTypeScriptTypes(match[0]);
};

/** Runs the boot block in the Electron main process as faked here; returns what it set up. */
function boot({ runAsNode = false, failProxy = false } = {}) {
  const listeners = new Map();
  const proxies = [];
  const exits = [];
  const electron = {
    app: {
      on: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
      once: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
      exit: (code) => exits.push(code),
    },
    session: {
      defaultSession: {
        setProxy: async (config) => {
          proxies.push(config);
          if (failProxy) throw new Error("no proxy for you");
        },
      },
    },
  };
  const real = createRequire(import.meta.url);
  vm.runInNewContext(block(), {
    require: (id) => (id === "electron" ? electron : real(id)),
    process: { ...(runAsNode ? {} : { type: "browser" }), platform: "darwin", env: {} },
    console: { error: () => {} },
  });
  const emit = (name, ...args) => (listeners.get(name) ?? []).forEach((listener) => listener(...args));
  return { emit, proxies, exits, listens: (name) => listeners.has(name) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("every web contents gets the WebRTC policy that sends no UDP", () => {
  const app = boot();
  const policies = [];
  for (let i = 0; i < 3; i++) app.emit("web-contents-created", {}, { setWebRTCIPHandlingPolicy: (policy) => policies.push(policy) });
  assert.deepEqual(policies, ["disable_non_proxied_udp", "disable_non_proxied_udp", "disable_non_proxied_udp"]);
});

test("the app's session proxies to a loopback port this process holds, which refuses every connection", async () => {
  const app = boot();
  app.emit("ready");
  await settle();
  assert.equal(app.proxies.length, 1);
  const [{ mode, proxyRules, ...rest }] = app.proxies;
  assert.equal(mode, "fixed_servers");
  assert.deepEqual(rest, {}, "no bypass list beyond Chromium's own for loopback");
  const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(proxyRules)?.[1]);
  assert.ok(port > 0, proxyRules);
  const received = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.write("CONNECT 192.0.2.1:3478 HTTP/1.1\r\nHost: 192.0.2.1:3478\r\n\r\n");
    socket.on("error", () => {});
    socket.on("close", () => resolve(data));
    setTimeout(() => reject(new Error("the refusing proxy kept the connection open")), 2000).unref();
  });
  assert.equal(received, "", "nothing tunnels through it");
  assert.deepEqual(app.exits, []);
});

test("an app whose session can't take the proxy doesn't run", async () => {
  const app = boot({ failProxy: true });
  app.emit("ready");
  await settle();
  assert.deepEqual(app.exits, [1]);
});

test("outside the Electron main process (ELECTRON_RUN_AS_NODE) it sets nothing up", () => {
  const app = boot({ runAsNode: true });
  assert.equal(app.listens("web-contents-created"), false);
  assert.equal(app.listens("ready"), false);
});

// ------------------------------------------------------------------ real probe --

const MAIN = `
const { app, BrowserWindow } = require("electron");
const [mode, url, bootFile] = process.argv.slice(-3);
if (mode === "boot") {
  const source = require("node:fs").readFileSync(bootFile, "utf8");
  eval(require("node:module").stripTypeScriptTypes(/^\\{\\n[\\s\\S]*^\\}\\n/m.exec(source)[0]));
}
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on("console-message", (event, level, message) => {
    const text = typeof message === "string" ? message : event.message;
    if (!text?.startsWith("PROBE ")) return;
    console.log(text);
    if (text === "PROBE done") setTimeout(() => app.quit(), 1000);
  });
  win.loadURL(url);
  setTimeout(() => app.quit(), 60000);
});
`;

// Each probe aims at a non-loopback address of this machine: STUN and TURN over UDP and TCP,
// remote UDP and ICE-TCP candidates. Then a fetch to loopback, which the app's window needs.
const FRAME = `
const q = new URLSearchParams(location.search);
const ip = q.get("ip"), udp = q.get("udp"), tcp = q.get("tcp"), web = q.get("web");
const log = (...parts) => console.log(["PROBE", ...parts].join(" "));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function gather(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.createDataChannel("x");
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => { pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve(); setTimeout(resolve, 5000); });
  pc.close();
}
async function remote(candidate) {
  const pc = new RTCPeerConnection();
  pc.createDataChannel("x");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = offer.sdp.replace(/a=setup:actpass/g, "a=setup:active").replace(/a=ice-ufrag:.*/g, "a=ice-ufrag:abcd").replace(/a=ice-pwd:.*/g, "a=ice-pwd:abcdefghijklmnopqrstuvwx");
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  await pc.addIceCandidate({ candidate, sdpMid: "0", sdpMLineIndex: 0 });
  await wait(5000);
  pc.close();
}
(async () => {
  log("origin", String(origin));
  try {
    await gather([{ urls: "stun:" + ip + ":" + udp }]);
    await gather([{ urls: "turn:" + ip + ":" + udp + "?transport=udp", username: "u", credential: "p" }]);
    await gather([{ urls: "turn:" + ip + ":" + tcp + "?transport=tcp", username: "u", credential: "p" }]);
    await remote("candidate:1 1 udp 2122260223 " + ip + " " + udp + " typ host generation 0");
    await remote("candidate:2 1 tcp 1518280447 " + ip + " " + tcp + " typ host tcptype passive generation 0");
  } catch (error) {
    log("error", String(error));
  }
  const ping = await fetch("http://127.0.0.1:" + web + "/ping").then((r) => r.status, () => "failed");
  log("loopback", String(ping));
  log("done");
})();
`;

const electron = process.env.T3BLACKOUT_TEST_ELECTRON;
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

test("a real Electron frame reaches local listeners over WebRTC without the boot block, and nothing with it", { skip: !electron ? "set T3BLACKOUT_TEST_ELECTRON to an Electron binary" : !lan ? "no non-loopback IPv4 address" : false, timeout: 180_000 }, async () => {
  const { T3BLACKOUT_SANDBOXED_CSP } = await import(new URL("../lib/files/t3blackoutCsp.ts", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-webrtc-"));
  fs.writeFileSync(path.join(dir, "main.cjs"), MAIN);
  let udpHits = 0;
  let tcpHits = 0;
  let pings = 0;
  const udp = dgram.createSocket("udp4").on("message", () => udpHits++);
  await new Promise((resolve) => udp.bind(0, "0.0.0.0", resolve));
  const tcp = net.createServer((socket) => {
    tcpHits++;
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve) => tcp.listen(0, "0.0.0.0", resolve));
  const web = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/ping") {
      pings++;
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
    } else if (url.pathname === "/frame") {
      // The headers the server gives an agent's HTML preview (t3blackoutGrantedFileCsp).
      res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-downloads, ${T3BLACKOUT_SANDBOXED_CSP}` });
      res.end(`<!doctype html><script>${FRAME}</script>`);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><iframe src="http://localhost:${web.address().port}/frame${url.search}"></iframe>`);
    }
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const query = new URLSearchParams({ ip: lan, udp: String(udp.address().port), tcp: String(tcp.address().port), web: String(web.address().port) });
  const run = async (mode) => {
    udpHits = 0;
    tcpHits = 0;
    pings = 0;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ELECTRON_")));
    const lines = await new Promise((resolve) => {
      const out = [];
      const child = spawn(electron, [path.join(dir, "main.cjs"), mode, `http://127.0.0.1:${web.address().port}/?${query}`, BOOT.pathname], { env, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (chunk) => out.push(...String(chunk).split("\n").filter((line) => line.startsWith("PROBE"))));
      child.on("close", () => resolve(out));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { udp: udpHits, tcp: tcpHits, pings, lines };
  };
  try {
    const without = await run("none");
    assert.ok(without.lines.includes("PROBE origin null"), `the frame ran with an opaque origin: ${without.lines.join(" | ")}`);
    assert.ok(without.udp > 0 && without.tcp > 0, `the probe reaches the listeners without the boot block: ${JSON.stringify(without)}`);
    const withBoot = await run("boot");
    assert.ok(withBoot.lines.includes("PROBE done"), withBoot.lines.join(" | "));
    assert.deepEqual({ udp: withBoot.udp, tcp: withBoot.tcp }, { udp: 0, tcp: 0 }, `nothing leaves over WebRTC: ${withBoot.lines.join(" | ")}`);
    assert.ok(withBoot.lines.includes("PROBE loopback 204") && withBoot.pings === 1, "loopback, all the app's window talks to, still works");
  } finally {
    udp.close();
    tcp.close();
    web.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
