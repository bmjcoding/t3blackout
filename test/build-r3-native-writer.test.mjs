// node --test test/: the app's native-file writer keeps every write inside the
// install folder on its own (SUPPLY3-03, decision J): whatever package path the
// lock gives and whatever file path the manifest lists, it writes only to a
// plain node_modules package path, through real folders, and never through a
// link. Exercised for real (node -e, as DeviceToolchain.ts runs it) against a
// local HTTP server with a reviewed, hash-matching archive.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { BLACKOUT_NATIVE_ASSETS_SCRIPT } from "../lib/files/blackoutNativeAssets.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "linuxmusl" : process.platform;
const BINARY = Buffer.from("native binary\u0000");

/** A .tar.gz holding build/Release/x.node (and `extra` files), made with the system tar. */
function tarball(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-writer-src-"));
  const files = { "build/Release/x.node": BINARY, ...extra };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const out = path.join(dir, "..", `${path.basename(dir)}.tar.gz`);
  const made = spawnSync("tar", ["-czf", out, "-C", dir, ...Object.keys(files)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const bytes = fs.readFileSync(out);
  fs.rmSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Serves `bytes` at /x.tar.gz on 127.0.0.1, counting requests; resolves { url, hits, close }. */
async function serve(bytes) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    res.writeHead(req.url === "/x.tar.gz" ? 200 : 404).end(req.url === "/x.tar.gz" ? bytes : "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/x.tar.gz`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the app's installer on `dir` for one package at `where` (its lock path); resolves { status, stderr }. */
function install(dir, where, url, archive, files = { "build/Release/x.node": sha256(BINARY) }) {
  const needs = [{ path: where, package: "native@1.0.0" }];
  const assets = [{ path: where, package: "native@1.0.0", platform, arch: process.arch, url, sha256: sha256(archive), files }];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", BLACKOUT_NATIVE_ASSETS_SCRIPT, dir, JSON.stringify(assets), JSON.stringify(needs)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

/** A scratch parent with the install folder `dir` in it, and every file found under the parent afterwards. */
function scratch() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r3-writer-")));
  const dir = path.join(parent, "install");
  fs.mkdirSync(path.join(dir, "node_modules", "native"), { recursive: true });
  const files = () => {
    const found = [];
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(parent, full) + (entry.isSymbolicLink() ? " (link)" : ""));
      }
    };
    walk(parent);
    return found.sort();
  };
  return { parent, dir, files };
}

test("SUPPLY3-03: a lock path that isn't a plain node_modules package path writes nothing, anywhere", { timeout: 60_000 }, async () => {
  const archive = tarball();
  const server = await serve(archive);
  try {
    const { dir, files } = scratch();
    for (const where of [
      "node_modules/../../escaped", // the reviewer's
      "node_modules/native/../../../escaped",
      "/tmp/escaped",
      "escaped",
      "node_modules",
      "node_modules/.bin",
      "node_modules/@scope/../escaped",
      "node_modules/native//x",
      "node_modules/native/build",
      "node_modules/..\\..\\escaped",
    ]) {
      const done = await install(dir, where, server.url, archive);
      assert.notEqual(done.status, 0, where);
      assert.match(done.stderr, /refuses to write native files/, where);
    }
    assert.equal(server.state.hits, 0);
    assert.deepEqual(files(), []);
    // Plain, scoped and nested package paths are fine.
    for (const where of ["node_modules/native", "node_modules/@scope/native", "node_modules/a/node_modules/@s/b"]) {
      const done = await install(dir, where, server.url, archive);
      assert.equal(done.status, 0, `${where}: ${done.stderr}`);
      assert.deepEqual(fs.readFileSync(path.join(dir, where, "build/Release/x.node")), BINARY);
    }
  } finally {
    await server.close();
  }
});

test("SUPPLY3-03: a manifest file path with .. is refused by the writer itself", { timeout: 60_000 }, async () => {
  const archive = tarball();
  const server = await serve(archive);
  try {
    const { dir, files } = scratch();
    const done = await install(dir, "node_modules/native", server.url, archive, { "../../escaped.node": sha256(BINARY) });
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /refuses to write native files/);
    assert.deepEqual(files(), []);
  } finally {
    await server.close();
  }
});

test("SUPPLY3-03: a link anywhere on the way out of the install folder is refused, and one at the file is replaced, not followed", { timeout: 60_000 }, async () => {
  const archive = tarball();
  const server = await serve(archive);
  try {
    // The package folder is a link to a folder outside.
    const a = scratch();
    fs.mkdirSync(path.join(a.parent, "outside"));
    fs.rmSync(path.join(a.dir, "node_modules", "native"), { recursive: true });
    fs.symlinkSync(path.join(a.parent, "outside"), path.join(a.dir, "node_modules", "native"));
    let done = await install(a.dir, "node_modules/native", server.url, archive);
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /refuses to write native files to .*node_modules\/native \(a link or a file\)/);
    assert.deepEqual(fs.readdirSync(path.join(a.parent, "outside")), []);
    // A folder below the package is a link outside.
    const b = scratch();
    fs.mkdirSync(path.join(b.parent, "outside"));
    fs.symlinkSync(path.join(b.parent, "outside"), path.join(b.dir, "node_modules", "native", "build"));
    done = await install(b.dir, "node_modules/native", server.url, archive);
    assert.notEqual(done.status, 0);
    assert.deepEqual(fs.readdirSync(path.join(b.parent, "outside")), []);
    // The file itself is a link to a file outside: replaced by the reviewed file, the outside file untouched.
    const c = scratch();
    fs.writeFileSync(path.join(c.parent, "victim"), "untouched");
    fs.mkdirSync(path.join(c.dir, "node_modules", "native", "build", "Release"), { recursive: true });
    fs.symlinkSync(path.join(c.parent, "victim"), path.join(c.dir, "node_modules", "native", "build", "Release", "x.node"));
    done = await install(c.dir, "node_modules/native", server.url, archive);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(fs.readFileSync(path.join(c.parent, "victim"), "utf8"), "untouched");
    assert.equal(fs.lstatSync(path.join(c.dir, "node_modules", "native", "build", "Release", "x.node")).isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(path.join(c.dir, "node_modules", "native", "build", "Release", "x.node")), BINARY);
    assert.deepEqual(c.files(), ["install/node_modules/native/build/Release/x.node", "victim"]);
    // The install folder reached through a link (as /tmp is on macOS) is fine: only what's below it counts.
    const d = scratch();
    fs.symlinkSync(d.dir, path.join(d.parent, "via-link"));
    done = await install(path.join(d.parent, "via-link"), "node_modules/native", server.url, archive);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(fs.readFileSync(path.join(d.dir, "node_modules", "native", "build", "Release", "x.node")), BINARY);
  } finally {
    await server.close();
  }
});
