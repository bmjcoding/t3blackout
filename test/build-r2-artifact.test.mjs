// node --test test/: check --build scans the packaged app it collected
// (BUILD2-14), and WORK's install runs install scripts only for packages the
// desktop build needs (BUILD2-12).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanArtifact } from "../lib/build.mjs";
import { DESKTOP_BUILD_SCRIPTS, desktopBuildsOnly } from "../lib/rules.mjs";
import macos from "../lib/platform/macos.mjs";
import linux from "../lib/platform/linux.mjs";

test("BUILD2-14: the collected app is scanned, staged dependencies and sidecars included, for both artifact shapes", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-artifact-"));
  const app = path.join(out, "T3 Blackout.app");
  const sidecar = path.join(app, "Contents", "Resources", "app.asar.unpacked", "node_modules", "helper");
  fs.mkdirSync(sidecar, { recursive: true });
  fs.writeFileSync(path.join(sidecar, "index.js"), "module.exports = 1;\n");
  scanArtifact(macos, app);
  // A forbidden endpoint only a staged dependency brings in.
  fs.writeFileSync(path.join(sidecar, "telemetry.js"), 'fetch("https://us.i.posthog.com/capture");\n');
  assert.throws(() => scanArtifact(macos, app), /forbidden endpoints found in the packaged app:[\s\S]*us\.i\.posthog\.com/);
  // Linux: collect returns { dir, icon }.
  const dir = path.join(out, "app");
  fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
  fs.writeFileSync(path.join(dir, "resources", "native.node"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("relay.t3.codes"), Buffer.from([0])]));
  assert.throws(() => scanArtifact(linux, { dir, icon: null }), /relay\.t3\.codes/);
});

test("BUILD2-12: allowBuilds keeps the desktop build's install scripts and turns every other one off", () => {
  const yaml = [
    "packages:",
    "  - apps/*",
    "",
    "allowBuilds:",
    "  # a comment",
    "  esbuild: true",
    "  electron: false",
    '  "react-native-enriched-markdown@file:apps/mobile/deps/x.tgz": true',
    '  "@tsc-rs/typescript": true',
    "  new-native-thing: true # upstream added",
    "",
    "catalog:",
    "  react: 19.0.0",
    "",
  ].join("\n");
  const out = desktopBuildsOnly(yaml);
  assert.match(out, /^ {2}esbuild: true$/m);
  assert.match(out, /^ {2}"@tsc-rs\/typescript": true$/m);
  assert.match(out, /^ {2}"react-native-enriched-markdown@file:apps\/mobile\/deps\/x\.tgz": false # t3blackout/m);
  assert.match(out, /^ {2}new-native-thing: false # t3blackout/m);
  assert.match(out, /^ {2}electron: false$/m);
  assert.match(out, /^catalog:\n {2}react: 19\.0\.0$/m);
  assert.throws(() => desktopBuildsOnly("packages: []\n"), /expected one top-level allowBuilds/);
  assert.throws(() => desktopBuildsOnly("allowBuilds:\n  weird entry here\n"), /can't read allowBuilds line/);
  for (const name of ["esbuild", "node-pty", "sharp", "msgpackr-extract", "@tsc-rs/typescript"]) assert.ok(DESKTOP_BUILD_SCRIPTS.has(name));
});
