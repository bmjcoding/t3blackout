// node --test test/: the smoke test's process handling (lib/smoke.mjs
// observeServer), against small fixture servers: a server that dies, by an exit
// code or by a signal, after answering fails the check (BUILD-03), and a server
// that ignores SIGTERM is still stopped.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeExit, observeServer, readAttempts, tripwireOptions } from "../lib/smoke.mjs";
import { freePort } from "../lib/util.mjs";

/** A fixture server: answers GET / with `html` on `port`, then does `after` (JS run after `delay` ms). */
function fixture(dir, { after = "", delay = 300, html = "<meta http-equiv=\"Content-Security-Policy\">" } = {}) {
  const file = path.join(dir, "server.cjs");
  fs.writeFileSync(
    file,
    `const http = require("node:http");
const port = Number(process.argv[2]);
http.createServer((req, res) => res.end(${JSON.stringify(html)})).listen(port, "127.0.0.1", () => {
  setTimeout(() => { ${after} }, ${delay});
});`,
  );
  return file;
}

async function observe(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-smoke-"));
  const port = await freePort();
  const out = fs.openSync(path.join(dir, "out.log"), "w");
  try {
    return await observeServer({ args: [fixture(dir, options), String(port)], env: { PATH: process.env.PATH }, port, out, observeMs: 2500, startupMs: 5000, ...options.observe });
  } finally {
    fs.closeSync(out);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a server that answers and keeps running passes, and is stopped", async () => {
  const html = await observe({});
  assert.match(html, /Content-Security-Policy/);
});

test("BUILD-03: a server killed by a signal after its first answer fails the smoke test", async () => {
  for (const signal of ["SIGTERM", "SIGKILL", "SIGSEGV"]) {
    // Dies after its first answer (polled about once a second), while it's watched.
    await assert.rejects(observe({ delay: 1600, after: `process.kill(process.pid, "${signal}")` }), new RegExp(`was killed by ${signal} after it answered`), signal);
  }
});

test("a server that exits on its own, before or after answering, fails", async () => {
  await assert.rejects(observe({ delay: 1600, after: "process.exit(3)" }), /exited with 3 after it answered/);
  await assert.rejects(observe({ after: "", delay: 0, observe: { args: ["-e", "process.exit(4)"] } }), /exited with 4 during the smoke test/);
});

test("a server that never answers fails at the startup deadline", async () => {
  await assert.rejects(observe({ observe: { args: ["-e", "setInterval(() => {}, 1000)"], startupMs: 1500 } }), /never answered/);
});

test("a server that stops answering while watched fails", async () => {
  await assert.rejects(observe({ after: "process.removeAllListeners(); require('node:http').globalAgent; for (const h of process._getActiveHandles()) if (h.close) h.close();" }), /stopped answering|exited with 0/);
});

test("the check runs on the first answer, and a server ignoring SIGTERM is still stopped", async () => {
  await assert.rejects(observe({ html: "no csp", observe: { check: (html) => assert.ok(html.includes("Content-Security-Policy"), "missing CSP") } }), /missing CSP/);
  const started = Date.now();
  await observe({ after: "process.on('SIGTERM', () => {})" });
  assert.ok(Date.now() - started < 15_000);
});

test("helpers: exits are described, attempts read, the tripwire path is quoted", () => {
  assert.equal(describeExit({ code: null, signal: "SIGTERM" }), "was killed by SIGTERM");
  assert.equal(describeExit({ code: 2, signal: null }), "exited with 2");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-smoke-"));
  fs.writeFileSync(path.join(dir, "t.jsonl"), '{"kind":"dns","host":"a.example.org","port":null,"pid":1}\n');
  assert.deepEqual(readAttempts(path.join(dir, "t.jsonl")), [{ kind: "dns", host: "a.example.org", port: null, pid: 1 }]);
  assert.deepEqual(readAttempts(path.join(dir, "missing.jsonl")), []);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(tripwireOptions(), /^--require "\/.+tripwire\.cjs"$/);
});
