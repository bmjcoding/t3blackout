// node --test test/: self-update end to end, in throwaway repositories signed with
// throwaway SSH keys (SUPPLY-01, -02, -16, -22, DOCS-03). Upstream is a local repo
// with release tags; npm is mocked. Nothing here touches this clone or ~/.ssh.
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { NIGHTLY, ago, fixture, forgeSigned, mockFetch, npm, pin, run } from "./trust-fixtures.mjs";

const { BOT_PRINCIPAL, principalsOf, signatureKind } = await import("../lib/selfupdate.mjs");

test("signature kinds and allowed-signers principals are read exactly", () => {
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SSH SIGNATURE-----\n a\n -----END SSH SIGNATURE-----\n\nmsg"), "ssh");
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN PGP SIGNATURE-----\n a\n\nmsg"), "openpgp");
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SIGNED MESSAGE-----\n a\n\nmsg"), "x509");
  assert.equal(signatureKind("tree x\n\ngpgsig -----BEGIN SSH SIGNATURE----- in the message"), null);
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SSH SIGNATURE-----\ngpgsig-sha256 -----BEGIN SSH SIGNATURE-----\n\n"), "unknown");
  assert.deepEqual([...principalsOf('# c\na@x,b@y namespaces="git" ssh-ed25519 AAAA\n"c d" ssh-ed25519 BBBB\n')], ["a@x", "b@y", "c d"]);
});

test("an owner-signed commit fast-forwards to exactly the verified commit", async () => {
  const f = fixture();
  const tip = f.commit(f.owner, { "lib/rules.mjs": "// a rule fix\n" }, "rule fix");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
  assert.match(f.logs.at(-1), /self-updated t3blackout to/);
  assert.equal(await f.update(), "skipped", "nothing new");
});

test("unsigned, unknown-key, OpenPGP and X.509 commits are refused", async () => {
  for (const make of [
    (f) => f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned"),
    (f) => f.commit(f.stranger, { "lib/x.mjs": "evil\n" }, "stranger"),
    (f) => forgeSigned(f, "PGP SIGNATURE"),
    (f) => forgeSigned(f, "SIGNED MESSAGE"),
  ]) {
    const f = fixture();
    const before = f.head();
    make(f);
    assert.equal(await f.update(), "refused");
    assert.equal(f.head(), before);
    assert.match(f.logs.at(-1), /isn't signed|not an SSH key|isn't signed by a key/);
  }
});

test("an evaluator pin of a real, newer upstream tag is taken", async () => {
  const f = fixture();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
});

test("an evaluator pin of a tag upstream doesn't have, or of another commit, is refused", async () => {
  for (const [ref, sha, why] of [
    [NIGHTLY(3999), 2, /upstream's v0\.1\.6-nightly\.20261030\.3999 is missing/],
    ["v99.0.0-nightly.20991231.1", 2, /is missing/],
    [NIGHTLY(3940), 0, /but upstream's .*3940 is /],
  ]) {
    const f = fixture();
    const before = f.head();
    f.commit(f.bot, { "pin.json": pin(ref, f.shas[sha]) }, "Pin nightly");
    assert.equal(await f.update(), "refused");
    assert.equal(f.head(), before);
    assert.match(f.logs.at(-1), why);
  }
});

test("evaluator commits stay pin-only and approve tools only with a forward move", async () => {
  let f = fixture();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]), "lib/rules.mjs": "evil\n" }, "pin and more");
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /not just pin\.json/);

  f = fixture();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3904), f.shas[0], ["trust-su-tool@1.0.0", "trust-su-tool@9.9.9"]) }, "approve only");
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /without moving a channel forward/);
});

test("a device tool the evaluator approves is reviewed here, and FETCH_HEAD swapped mid-check isn't merged", async () => {
  const f = fixture();
  const quiet = { "index.js": "connect('ws://localhost:1')" };
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0"]) }, "Pin nightly");
  // A second, unsigned commit on another branch: a concurrent fetch writes it to FETCH_HEAD.
  run(f.origin, ["checkout", "-q", "-b", "evil"]);
  const evil = f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned");
  let swapped = false;
  mockFetch(npm("trust-su-tool", { "1.0.0": { files: quiet, publishedAt: ago(30) }, "1.1.0": { files: quiet, publishedAt: ago(5) } }), () => {
    if (swapped) return;
    swapped = true;
    run(f.clone, ["fetch", "-q", "origin", "evil"]);
  });
  assert.equal(await f.update({ isKnownHost: () => false }), "updated");
  assert.ok(swapped);
  assert.equal(run(f.clone, ["rev-parse", "FETCH_HEAD"]), evil);
  assert.equal(f.head(), tip, "the verified commit, not FETCH_HEAD");
});

test("an approved tool whose dependency closure fails review is refused", async () => {
  const f = fixture({ knownTools: "trust-su-deps@1.0.0" });
  const before = f.head();
  const quiet = { "index.js": "connect('ws://localhost:1')" };
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-deps@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  mockFetch(npm("trust-su-deps", { "1.0.0": { files: quiet, publishedAt: ago(30) }, "1.1.0": { files: quiet, publishedAt: ago(5) } }));
  const seen = [];
  const reviewClosure = async (tool, previous) => {
    seen.push([tool, previous]);
    return { ok: false, pin: tool, reasons: ["dependency helper@2.0.0: new network hosts: sink.example.net"], notes: [] };
  };
  assert.equal(await f.update({ isKnownHost: () => false, reviewClosure }), "refused");
  assert.deepEqual(seen, [["trust-su-deps@1.1.0", "trust-su-deps@1.0.0"]]);
  assert.match(f.logs.at(-1), /fails review here: dependency helper@2\.0\.0: new network hosts/);
  assert.equal(f.head(), before);
});

test("an approval the release it moves to doesn't pin is refused before any review", async () => {
  const f = fixture({ knownTools: "trust-su-stray@1.0.0" });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-stray@1.0.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  globalThis.fetch = async () => assert.fail("no review should run");
  assert.equal(await f.update({ isKnownHost: () => false }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /approves trust-su-stray@1\.0\.0, which v0\.1\.6-nightly\.20261030\.3917 doesn't pin/);
});

test("an approved tool that reaches a host the repo doesn't know is refused", async () => {
  const f = fixture({ knownHosts: "api.vendor.dev", knownTools: "trust-su-host@1.0.0" });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-host@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  mockFetch(
    npm("trust-su-host", {
      "1.0.0": { files: { "index.js": "fetch('https://updates.vendor.dev/check')" }, publishedAt: ago(30) },
      "1.1.0": { files: { "index.js": "fetch('https://updates.vendor.dev/check'); fetch('https://api.vendor.dev/v2'); fetch('https://telemetry.vendor.dev/t')" }, publishedAt: ago(5) },
    }),
  );
  // Hosts are judged against lib/known-hosts.txt as committed before the evaluator's commit.
  assert.equal(await f.update(), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /trust-su-host@1\.1\.0, which fails review here: new network hosts: telemetry\.vendor\.dev$/);
});

test("unreachable npm or upstream postpones the update; a tool with no reviewed predecessor is refused", async () => {
  let f = fixture();
  let before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.equal(await f.update({ upstream: path.join(f.dir, "no-such-upstream") }), "skipped");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /couldn't check the tags evaluator commit \w+ pins upstream/);

  f = fixture({ knownTools: "trust-su-net@1.0.0" });
  before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-net@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  assert.equal(await f.update({ isKnownHost: () => false }), "skipped");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /couldn't review the device tools/);

  f = fixture();
  before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-new@2.0.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  assert.equal(await f.update({ isKnownHost: () => false }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /no reviewed version to compare against/);
});

test("a rewritten origin and a dirty clone are left alone", async () => {
  const f = fixture();
  const before = f.head();
  run(f.origin, ["commit", "-q", "--amend", "--no-gpg-sign", "-m", "rewritten"]);
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /isn't a fast-forward/);
  fs.writeFileSync(path.join(f.clone, "README.md"), "local edit\n");
  assert.equal(await f.update(), "skipped");
  assert.equal(f.head(), before);
});
