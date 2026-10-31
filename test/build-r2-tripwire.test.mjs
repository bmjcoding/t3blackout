// node --test test/: the tripwire's round-2 gaps (BUILD2-06, BUILD2-07), each
// tried for real against a local DNS server and HTTP receiver: a path that
// only mentions the tripwire in NODE_OPTIONS, workers started without it, and
// network clients behind wrappers or given only options. Each must be blocked
// (nothing reaches the receivers) and logged.
import { spawn } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TRIPWIRE = fs.realpathSync(new URL("../lib/files/tripwire.cjs", import.meta.url));

/** A DNS server that answers NXDOMAIN and an HTTP receiver, counting what reaches them. */
async function receivers() {
  const dns = dgram.createSocket("udp4");
  const http_ = http.createServer((req, res) => {
    seen.http.push(req.url);
    res.end("ok");
  });
  const seen = { dns: 0, http: [] };
  dns.on("message", (message, remote) => {
    seen.dns++;
    const answer = Buffer.from(message);
    answer[2] = 0x81;
    answer[3] = 0x83;
    dns.send(answer, remote.port, remote.address);
  });
  await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => http_.listen(0, "127.0.0.1", resolve));
  return { seen, dnsPort: dns.address().port, httpPort: http_.address().port, close: () => Promise.all([new Promise((r) => dns.close(r)), new Promise((r) => http_.close(r))]) };
}

/** Runs `code` in a node with the tripwire (via NODE_OPTIONS, or `cli` on the command line); resolves its logged attempts. */
async function tripped(code, { cli = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-trip-"));
  const log = path.join(dir, "tripwire.jsonl");
  const child = spawn(process.execPath, [...(cli ? ["--require", TRIPWIRE] : []), "-e", code], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, NODE_OPTIONS: cli ? "" : `--require ${JSON.stringify(TRIPWIRE)}`, T3BLACKOUT_TRIPWIRE_LOG: log },
    stdio: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return attempts;
}

const query = (dnsPort, name) => `const r = new (require('node:dns').promises.Resolver)(); r.setServers(['127.0.0.1:${dnsPort}']); r.resolve4('${name}').catch(() => {});`;

test("BUILD2-06: a child whose NODE_OPTIONS only mentions the tripwire's path gets a real --require of it", async () => {
  const net = await receivers();
  try {
    const child = query(net.dnsPort, "child-title.invalid");
    const attempts = await tripped(`require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}], { env: { NODE_OPTIONS: '--title=${TRIPWIRE}' } });`);
    assert.equal(net.seen.dns, 0);
    assert.deepEqual(attempts.map((a) => a.host), ["child-title.invalid"]);
  } finally {
    await net.close();
  }
});

test("BUILD2-06: workers keep the tripwire with execArgv: [], a cleared NODE_OPTIONS, or a command-line-only preload", async () => {
  const net = await receivers();
  try {
    const worker = (name, options) => `const { Worker } = require('node:worker_threads'); new Worker(${JSON.stringify(query(net.dnsPort, name))}, { eval: true, ${options} });`;
    assert.deepEqual((await tripped(worker("w-empty.invalid", "execArgv: []"))).map((a) => a.host), ["w-empty.invalid"]);
    assert.deepEqual((await tripped(`delete process.env.NODE_OPTIONS; ${worker("w-cleared.invalid", "execArgv: []")}`)).map((a) => a.host), ["w-cleared.invalid"]);
    assert.deepEqual((await tripped(worker("w-cli.invalid", "execArgv: []"), { cli: true })).map((a) => a.host), ["w-cli.invalid"]);
    assert.deepEqual((await tripped(worker("w-own-env.invalid", "env: {}, execArgv: []"))).map((a) => a.host), ["w-own-env.invalid"]);
    assert.equal(net.seen.dns, 0);
  } finally {
    await net.close();
  }
});

test("BUILD2-07: network clients behind env or exec, or given only a config file, are blocked; version and lookups aren't", async () => {
  const net = await receivers();
  const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-curl-")), "curl.conf");
  fs.writeFileSync(config, `url = "http://127.0.0.1:${net.httpPort}/config"\nmax-time = 3\nsilent\n`);
  try {
    const url = (name) => `http://127.0.0.1:${net.httpPort}/${name}`;
    const cp = "require('node:child_process')";
    const cases = [
      `${cp}.spawnSync('/usr/bin/env', ['curl', '--max-time', '3', '-s', '${url("env")}']);`,
      `${cp}.spawnSync('/usr/bin/env', ['-i', 'A=1', 'curl', '-s', '${url("env-i")}']);`,
      `try { ${cp}.execSync('exec /usr/bin/curl --max-time 3 -s ${url("exec")}'); } catch {}`,
      `${cp}.spawnSync('curl', ['-q', '-K${config}']);`,
      `${cp}.spawnSync('/bin/sh', ['-lc', 'X=1 nohup timeout 5 curl -s ${url("wrapped")}']);`,
      `${cp}.spawnSync('/bin/sh', ['-c', 'echo $(curl -s ${url("subst")})']);`,
    ];
    for (const code of cases) {
      const attempts = await tripped(code);
      assert.equal(attempts.length, 1, code);
      assert.equal(attempts[0].kind, "exec", code);
      assert.match(attempts[0].host, /^curl /, code);
    }
    assert.deepEqual(net.seen.http, []);
    // Asking for a version, or whether a command exists, reaches nothing and isn't an attempt.
    assert.deepEqual(await tripped(`${cp}.spawnSync('curl', ['--version']); ${cp}.spawnSync('/bin/sh', ['-c', 'command -v curl >/dev/null']);`), []);
  } finally {
    await net.close();
  }
});
