// node --test test/: device tools install with scripts off; the native files a
// package's install script would have fetched come from lib/native-assets.json,
// hash-checked (BUILD2-03, SUPPLY2-03). The installer the app runs is exercised
// for real against a local HTTP server.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { approvedToolLock } from "../lib/device-tools.mjs";
import { nativeAssetsFor, readNativeAssets, validateNativeAssets } from "../lib/native-assets.mjs";
import { BLACKOUT_NATIVE_ASSETS_SCRIPT, BLACKOUT_NATIVE_ASSETS_SOURCE } from "../lib/files/blackoutNativeAssets.ts";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HEX = "a".repeat(64);
const asset = (extra = {}) => ({ platform: "darwin", arch: "arm64", url: "https://example.org/x.tar.gz", sha256: HEX, files: { "build/Release/x.node": HEX }, ...extra });
const manifest = (packages) => ({ version: 1, packages });

test("lib/native-assets.json is exactly its shape: reviewed archives, plain paths inside the package, hashes", () => {
  assert.ok(readNativeAssets().packages["node-datachannel@0.32.3"]);
  const valid = manifest({ "native@1.0.0": { why: "its prebuild", assets: [asset()] } });
  assert.equal(validateNativeAssets(valid), valid);
  const invalid = (packages) => assert.throws(() => validateNativeAssets(manifest(packages)), /native-assets\.json is invalid/);
  invalid({ "native@1.0.0": { why: "", assets: [] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ url: "http://example.org/x.tar.gz" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ sha256: "ABC" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: { "../../etc/x": HEX } })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: { "/abs/x.node": HEX } })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ files: {} })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset(), asset()] } });
  invalid({ "native@1.0.0": { why: "x", assets: [asset({ platform: "plan9" })] } });
  invalid({ "native@1.0.0": { why: "x", assets: [{ ...asset(), extra: 1 }] } });
});

/** A package-lock.json with an install-script package at `node_modules/<name>`. */
const scriptedLock = (...pkgs) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, ...Object.fromEntries(pkgs.map((pkg) => [`node_modules/${pkg.slice(0, pkg.lastIndexOf("@"))}`, { version: pkg.slice(pkg.lastIndexOf("@") + 1), hasInstallScript: true }])) },
  });

test("a package with an install script must be listed: its archives, or none with why; else the owner is told what to add", () => {
  const listed = manifest({ "native@1.0.0": { why: "prebuild", assets: [asset(), asset({ platform: "linux", arch: "x64" })] }, "noop@2.0.0": { why: "prints a banner", assets: [] } });
  const { needs, assets } = nativeAssetsFor(scriptedLock("native@1.0.0", "noop@2.0.0"), listed);
  assert.deepEqual(needs, [{ path: "node_modules/native", package: "native@1.0.0" }]);
  assert.deepEqual(assets.map((a) => `${a.path} ${a.platform}-${a.arch}`), ["node_modules/native darwin-arm64", "node_modules/native linux-x64"]);
  assert.throws(() => nativeAssetsFor(scriptedLock("native@1.0.1"), listed, "tool@1.0.0"), /tool@1\.0\.0's dependencies native@1\.0\.1 have install scripts.*lib\/native-assets\.json/);
});

test("today's pinned device tools are covered: node-datachannel@0.32.3's prebuilds for darwin-arm64 and linux-x64", () => {
  const pin = JSON.parse(fs.readFileSync(new URL("../pin.json", import.meta.url), "utf8"));
  const lib = readNativeAssets();
  for (const tool of pin.deviceTools) nativeAssetsFor(approvedToolLock(tool, pin), lib, tool);
  const hub = pin.deviceTools.find((tool) => tool.startsWith("expo-device-hub@"));
  const { needs, assets } = nativeAssetsFor(approvedToolLock(hub, pin), lib, hub);
  assert.deepEqual(needs, [{ path: "node_modules/node-datachannel", package: "node-datachannel@0.32.3" }]);
  assert.deepEqual(assets.map((a) => `${a.platform}-${a.arch}`).sort(), ["darwin-arm64", "linux-x64"]);
  for (const a of assets) assert.match(a.url, /^https:\/\/github\.com\/murat-dogan\/node-datachannel\/releases\/download\/v0\.32\.3\/node-datachannel-v0\.32\.3-napi-v8-/);
});

/** A .tar.gz of `files` ({ path: content }), made with the system tar. */
function tarball(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-asset-src-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const out = path.join(os.tmpdir(), `t3b-r2-asset-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`);
  const made = spawnSync("tar", ["-czf", out, "-C", dir, ...Object.keys(files)], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const bytes = fs.readFileSync(out);
  fs.rmSync(out);
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Serves `routes` ({ "/path": bytes }) on 127.0.0.1; resolves { base, close }. */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    res.writeHead(body ? 200 : 404).end(body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** This machine's platform key as the installer computes it. */
const platform = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "linuxmusl" : process.platform;

/** Runs node with `args` without blocking this process (the test's HTTP server answers it); resolves { status, stderr }. */
function node(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

/** Runs the app's installer (node -e, as DeviceToolchain.ts does) on `dir`. */
const install = (dir, assets, needs) => node(["-e", BLACKOUT_NATIVE_ASSETS_SCRIPT, dir, JSON.stringify(assets), JSON.stringify(needs)]);

test("BUILD2-03: the app downloads the reviewed archive, checks both hashes, and writes only the listed files where the package expects them", { timeout: 60_000 }, async () => {
  const binary = Buffer.from("native binary\u0000\u0001");
  const longName = `build/Release/${"deep/".repeat(22)}x.node`;
  const archive = tarball({ "build/Release/x.node": binary, "build/Release/extra.sh": "echo planted", [longName]: "long" });
  const tampered = tarball({ "build/Release/x.node": "something else" });
  const server = await serve({ "/x.tar.gz": archive, "/tampered.tar.gz": tampered });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-asset-dir-"));
  try {
    const needs = [{ path: "node_modules/native", package: "native@1.0.0" }];
    const here = { path: needs[0].path, package: needs[0].package, platform, arch: process.arch, url: `${server.base}/x.tar.gz`, sha256: sha256(archive), files: { "build/Release/x.node": sha256(binary), [longName]: sha256("long") } };
    const done = await install(dir, [here], needs);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, "node_modules/native/build/Release/x.node")), binary);
    assert.equal(fs.readFileSync(path.join(dir, "node_modules/native", longName), "utf8"), "long");
    assert.equal(fs.existsSync(path.join(dir, "node_modules/native/build/Release/extra.sh")), false);

    // The archive isn't the reviewed one: nothing is written.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-asset-dir-"));
    const swapped = await install(other, [{ ...here, url: `${server.base}/tampered.tar.gz` }], needs);
    assert.notEqual(swapped.status, 0);
    assert.match(swapped.stderr, /doesn't match the SHA-256 reviewed for it/);
    assert.equal(fs.existsSync(path.join(other, "node_modules")), false);
    // The archive is, but a listed file inside it isn't what was reviewed.
    const wrongFile = await install(other, [{ ...here, files: { "build/Release/x.node": HEX } }], needs);
    assert.match(wrongFile.stderr, /has no build\/Release\/x\.node matching the SHA-256 reviewed for it/);
    // No reviewed archive for this platform: the install fails, saying so.
    const elsewhere = await install(other, [{ ...here, arch: process.arch === "arm64" ? "x64" : "arm64" }], needs);
    assert.match(elsewhere.stderr, new RegExp(`no reviewed native files of native@1\\.0\\.0 for ${platform}-${process.arch}`));
    // Nothing needed, nothing fetched.
    assert.equal((await install(other, [], [])).status, 0);
    fs.rmSync(other, { recursive: true, force: true });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the SSH device host script embeds the same installer as a plain function", { timeout: 60_000 }, async () => {
  const binary = Buffer.from("remote binary");
  const archive = tarball({ "build/Release/x.node": binary });
  const server = await serve({ "/x.tar.gz": archive });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-asset-ssh-"));
  try {
    const needs = [{ path: "node_modules/native", package: "native@1.0.0" }];
    const assets = [{ ...needs[0], platform, arch: process.arch, url: `${server.base}/x.tar.gz`, sha256: sha256(archive), files: { "build/Release/x.node": sha256(binary) } }];
    // As sshDeviceScript.ts puts it into the remote script's text.
    const script = `const installNativeAssets = ${BLACKOUT_NATIVE_ASSETS_SOURCE};\n(async () => { await installNativeAssets(${JSON.stringify(dir)}, ${JSON.stringify(assets)}, ${JSON.stringify(needs)}); })().catch((error) => { console.error(error.message); process.exitCode = 1; });`;
    const run = await node(["-e", script]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, "node_modules/native/build/Release/x.node")), binary);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
