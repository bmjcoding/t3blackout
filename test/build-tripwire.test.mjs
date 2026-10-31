// node --test test/: the network tripwire (lib/files/tripwire.cjs). Each case
// runs a Node process with it preloaded, as the smoke test does, and checks what
// was let through, what was refused and what reached the log. Nothing here
// touches the network: every blocked attempt is stopped before it's made.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const TRIPWIRE = fileURLToPath(new URL("../lib/files/tripwire.cjs", import.meta.url));

/** Runs `source` (CommonJS, or ESM with `esm`) under the tripwire; returns { out (its JSON), attempts }. */
function underTripwire(source, { esm = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-tripwire-")));
  const script = path.join(dir, esm ? "probe.mjs" : "probe.cjs");
  const log = path.join(dir, "tripwire.jsonl");
  fs.writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: dir, NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}`, T3BLACKOUT_TRIPWIRE_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: JSON.parse(result.stdout.trim().split("\n").at(-1)), attempts };
}

const hostsOf = (attempts) => attempts.map((a) => a.host).sort();

test("TCP: loopback addresses connect; other addresses and look-alike names are refused and logged", () => {
  const { out, attempts } = underTripwire(`
    const net = require("node:net");
    const server = net.createServer((s) => s.on("error", () => {}).end("hi")).listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      const tryConnect = (opts) => new Promise((resolve) => {
        const socket = net.connect(opts);
        socket.once("connect", () => { socket.destroy(); resolve("connected"); });
        socket.once("error", (e) => resolve(e.code));
      });
      const results = {
        loopback: await tryConnect({ host: "127.0.0.1", port }),
        localhost: await tryConnect({ host: "localhost", port, family: 4 }),
        public: await tryConnect({ host: "192.0.2.1", port: 9 }),
        prefix127: await tryConnect({ host: "127.collector.attacker.tld", port: 9 }),
        mdns: await tryConnect({ host: "elsewhere.local", port: 9 }),
        // localhost, but resolving somewhere else: the resolved address is checked.
        rebound: await tryConnect({ host: "localhost", port: 9, lookup: (h, o, cb) => cb(null, "203.0.113.9", 4) }),
      };
      server.close();
      console.log(JSON.stringify(results));
    });
  `);
  assert.deepEqual(out, { loopback: "connected", localhost: "connected", public: "ECONNREFUSED", prefix127: "ECONNREFUSED", mdns: "ECONNREFUSED", rebound: "ENOTFOUND" });
  assert.deepEqual(hostsOf(attempts), ["127.collector.attacker.tld", "192.0.2.1", "elsewhere.local", "localhost -> 203.0.113.9"]);
});

test("DNS: every resolver query, promise or callback, Resolver instances, reverse lookups", () => {
  const { out, attempts } = underTripwire(`
    const dns = require("node:dns");
    const outcome = (p) => p.then(() => "resolved", (e) => e.code);
    const viaCallback = (fn) => new Promise((resolve) => fn((e) => resolve(e ? e.code : "resolved")));
    (async () => {
      const results = {
        promiseResolver: await outcome(new dns.promises.Resolver().resolve4("tracker.example.org")),
        promiseResolveTxt: await outcome(dns.promises.resolveTxt("txt.example.org")),
        promiseReverse: await outcome(dns.promises.reverse("192.0.2.7")),
        promiseLookupService: await outcome(dns.promises.lookupService("192.0.2.8", 443)),
        callbackResolver: await viaCallback((cb) => new dns.Resolver().resolveMx("mx.example.org", cb)),
        callbackResolveSrv: await viaCallback((cb) => dns.resolveSrv("_x._tcp.example.org", cb)),
        lookupOther: await viaCallback((cb) => dns.lookup("lookup.example.org", cb)),
        promiseLookupOther: await outcome(dns.promises.lookup("plookup.example.org")),
        lookupLocalhost: await viaCallback((cb) => dns.lookup("localhost", cb)),
        promiseLookupLocalhost: await outcome(dns.promises.lookup("localhost", { all: true })),
      };
      console.log(JSON.stringify(results));
    })();
  `);
  assert.deepEqual(out, {
    promiseResolver: "ENOTFOUND",
    promiseResolveTxt: "ENOTFOUND",
    promiseReverse: "ENOTFOUND",
    promiseLookupService: "ENOTFOUND",
    callbackResolver: "ENOTFOUND",
    callbackResolveSrv: "ENOTFOUND",
    lookupOther: "ENOTFOUND",
    promiseLookupOther: "ENOTFOUND",
    lookupLocalhost: "resolved",
    promiseLookupLocalhost: "resolved",
  });
  assert.deepEqual(hostsOf(attempts), ["192.0.2.7", "192.0.2.8", "_x._tcp.example.org", "lookup.example.org", "mx.example.org", "plookup.example.org", "tracker.example.org", "txt.example.org"]);
});

test("ESM named imports of node:dns get the guarded functions too", () => {
  const { out, attempts } = underTripwire(
    `
    import { lookup, promises } from "node:dns";
    const a = await new Promise((resolve) => lookup("esm.example.org", (e) => resolve(e ? e.code : "resolved")));
    const b = await promises.resolve4("esm2.example.org").then(() => "resolved", (e) => e.code);
    console.log(JSON.stringify({ a, b }));
  `,
    { esm: true },
  );
  assert.deepEqual(out, { a: "ENOTFOUND", b: "ENOTFOUND" });
  assert.deepEqual(hostsOf(attempts), ["esm.example.org", "esm2.example.org"]);
});

test("UDP: a connected socket is checked at connect, sends at send", () => {
  const { out, attempts } = underTripwire(`
    const dgram = require("node:dgram");
    const connected = dgram.createSocket("udp4");
    connected.once("error", (e) => {
      const unconnected = dgram.createSocket("udp4");
      unconnected.send("x", 53, "192.0.2.2", (err) => {
        unconnected.close();
        connected.close();
        console.log(JSON.stringify({ connect: e.code, send: err && err.code }));
      });
    });
    connected.connect(53, "192.0.2.1");
  `);
  assert.deepEqual(out, { connect: "ECONNREFUSED", send: "ECONNREFUSED" });
  assert.deepEqual(hostsOf(attempts), ["192.0.2.1", "192.0.2.2"]);
});

test("BUILD-13: children and workers keep the tripwire, even given env: {}; network clients are blocked", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-git-")));
  spawnSync("git", ["init", "-q", repo]);
  const { out, attempts } = underTripwire(`
    const { spawnSync, execFileSync, execSync, spawn } = require("node:child_process");
    const { Worker } = require("node:worker_threads");
    const connectFrom = 'require("node:net").connect({ host: "192.0.2.3", port: 9 }).on("error", () => {});';
    const child = spawnSync(process.execPath, ["-e", connectFrom], { env: {}, encoding: "utf8" });
    const curl = spawnSync("curl", ["-s", "https://upload.example.org/x"], { encoding: "utf8" });
    let fetchStatus;
    try { execFileSync("git", ["-C", ${JSON.stringify(repo)}, "fetch", "https://example.org/repo.git"], { stdio: "ignore" }); fetchStatus = 0; } catch (e) { fetchStatus = e.status; }
    let shellStatus;
    try { execSync("true && wget -q https://wget.example.org/", { stdio: "ignore" }); shellStatus = 0; } catch (e) { shellStatus = e.status; }
    const status = spawnSync("git", ["-C", ${JSON.stringify(repo)}, "status", "--short"], { encoding: "utf8" }).status;
    const asyncCurl = new Promise((resolve) => spawn("curl", ["https://async.example.org"]).on("exit", resolve));
    const worker = new Promise((resolve) => new Worker(connectFrom, { eval: true, env: {} }).on("exit", resolve));
    Promise.all([asyncCurl, worker]).then(([asyncStatus]) => {
      setTimeout(() => console.log(JSON.stringify({ child: child.status, curl: curl.status, fetchStatus, shellStatus, status, asyncStatus })), 200);
    });
  `);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(out, { child: 0, curl: 126, fetchStatus: 126, shellStatus: 126, status: 0, asyncStatus: 126 });
  const kinds = attempts.map((a) => `${a.kind} ${a.host}`).sort();
  assert.deepEqual(kinds, [
    "connect 192.0.2.3",
    "connect 192.0.2.3",
    "exec curl https://async.example.org",
    "exec curl https://upload.example.org/x",
    "exec git fetch https://example.org/repo.git",
    "exec wget https://wget.example.org/",
  ]);
  // The child process's attempt carries its own pid: it ran with the tripwire.
  assert.equal(new Set(attempts.filter((a) => a.kind === "connect").map((a) => a.pid)).size >= 1, true);
});
