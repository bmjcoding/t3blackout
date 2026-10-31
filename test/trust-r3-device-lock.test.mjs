// node --test test/: device-tool locks, round 3 (decision J; SUPPLY3-01, -03, -07).
// Every package in a kept lock sits in a plain node_modules folder, where npm's
// own resolution from the tool down puts what each package's registry manifest
// asks for (names, `npm:` aliases, ranges), and nothing else is in it: a lock
// can't put another package at the tool's path and the tool in a decoy folder.
// Which packages need native files is read from the packages themselves, not
// from the lock's hasInstallScript flags. Offline: npm's metadata and tarballs
// are stand-ins.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { deviceToolLocks, installScriptPackages, lockEntry, verifyToolLock } from "../lib/device-tools.mjs";
import { nativeAssetsFor } from "../lib/native-assets.mjs";

const REG = "https://registry.npmjs.org/";
const NOW = Date.parse("2026-10-30T12:00:00Z");
const OLD = "2026-10-01T00:00:00.000Z";
const tarball = (name, version) => `${REG}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
const integrity = (pkg) => `sha512-${createHash("sha512").update(pkg).digest("base64")}`;
const split = (pkg) => [pkg.slice(0, pkg.lastIndexOf("@")), pkg.slice(pkg.lastIndexOf("@") + 1)];

/** npm metadata for `manifests` ({ "name@version": { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } }), every version old enough. */
const registry = (manifests) => async (name) => {
  const versions = {};
  const time = {};
  for (const [pkg, manifest] of Object.entries(manifests)) {
    const [n, version] = split(pkg);
    if (n !== name) continue;
    versions[version] = { ...manifest, dist: { tarball: tarball(n, version), integrity: integrity(pkg) } };
    time[version] = OLD;
  }
  return Object.keys(versions).length ? { versions, time } : null;
};

/** A kept lock for `tool`: { folder: "name@version" } (a folder whose package has another name is an alias), with `extra` entry fields per folder. */
function keptLock(tool, folders, extra = {}) {
  const [name, version] = split(tool);
  const packages = { "": { name: "t3blackout-device-tool", version: "0.0.0", dependencies: { [name]: version } } };
  for (const [folder, pkg] of Object.entries(folders)) {
    const [n, v] = split(pkg);
    const own = folder.slice(folder.lastIndexOf("node_modules/") + "node_modules/".length);
    packages[folder] = { ...(n === own ? {} : { name: n }), version: v, resolved: tarball(n, v), integrity: integrity(pkg), ...extra[folder] };
  }
  return lockEntry(`${JSON.stringify({ name: "t3blackout-device-tool", version: "0.0.0", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`);
}

const verify = (tool, folders, manifests, extra) => verifyToolLock(tool, keptLock(tool, folders, extra), { now: NOW, meta: registry(manifests) });

test("SUPPLY3-01: another package at the tool's path, the tool in a decoy folder, is refused", async () => {
  const manifests = { "is-number@1.0.0": {}, "is-positive@1.0.0": {} };
  await assert.rejects(
    verify("is-number@1.0.0", { "node_modules/is-number": "is-positive@1.0.0", "node_modules/decoy": "is-number@1.0.0" }, manifests),
    /doesn't install as npm resolves is-number@1\.0\.0: it doesn't contain is-number@1\.0\.0 as the package npm installs for it/,
  );
  // The honest lock passes.
  assert.deepEqual((await verify("is-number@1.0.0", { "node_modules/is-number": "is-number@1.0.0" }, manifests)).packages, ["is-number@1.0.0"]);
  // A package nothing asks for is a decoy too, even beside the real tool.
  await assert.rejects(verify("is-number@1.0.0", { "node_modules/is-number": "is-number@1.0.0", "node_modules/decoy": "is-positive@1.0.0" }, manifests), /node_modules\/decoy \(is-positive@1\.0\.0\) is nothing npm installs from is-number@1\.0\.0/);
});

test("each dependency's folder holds the package asked for, aliases and nesting as npm resolves them", async () => {
  const manifests = {
    "tool@1.0.0": { dependencies: { a: "^1.0.0", b: "1.0.0", helper: "npm:real-helper@^2.0.0" }, optionalDependencies: { "fsevents-like": "^1.0.0" }, peerDependencies: { ai: ">=6" }, peerDependenciesMeta: { ai: { optional: true } } },
    "a@1.0.0": {},
    "a@2.0.0": {},
    "b@1.0.0": { dependencies: { a: "^2.0.0" } },
    "real-helper@2.1.0": {},
    "evil@1.0.0": {},
  };
  const honest = { "node_modules/tool": "tool@1.0.0", "node_modules/a": "a@1.0.0", "node_modules/b": "b@1.0.0", "node_modules/b/node_modules/a": "a@2.0.0", "node_modules/helper": "real-helper@2.1.0" };
  assert.deepEqual((await verify("tool@1.0.0", honest, manifests)).packages, ["a@1.0.0", "a@2.0.0", "b@1.0.0", "real-helper@2.1.0", "tool@1.0.0"]);
  // b's own a@2 left out: Node would find the top-level a@1, which b doesn't ask for.
  const { "node_modules/b/node_modules/a": _, ...flat } = honest;
  await assert.rejects(verify("tool@1.0.0", { ...flat, "node_modules/a-two": "a@2.0.0" }, manifests), /node_modules\/a holds a@1\.0\.0, but b@1\.0\.0 asks for a@\^2\.0\.0/);
  // A dependency's folder holding another package (an alias npm wasn't asked for), or a version out of range.
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/a": "evil@1.0.0" }, manifests), /node_modules\/a holds evil@1\.0\.0, but tool@1\.0\.0 asks for a@\^1\.0\.0/);
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/helper": "evil@1.0.0" }, manifests), /node_modules\/helper holds evil@1\.0\.0, but tool@1\.0\.0 asks for helper@npm:real-helper@\^2\.0\.0/);
  await assert.rejects(verify("tool@1.0.0", { ...honest, "node_modules/a": "a@2.0.0", "node_modules/b/node_modules/a": "a@2.0.0" }, manifests), /node_modules\/a holds a@2\.0\.0, but tool@1\.0\.0 asks for a@\^1\.0\.0/);
  // A dependency it needs that isn't there; an optional one may be missing (another platform's).
  const { "node_modules/b": __, "node_modules/b/node_modules/a": ___, ...withoutB } = honest;
  await assert.rejects(verify("tool@1.0.0", withoutB, manifests), /tool@1\.0\.0 needs b@1\.0\.0, which isn't where npm looks from node_modules\/tool/);
});

test("SUPPLY3-03: a lock folder outside node_modules, or with odd parts, is refused before anything else", async () => {
  const manifests = { "tool@1.0.0": {}, "node-datachannel@0.32.3": {} };
  for (const folder of ["node_modules/../../escaped", "node_modules/tool/../../x", "node_modules/@s/../x", "/node_modules/x", "node_modules/.bin", "node_modules/tool/node_modules"]) {
    await assert.rejects(verify("tool@1.0.0", { "node_modules/tool": "tool@1.0.0", [folder]: "node-datachannel@0.32.3" }, manifests), /outside its node_modules, or isn't a plain package folder there/, folder);
  }
  // And the native-asset list, from a lock's flags or the packages, takes only plain folders.
  const manifest = { version: 1, packages: { "node-datachannel@0.32.3": { why: "test", assets: [] } } };
  assert.throws(() => nativeAssetsFor([{ path: "node_modules/../../escaped", package: "node-datachannel@0.32.3" }], manifest, "tool@1.0.0"), /puts node-datachannel@0\.32\.3 at node_modules\/\.\.\/\.\.\/escaped, which isn't a plain folder/);
  const flagged = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/../../escaped": { name: "node-datachannel", version: "0.32.3", hasInstallScript: true } } });
  assert.throws(() => nativeAssetsFor(flagged, manifest, "tool@1.0.0"), /isn't a plain folder inside its node_modules/);
});

/** Stand-in tarballs: `files` per name@version under package/. */
const fetchFrom = (files) => async (name, version, into) => {
  const dir = path.join(into, "package");
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files[`${name}@${version}`] ?? { "package.json": JSON.stringify({ name, version }) })) fs.writeFileSync(path.join(dir, file), content);
  return { dir };
};

test("SUPPLY3-07: install scripts are read from the packages, not the lock's flags", async () => {
  const manifests = { "tool@1.0.0": { dependencies: { native: "^2.0.0", gyp: "1.0.0", plain: "1.0.0", nogyp: "1.0.0" } }, "native@2.0.0": {}, "gyp@1.0.0": {}, "plain@1.0.0": {}, "nogyp@1.0.0": {} };
  const fetch = fetchFrom({
    "native@2.0.0": { "package.json": JSON.stringify({ name: "native", scripts: { install: "prebuild-install || cmake-js rebuild" } }) },
    "gyp@1.0.0": { "package.json": JSON.stringify({ name: "gyp" }), "binding.gyp": "{}" },
    "nogyp@1.0.0": { "package.json": JSON.stringify({ name: "nogyp", gypfile: false }), "binding.gyp": "{}" },
  });
  const folders = { "node_modules/tool": "tool@1.0.0", "node_modules/native": "native@2.0.0", "node_modules/gyp": "gyp@1.0.0", "node_modules/plain": "plain@1.0.0", "node_modules/nogyp": "nogyp@1.0.0" };
  // No hasInstallScript flags at all in this lock.
  const entry = keptLock("tool@1.0.0", folders);
  assert.deepEqual(await installScriptPackages(entry.lock, { fetch }), [
    { path: "node_modules/native", package: "native@2.0.0" },
    { path: "node_modules/gyp", package: "gyp@1.0.0" },
  ]);
  const opts = { pinJson: { deviceToolLocks: { "tool@1.0.0": entry } }, now: NOW, meta: registry(manifests), fetch };
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, nativeAssets: { version: 1, packages: {} } }), /dependencies native@2\.0\.0, gyp@1\.0\.0 have install scripts.*lib\/native-assets\.json/);
  const asset = { platform: "darwin", arch: "arm64", url: "https://example.org/native.tar.gz", sha256: "a".repeat(64), files: { "build/Release/native.node": "b".repeat(64) } };
  const listed = { version: 1, packages: { "native@2.0.0": { why: "prebuilds", assets: [asset] }, "gyp@1.0.0": { why: "builds nothing the tool uses", assets: [] } } };
  const built = await deviceToolLocks(["tool@1.0.0"], { ...opts, nativeAssets: listed });
  assert.deepEqual(built["tool@1.0.0"].needs, [{ path: "node_modules/native", package: "native@2.0.0" }]);
  // A lock flag still adds to what the packages say; it can't take anything away.
  const flaggedEntry = keptLock("tool@1.0.0", folders, { "node_modules/plain": { hasInstallScript: true } });
  await assert.rejects(deviceToolLocks(["tool@1.0.0"], { ...opts, pinJson: { deviceToolLocks: { "tool@1.0.0": flaggedEntry } }, nativeAssets: listed }), /dependencies plain@1\.0\.0 have install scripts/);
});
