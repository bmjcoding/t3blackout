// node --test test/: the tripwire's round-3 gaps, each tried for real against a
// local DNS server and HTTP receiver. BUILD3-02: a preload a child or worker is
// given must not run before the tripwire. BUILD3-03: a network client is known by
// the program that really runs (not the argv[0] it's shown as, nor a link's
// name), through env -S and sync calls with `shell`, and a wrapper form the
// tripwire can't read is refused. Each must reach nothing and be logged.
import { spawn, spawnSync } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TRIPWIRE = fs.realpathSync(new URL("../lib/files/tripwire.cjs", import.meta.url));
const CURL = ["/usr/bin/curl", "/opt/homebrew/bin/curl", "/usr/local/bin/curl"].find((file) => fs.existsSync(file));

/** A DNS server that answers NXDOMAIN and an HTTP receiver, counting what reaches them. */
async function receivers() {
  const seen = { dns: [], http: [] };
  const dns = dgram.createSocket("udp4");
  dns.on("message", (message, remote) => {
    seen.dns.push(message.subarray(12).toString("latin1"));
    const answer = Buffer.from(message);
    answer[2] = 0x81;
    answer[3] = 0x83;
    dns.send(answer, remote.port, remote.address);
  });
  const web = http.createServer((req, res) => {
    seen.http.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    dnsPort: dns.address().port,
    url: (name) => `http://127.0.0.1:${web.address().port}/${name}`,
    close: () => Promise.all([new Promise((r) => dns.close(r)), new Promise((r) => web.close(r))]),
  };
}

/** Runs `code` in a node with the tripwire (in NODE_OPTIONS, or on the command line with `cli`); resolves its logged attempts. */
async function tripped(code, { cli = false, dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-trip-")) } = {}) {
  const log = path.join(dir, "tripwire.jsonl");
  const child = spawn(process.execPath, [...(cli ? ["--require", TRIPWIRE] : []), "-e", code], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ...(cli ? {} : { NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}` }), T3BLACKOUT_TRIPWIRE_LOG: log },
    stdio: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** A preload that asks the local DNS server for `name` as soon as it's loaded (the reviewer's early-preload.cjs). */
function earlyPreload(dnsPort, name) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-pre-")), "early.cjs");
  fs.writeFileSync(file, `const r = new (require("node:dns").promises.Resolver)(); r.setServers(["127.0.0.1:${dnsPort}"]); r.resolve4(${JSON.stringify(name)}).catch(() => {});\n`);
  return file;
}

test("BUILD3-02: a preload given to a child in NODE_OPTIONS runs after the tripwire, even one listed before it", async () => {
  const net = await receivers();
  try {
    const child = (nodeOptions) => `require("node:child_process").spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { env: { NODE_OPTIONS: ${JSON.stringify(nodeOptions)} } });`;
    const first = earlyPreload(net.dnsPort, "child-first.invalid");
    const before = earlyPreload(net.dnsPort, "child-before.invalid");
    const esm = path.join(path.dirname(first), "early.mjs");
    fs.writeFileSync(esm, `import { promises } from "node:dns"; const r = new promises.Resolver(); r.setServers(["127.0.0.1:${net.dnsPort}"]); await r.resolve4("child-import.invalid").catch(() => {});\n`);
    for (const cli of [false, true]) {
      assert.deepEqual((await tripped(child(`--require ${first}`), { cli })).map((a) => a.host), ["child-first.invalid"]);
      // The tripwire already there, but after another preload: moved to the front.
      assert.deepEqual((await tripped(child(`-r ${before} --require ${JSON.stringify(TRIPWIRE)}`), { cli })).map((a) => a.host), ["child-before.invalid"]);
      assert.deepEqual((await tripped(child(`--import ${esm}`), { cli })).map((a) => a.host), ["child-import.invalid"]);
    }
    assert.deepEqual(net.seen.dns, []);
  } finally {
    await net.close();
  }
});

test("BUILD3-02: a preload in a worker's execArgv runs after the tripwire, with the tripwire on the command line or in NODE_OPTIONS", async () => {
  const net = await receivers();
  try {
    const pre = earlyPreload(net.dnsPort, "worker-pre.invalid");
    const worker = (execArgv) => `new (require("node:worker_threads").Worker)("setTimeout(() => {}, 200)", { eval: true, execArgv: ${JSON.stringify(execArgv)} });`;
    for (const cli of [true, false]) {
      assert.deepEqual((await tripped(worker(["--require", pre]), { cli })).map((a) => a.host), ["worker-pre.invalid"]);
      assert.deepEqual((await tripped(worker([`--require=${pre}`, "--require", TRIPWIRE]), { cli })).map((a) => a.host), ["worker-pre.invalid"]);
    }
    assert.deepEqual(net.seen.dns, []);
  } finally {
    await net.close();
  }
});

test("BUILD3-03: curl is known by the program that runs: argv0, a sync shell command line, env -S, a link, process.execve", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-curl-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(CURL, path.join(bin, "helper"));
  try {
    const cp = 'require("node:child_process")';
    const url = (name) => JSON.stringify(net.url(name));
    const quiet = "'-q', '-s', '--max-time', '3'";
    const cases = {
      argv0: `${cp}.spawn(${JSON.stringify(CURL)}, [${quiet}, ${url("argv0")}], { argv0: "helper" });`,
      argv0Sync: `${cp}.spawnSync(${JSON.stringify(CURL)}, [${quiet}, ${url("argv0-sync")}], { argv0: "helper" });`,
      syncShell: `${cp}.spawnSync(${JSON.stringify(`${CURL} -q -s --max-time 3 ${net.url("sync-shell")}`)}, { shell: true });`,
      execFileShell: `try { ${cp}.execFileSync("curl", ["-q", "-s", "--max-time", "3", ${url("exec-file-shell")}], { shell: "/bin/bash" }); } catch {}`,
      envSplit: `${cp}.spawn("/usr/bin/env", ["-S", ${JSON.stringify(`curl -q -s --max-time 3 ${net.url("env-split")}`)}]);`,
      envSplitAttached: `${cp}.spawnSync("/usr/bin/env", ["-iS'curl' -q", "-s", ${url("env-split-attached")}]);`,
      envSplitInShell: `${cp}.spawnSync("/bin/sh", ["-c", ${JSON.stringify(`env -S "curl -q -s" ${net.url("env-split-shell")}`)}]);`,
      link: `${cp}.spawnSync(${JSON.stringify(path.join(bin, "helper"))}, [${quiet}, ${url("link")}]);`,
      linkOnPath: `${cp}.spawnSync("helper", [${quiet}, ${url("link-path")}], { env: { PATH: ${JSON.stringify(`${bin}:/usr/bin:/bin`)} } });`,
      execve: `try { process.execve(${JSON.stringify(CURL)}, ["innocent", ${quiet}, ${url("execve")}]); } catch {}`,
    };
    for (const [name, code] of Object.entries(cases)) {
      const attempts = await tripped(code);
      assert.equal(attempts.length, 1, `${name}: ${JSON.stringify(attempts)}`);
      assert.equal(attempts[0].kind, "exec", name);
      assert.match(attempts[0].host, /^curl /, name);
    }
    assert.deepEqual(net.seen.http, []);
  } finally {
    await net.close();
  }
});

test("BUILD3-03: a wrapper form the tripwire can't read is refused; plain wrapper uses still run", async () => {
  const net = await receivers();
  try {
    const cp = 'require("node:child_process")';
    const cases = [
      ["/usr/bin/env", ["--frobnicate", "curl", net.url("unknown-option")]],
      ["/usr/bin/env", ["-S", `curl -q $URL ${net.url("dollar")}`]],
      ["/usr/bin/env", ["-S", `'curl ${net.url("unbalanced")}`]],
      ["/usr/bin/env", ["-S"]],
      ["nice", ["-x", "curl", net.url("nice")]],
    ];
    for (const [file, args] of cases) {
      const attempts = await tripped(`${cp}.spawnSync(${JSON.stringify(file)}, ${JSON.stringify(args)});`);
      assert.equal(attempts.length, 1, `${file} ${args.join(" ")}`);
      assert.match(attempts[0].host, /\(unreadable\)/, `${file} ${args.join(" ")}`);
    }
    assert.deepEqual(net.seen.http, []);
    // Ordinary wrapper uses aren't attempts, and run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-ok-"));
    const out = path.join(dir, "ran");
    const ok = [
      `${cp}.spawnSync("/usr/bin/env", ["-i", "A=1", "/usr/bin/touch", ${JSON.stringify(`${out}-env`)}]);`,
      `${cp}.spawnSync("/usr/bin/env", ["-S", ${JSON.stringify(`/usr/bin/touch '${out}-split'`)}]);`,
      `${cp}.spawnSync("nice", ["-n", "5", "/usr/bin/touch", ${JSON.stringify(`${out}-nice`)}]);`,
      `${cp}.execSync(${JSON.stringify(`nohup /usr/bin/touch ${out}-shell >/dev/null 2>&1`)});`,
    ];
    assert.deepEqual(await tripped(ok.join("\n")), []);
    for (const suffix of ["env", "split", "nice", "shell"]) assert.ok(fs.existsSync(`${out}-${suffix}`), suffix);
  } finally {
    await net.close();
  }
});

test("BUILD3-02: the NODE_OPTIONS a child gets starts with the tripwire, and a child without it still loads it once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-opts-"));
  const code = `require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(process.env.NODE_OPTIONS)"], { env: { NODE_OPTIONS: "--max-old-space-size=64" }, stdio: "inherit" });`;
  const result = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", code], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `--require ${JSON.stringify(TRIPWIRE)} --max-old-space-size=64`);
});
