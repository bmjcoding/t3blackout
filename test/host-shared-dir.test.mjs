// node --test test/: the folder agent accounts share with the updater (lib/shared-dir.mjs).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { clearRequests, ensureRequestDir, ensureSharedDir, publishShared } from "../lib/shared-dir.mjs";

/** A private stand-in for /Users/Shared: <tmp>/Shared/t3blackout/update-requests. */
function sharedRoot() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-shared-")));
  const shared = path.join(base, "Shared");
  fs.mkdirSync(shared, { mode: 0o755 });
  const root = path.join(shared, "t3blackout");
  return { base, shared, root, requests: path.join(root, "update-requests") };
}

const mode = (file) => fs.lstatSync(file).mode & 0o7777;

test("the request folder is made 1733 inside a 755 shared folder", () => {
  const { root, requests } = sharedRoot();
  ensureRequestDir(requests);
  assert.equal(mode(root), 0o755);
  assert.equal(mode(requests), 0o1733);
  // Again, over what's there: still fine, and corrected if loosened.
  fs.chmodSync(requests, 0o777);
  ensureRequestDir(requests);
  assert.equal(mode(requests), 0o1733);
});

test("a symlink in place of the request folder is refused, and its target left alone", () => {
  const { base, root, requests } = sharedRoot();
  const victim = path.join(base, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, "id_ed25519"), "secret");
  ensureSharedDir(root);
  fs.symlinkSync(victim, requests);
  assert.throws(() => ensureRequestDir(requests), /isn't a real folder/);
  assert.equal(mode(victim), 0o700);
  // The updater's cleanup doesn't follow it either.
  clearRequests(requests);
  assert.equal(fs.readFileSync(path.join(victim, "id_ed25519"), "utf8"), "secret");
});

test("a symlinked or loosened shared folder is refused", () => {
  const { base, root, requests } = sharedRoot();
  fs.mkdirSync(path.join(base, "elsewhere"));
  fs.symlinkSync(path.join(base, "elsewhere"), root);
  assert.throws(() => ensureRequestDir(requests), /isn't a real folder/);
  fs.rmSync(root);
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o777);
  assert.throws(() => ensureRequestDir(requests), /writable by other accounts/);
});

test("the shared folder can't live where others can rename it", () => {
  const { shared, root, requests } = sharedRoot();
  fs.chmodSync(shared, 0o777);
  assert.throws(() => ensureRequestDir(requests), /not sticky/);
  fs.chmodSync(shared, 0o1777);
  ensureRequestDir(requests);
  assert.equal(mode(root), 0o755);
});

test("clearing requests handles each entry and never stops on one", () => {
  const { base, requests } = sharedRoot();
  ensureRequestDir(requests);
  const target = path.join(base, "keep.txt");
  fs.writeFileSync(target, "keep");
  fs.writeFileSync(path.join(requests, "501-1"), "");
  fs.symlinkSync(target, path.join(requests, "link"));
  fs.mkdirSync(path.join(requests, "empty-dir"));
  fs.mkdirSync(path.join(requests, "full-dir"));
  fs.writeFileSync(path.join(requests, "full-dir", "inside"), "x");
  const logged = [];
  assert.equal(clearRequests(requests, { log: (line) => logged.push(line) }), 4);
  assert.deepEqual(fs.readdirSync(requests), ["full-dir"]);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(requests, "full-dir", "inside"), "utf8"), "x");
  assert.match(logged.join("\n"), /left .*full-dir/);
  // A missing folder is nothing to do.
  assert.equal(clearRequests(path.join(base, "nope", "update-requests")), 0);
});

test("published files are 644 and replaced whole", () => {
  const { root } = sharedRoot();
  const file = publishShared(root, "usage-model-rates.json", "{\"a\":1}");
  assert.equal(mode(file), 0o644);
  publishShared(root, "usage-model-rates.json", "{\"a\":2}");
  assert.equal(fs.readFileSync(file, "utf8"), "{\"a\":2}");
  assert.deepEqual(fs.readdirSync(root), ["usage-model-rates.json"]);
});
