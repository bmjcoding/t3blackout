// node --test test/: an old upstream tag can't wedge its successors (SUPPLY3-06).
// The release this clone's pin already names is trusted by its commit, so the
// dependency gate reads its lockfile by commit id; only the release an evaluator
// commit moves to is checked by tag. Throwaway repositories and keys.
import { test } from "node:test";
import assert from "node:assert/strict";

import { NIGHTLY, fixture, pin, run } from "./trust-fixtures.mjs";

const noAdvisories = async () => [];

test("SUPPLY3-06: the previously pinned tag moving upstream doesn't hold a valid successor", async () => {
  const f = fixture();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  // Upstream moves the tag this clone's pin names; the commit it named is still there.
  run(f.upstream, ["tag", "-f", NIGHTLY(3904), f.shas[2]]);
  assert.equal(await f.update({ advisories: noAdvisories }), "updated", f.logs.join("\n"));
  assert.equal(f.head(), tip);
});

test("SUPPLY3-06: the previously pinned tag being deleted upstream doesn't hold it either", async () => {
  const f = fixture();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  run(f.upstream, ["tag", "-d", NIGHTLY(3904)]);
  assert.equal(await f.update({ advisories: noAdvisories }), "updated", f.logs.join("\n"));
  assert.equal(f.head(), tip);
});

test("the release moved to is still checked by its tag", async () => {
  const f = fixture();
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  run(f.upstream, ["tag", "-f", "-a", "-m", "moved", NIGHTLY(3917), f.shas[2]]);
  assert.equal(await f.update({ advisories: noAdvisories }), "refused");
  assert.match(f.logs.at(-1), /upstream's v0\.1\.6-nightly\.20261030\.3917 is /);
  assert.equal(f.head(), before);
});
