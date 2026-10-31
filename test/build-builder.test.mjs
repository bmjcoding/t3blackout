// node --test test/: what the build account gets (lib/builder.mjs) and the
// helpers its build relies on (lib/util.mjs).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SNAPSHOT_FILE, snapshotArchive, verifySnapshot } from "../lib/builder.mjs";
import { capture, redact, run, trackStageDirs } from "../lib/util.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = "97e35bcf23e4dcf34c2dcffadd37c08db0e01e52";

/** A stand-in clone: bin/, lib/ and a pin.json pinning SHA with two device tools. */
function fakeClone({ pin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-clone-"));
  for (const dir of ["bin", "lib"]) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, "bin", "t3blackout"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "lib", "x.mjs"), "export {};\n");
  if (pin) {
    const value = {
      version: 1,
      channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: SHA, evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } },
      deviceTools: ["agent-device@0.21.31", "expo-device-hub@0.19.0-canary-20261023-1357114"],
    };
    fs.writeFileSync(path.join(root, "pin.json"), `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

function unpack(archive) {
  const into = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-code-"));
  const result = spawnSync("tar", ["-C", into, "-xf", "-"], { input: archive });
  assert.equal(result.status, 0, String(result.stderr));
  return into;
}

test("SUPPLY-08: the build account's code carries pin.json, bound to the build's commit", () => {
  const clone = fakeClone();
  const code = unpack(snapshotArchive({ root: clone, sha: SHA }));
  assert.deepEqual(fs.readdirSync(code).sort(), ["bin", "lib", "pin.json", SNAPSHOT_FILE].sort());
  assert.equal(fs.readFileSync(path.join(code, "pin.json"), "utf8"), fs.readFileSync(path.join(clone, "pin.json"), "utf8"));
  // The device tool approvals are what the build account's reviewedDeviceTools() reads.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(code, "pin.json"), "utf8")).deviceTools, ["agent-device@0.21.31", "expo-device-hub@0.19.0-canary-20261023-1357114"]);
  const snapshot = verifySnapshot({ root: code, sha: SHA });
  assert.equal(snapshot.pinnedBy, "nightly");
  assert.throws(() => verifySnapshot({ root: code, sha: "c".repeat(40) }), /copied to build 97e35bcf/);
  fs.appendFileSync(path.join(code, "pin.json"), " ");
  assert.throws(() => verifySnapshot({ root: code, sha: SHA }), /isn't the one it was sent/);
});

test("no pin, an unpinned commit, or a check: still a snapshot; an invalid pin isn't sent", () => {
  const code = unpack(snapshotArchive({ root: fakeClone({ pin: false }) }));
  assert.deepEqual(fs.readdirSync(code).sort(), ["bin", "lib", SNAPSHOT_FILE].sort());
  assert.equal(verifySnapshot({ root: code }).pin, null);
  assert.equal(verifySnapshot({ root: unpack(snapshotArchive({ root: fakeClone(), sha: "d".repeat(40) })), sha: "d".repeat(40) }).pinnedBy, null);
  const bad = fakeClone();
  fs.writeFileSync(path.join(bad, "pin.json"), '{"version": 2}');
  assert.throws(() => snapshotArchive({ root: bad, sha: SHA }), /pin.json is invalid/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-code-"));
  assert.throws(() => verifySnapshot({ root: empty }), /no snapshot.json/);
});

test("HOST-16: a failing command's error never shows a secret argument", () => {
  const secret = "s3cret-keychain-pass";
  assert.throws(
    () => run("/bin/sh", ["-c", "exit 3", "sh", "-p", secret], { secrets: [secret], stdio: "ignore" }),
    (error) => !error.message.includes(secret) && /\*\*\* exited with 3/.test(error.message),
  );
  assert.throws(
    () => capture("/bin/sh", ["-c", 'echo "bad password $1" >&2; exit 1', "sh", secret], { secrets: [secret] }),
    (error) => !error.message.includes(secret) && /bad password \*\*\*/.test(error.message),
  );
  assert.equal(redact("a s3 b s3", ["s3", "", null]), "a *** b ***");
});

test("HOST-21: a build's stage folders are its own; another build's in the shared temp folder are left alone", () => {
  const theirs = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-desktop-mac-stage-"));
  const stages = trackStageDirs("mac");
  assert.ok(stages.tmpdir.startsWith(fs.realpathSync(os.tmpdir())) || stages.tmpdir.startsWith(os.tmpdir()));
  assert.equal(fs.statSync(stages.tmpdir).mode & 0o777, 0o700);
  const ours = fs.mkdtempSync(path.join(stages.tmpdir, "t3code-desktop-mac-stage-"));
  fs.mkdirSync(path.join(stages.tmpdir, "unrelated"));
  assert.deepEqual(stages.ours(), [ours]);
  stages.cleanup();
  assert.equal(fs.existsSync(stages.tmpdir), false);
  assert.equal(fs.existsSync(theirs), true);
  fs.rmSync(theirs, { recursive: true, force: true });
});

test("HOST-22: the CLI's root resolves from a clone whose path has a space and a percent sign", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "t3b build %20 clone-"));
  fs.mkdirSync(path.join(parent, "lib"));
  for (const name of ["util.mjs", "events.mjs", "git.mjs"]) {
    if (fs.existsSync(path.join(REPO, "lib", name))) fs.copyFileSync(path.join(REPO, "lib", name), path.join(parent, "lib", name));
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(path.join(parent, "lib", "util.mjs")).href)}); console.log(m.ROOT);`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fs.realpathSync(parent));
  fs.rmSync(parent, { recursive: true, force: true });
});
