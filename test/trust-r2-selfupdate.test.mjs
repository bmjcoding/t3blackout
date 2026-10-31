// node --test test/: each Mac is the authority over an evaluator pin (decision A,
// SUPPLY2-04, PIPE2-02). A stolen evaluator key that signs a pin of a real, newer
// release can at worst get it held: its new dependencies are measured against the
// pin this clone already trusts, with a fast lane built only from upstream's git
// and the owner's overrides (SUPPLY2-01), and changed or non-registry bytes are
// refused (SUPPLY2-02). Throwaway repositories and keys; npm and OSV are mocked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DAY, NIGHTLY, OLD_DEPS, ago, fixture, mockFetch, pin, run } from "./trust-fixtures.mjs";

const noAdvisories = async () => [];

/** npm metadata for `name`: { version: { publishedAt, integrity, user, repository } }. */
function npmRoutes(packages) {
  const routes = {};
  for (const [name, versions] of Object.entries(packages)) {
    const meta = { versions: {}, time: {} };
    for (const [version, { publishedAt, integrity, user = "maintainer", repository = "github:example/dep" }] of Object.entries(versions)) {
      meta.versions[version] = { name, version, _npmUser: { name: user }, repository, dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } };
      meta.time[version] = publishedAt;
    }
    routes[`https://registry.npmjs.org/${name}`] = () => new Response(JSON.stringify(meta), { status: 200 });
  }
  return routes;
}

test("a stolen-key pin whose release adds a dependency an hour old is held here, and taken once it's old enough", async () => {
  const young = "sha512-eW91bmc=";
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, "trust-r2-young@1.0.0": young }, OLD_DEPS] });
  const before = f.head();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch(npmRoutes({ "trust-r2-young": { "1.0.0": { publishedAt: ago(1 / 24), integrity: young } } }));
  assert.equal(await f.update({ advisories: noAdvisories }), "held");
  assert.equal(f.head(), before, "nothing of the update is taken");
  assert.match(f.logs.at(-1), /self-update held: .*adds dependencies under 3 days old over v0\.1\.6-nightly\.20261030\.3904.*trust-r2-young@1\.0\.0/);
  // Three days on, the same pin passes the same gate.
  assert.equal(await f.update({ advisories: noAdvisories, now: Date.now() + 3 * DAY }), "updated");
  assert.equal(f.head(), tip);
});

test("the fast lane here comes from the trusted release's own lockfile: a fix for an advisory against it is taken", async () => {
  const [old, fixed] = ["sha512-b2xk", "sha512-Zml4"];
  const f = fixture({ locks: [{ ...OLD_DEPS, "trust-r2-vuln@1.0.0": old }, { ...OLD_DEPS, "trust-r2-vuln@1.0.1": fixed }, OLD_DEPS] });
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch({
    ...npmRoutes({ "trust-r2-vuln": { "1.0.0": { publishedAt: ago(30), integrity: old }, "1.0.1": { publishedAt: ago(1 / 24), integrity: fixed } } }),
    // The fix itself has no advisory open against it.
    "https://api.osv.dev/v1/querybatch": () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
  });
  const seen = [];
  const advisories = async (packages) => {
    seen.push(packages);
    return packages.includes("trust-r2-vuln@1.0.0") ? [{ id: "GHSA-r2r2-r2r2-r2r2", severity: "HIGH", packages: [{ pkg: "trust-r2-vuln@1.0.0", fixed: ["1.0.1"] }] }] : [];
  };
  assert.equal(await f.update({ advisories }), "updated");
  assert.equal(f.head(), tip);
  // Asked once, about upstream's previous release as its lockfile and device tool pins have it.
  assert.deepEqual(seen, [["trust-r2-vuln@1.0.0", "trust-su-dep@1.0.0", "trust-su-tool@1.0.0"]]);
  assert.ok(f.logs.some((line) => /fast lane: trust-r2-vuln@1\.0\.1: fixes GHSA-r2r2-r2r2-r2r2 \(publisher maintainer/.test(line)));
});

test("a predecessor the trusted release doesn't have can't open the fast lane (SUPPLY2-01, PIPE2-01)", async () => {
  // Upstream's previous release never had trust-r2-new; nothing the evaluator
  // writes can make this machine believe it did.
  const fresh = "sha512-bmV3";
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, "trust-r2-new@1.0.1": fresh }, OLD_DEPS] });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch({
    ...npmRoutes({ "trust-r2-new": { "1.0.0": { publishedAt: ago(4), integrity: "sha512-b2xk" }, "1.0.1": { publishedAt: ago(1 / 24), integrity: fresh } } }),
    "https://api.osv.dev/v1/querybatch": () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
  });
  const seen = [];
  // Even told of an advisory against 1.0.0, nothing vouches for 1.0.1's publisher:
  // the usual publishers are those of versions the trusted release itself uses.
  const advisories = async (packages) => {
    seen.push(...packages);
    return [{ id: "GHSA-fake-fake-fake", severity: "HIGH", packages: [{ pkg: "trust-r2-new@1.0.0", fixed: ["1.0.1"] }] }];
  };
  assert.equal(await f.update({ advisories }), "held");
  assert.equal(f.head(), before);
  assert.ok(!seen.includes("trust-r2-new@1.0.0"));
});

test("a version whose bytes changed, or that comes from outside the registry, is refused (SUPPLY2-02)", async () => {
  let f = fixture({ locks: [OLD_DEPS, { "trust-su-dep@1.0.0": "sha512-ZXZpbA==" }, OLD_DEPS] });
  let before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  globalThis.fetch = async () => assert.fail("nothing was added, so nothing needs npm");
  assert.equal(await f.update({ advisories: noAdvisories }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /changes or misstates dependencies' bytes: trust-su-dep@1\.0\.0 \(resolved to sha512-ZXZpbA==, not sha512-b2xk as before\)/);

  f = fixture({ locks: [OLD_DEPS, { "trust-su-dep@1.0.0": { integrity: "sha512-b2xk", tarball: "http://127.0.0.1:9/is-number.tgz" } }, OLD_DEPS] });
  before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.equal(await f.update({ advisories: noAdvisories }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /trust-su-dep@1\.0\.0 is resolved from http:\/\/127\.0\.0\.1:9\/is-number\.tgz, not the npm registry/);
});

test("a new version whose locked integrity isn't the registry's is refused", async () => {
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, "trust-r2-swap@2.0.0": "sha512-bm90IHRoZSByZWdpc3RyeQ==" }, OLD_DEPS] });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch(npmRoutes({ "trust-r2-swap": { "2.0.0": { publishedAt: ago(30), integrity: "sha512-cmVnaXN0cnk=" } } }));
  assert.equal(await f.update({ advisories: noAdvisories }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /trust-r2-swap@2\.0\.0 \(locked as sha512-bm90IHRoZSByZWdpc3RyeQ==, but the registry's tarball is sha512-cmVnaXN0cnk=\)/);
});

test("the evaluator can't write the first pin or a channel's first pin, or lock tools without a forward move", async () => {
  let f = fixture();
  run(f.origin, ["rm", "-q", "pin.json"]);
  f.commit(f.owner, {}, "no pin");
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "first pin");
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /creates pin\.json; its first version needs a commit you sign/);

  f = fixture();
  const preview = JSON.parse(pin(NIGHTLY(3904), f.shas[0]));
  preview.channels.preview = { ref: "v0.1.6-preview.20261030.1", sha: f.shas[2], evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] };
  f.commit(f.bot, { "pin.json": `${JSON.stringify(preview, null, 2)}\n` }, "add preview");
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /adds a preview pin; a channel's first pin needs a commit you sign/);

  f = fixture();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3904), f.shas[0], ["trust-su-tool@1.0.0"], ["trust-su-tool@1.0.0"]) }, "lock only");
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /approves device tools trust-su-tool@1\.0\.0 without moving a channel forward/);
});

test("a lock for a tool the release it moves to doesn't pin is refused before any review", async () => {
  const f = fixture({ knownTools: "trust-su-deps@1.0.0" });
  const before = f.head();
  // Release 3940 pins only trust-su-tool@1.1.0; this locks trust-su-deps@1.0.0 too.
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[2], ["trust-su-tool@1.0.0"], ["trust-su-deps@1.0.0"]) }, "Pin nightly");
  globalThis.fetch = async () => assert.fail("no review should run");
  assert.equal(await f.update({ isKnownHost: () => false }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /approves trust-su-deps@1\.0\.0, which v0\.1\.6-nightly\.20261030\.3940 doesn't pin/);
});

test("an owner-signed pin.json after an evaluator commit vouches for it, so a bad evaluator pin doesn't wedge the update", async () => {
  const f = fixture();
  // Alone, this is refused: upstream's 3940 is another commit.
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[0]) }, "stolen-key pin");
  assert.equal(await f.update(), "refused");
  const tip = f.commit(f.owner, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "owner repins");
  globalThis.fetch = async () => assert.fail("the owner's pin needs no npm check");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
  // An owner commit that leaves pin.json alone vouches for nothing in it.
  const g = fixture();
  g.commit(g.bot, { "pin.json": pin(NIGHTLY(3940), g.shas[0]) }, "stolen-key pin");
  g.commit(g.owner, { "lib/rules.mjs": "// a rule fix\n" }, "rule fix");
  assert.equal(await g.update(), "refused");
});
