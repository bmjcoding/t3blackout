// node --test test/: a dependency is name@version plus where it comes from plus
// its exact bytes (decision B, SUPPLY2-02). Upstream changing an existing
// version's resolution or integrity is a substitution, a non-registry source is
// refused unless the owner lists it, and pnpm's own lockfile verification can't be
// switched off by upstream's configuration. npm is mocked.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { resolveLockfile } from "../lib/build.mjs";
import { dependencyAgeGate, knownResolutions, lockIdentities, lockPackages, registryIntegrity, resolutionKind } from "../lib/gates.mjs";
import { checkResolution } from "../lib/resolution.mjs";
import { ago, lockfileOf, mockFetch } from "./trust-fixtures.mjs";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-r2-identity-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const REGISTRY = { integrity: "sha512-b2xk" };

test("resolutionKind: registry versions by integrity alone, upstream's own tree, owner-listed tarballs; nothing else", () => {
  const none = new Map();
  assert.equal(resolutionKind("is-number@7.0.0", REGISTRY, none), "registry");
  assert.equal(resolutionKind("t3-highlights@file:apps/mobile/modules/t3-highlights", { directory: "apps/mobile/modules/t3-highlights", type: "directory" }, none), "local");
  assert.equal(resolutionKind("md@file:apps/mobile/deps/md-1.2.0.tgz", { integrity: "sha512-AAAA", tarball: "file:apps/mobile/deps/md-1.2.0.tgz" }, none), "local");
  for (const [key, resolution, why] of [
    ["is-number@7.0.0", { integrity: "sha512-b2xk", tarball: "http://127.0.0.1:9/x.tgz" }, /resolved from http:\/\/127\.0\.0\.1:9\/x\.tgz, not the npm registry/],
    ["is-number@7.0.0", { integrity: "sha512-b2xk", tarball: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz" }, /not the npm registry/],
    ["is-number@7.0.0", { type: "git", repo: "https://github.com/x/y", commit: "a".repeat(40) }, /resolved from https:\/\/github\.com\/x\/y/],
    ["is-number@7.0.0", { integrity: "md5-abc" }, /not the npm registry/],
    ["is-number@7.0.0", null, /not the npm registry/],
    ["evil@file:../outside", { directory: "../outside", type: "directory" }, /isn't resolved inside upstream's tree/],
    ["evil@file:/etc", { directory: "/etc", type: "directory" }, /isn't resolved inside upstream's tree/],
    ["evil@file:apps/x", { directory: "apps/y", type: "directory" }, /isn't resolved inside upstream's tree/],
    ["evil@https://example.org/x.tgz", { integrity: "sha512-AAAA", tarball: "https://example.org/x.tgz" }, /not the npm registry/],
  ]) {
    assert.throws(() => resolutionKind(key, resolution, none), why, key);
  }
  // lib/known-resolutions.txt vouches for exact bytes only.
  const known = knownResolutions("# a comment\nodd@1.0.0 sha512-b2xk  # vendored\n");
  const tarball = { integrity: "sha512-b2xk", tarball: "https://example.org/odd-1.0.0.tgz" };
  assert.equal(resolutionKind("odd@1.0.0", tarball, known), "known");
  assert.throws(() => resolutionKind("odd@1.0.0", { ...tarball, integrity: "sha512-ZXZpbA==" }, known), /not the npm registry/);
  assert.throws(() => knownResolutions("odd@1.0.0\n"), /isn't "<lockfile package> <integrity>"/);
  assert.equal(knownResolutions().size, 0, "the repo lists none today");
});

test("lockIdentities keys registry packages by their bytes; lockPackages is still name@version", () => {
  const text = lockfileOf({ "a@1.0.0": "sha512-YQ==", "@s/b@2.0.0": "sha512-Yg==" });
  assert.deepEqual([...lockIdentities(text)], [["a@1.0.0", "sha512-YQ=="], ["@s/b@2.0.0", "sha512-Yg=="]]);
  assert.deepEqual([...lockPackages(text)], ["a@1.0.0", "@s/b@2.0.0"]);
  assert.equal(registryIntegrity({ integrity: "sha512-YQ==" }), "sha512-YQ==");
  assert.equal(registryIntegrity({ shasum: "a".repeat(40) }), `sha1-${Buffer.from("a".repeat(40), "hex").toString("base64")}`);
  assert.equal(registryIntegrity({}), null);
});

test("the age gate calls a changed integrity for a version both lockfiles have a substitution, and checks new ones against the registry", async () => {
  const base = lockfileOf({ "is-number@7.0.0": "sha512-b3JpZ2luYWw=" });
  // The reviewer's case: same version, other bytes, nothing "added".
  const swapped = await dependencyAgeGate(base, lockfileOf({ "is-number@7.0.0": "sha512-c3dhcHBlZA==" }));
  assert.equal(swapped.ok, false);
  assert.equal(swapped.added, 0);
  assert.deepEqual(swapped.substituted, [{ pkg: "is-number@7.0.0", why: "resolved to sha512-c3dhcHBlZA==, not sha512-b3JpZ2luYWw= as before" }]);

  mockFetch({
    "https://registry.npmjs.org/trust-r2-id": () =>
      new Response(JSON.stringify({ versions: { "1.0.0": { dist: { integrity: "sha512-cmVhbA==" } }, "2.0.0": { dist: { integrity: "sha512-dHdv" } } }, time: { "1.0.0": ago(30), "2.0.0": ago(30) } }), { status: 200 }),
  });
  const lied = await dependencyAgeGate(base, lockfileOf({ "is-number@7.0.0": "sha512-b3JpZ2luYWw=", "trust-r2-id@1.0.0": "sha512-bGll" }));
  assert.equal(lied.ok, false);
  assert.match(lied.substituted[0].why, /locked as sha512-bGll, but the registry's tarball is sha512-cmVhbA==/);
  const honest = await dependencyAgeGate(base, lockfileOf({ "is-number@7.0.0": "sha512-b3JpZ2luYWw=", "trust-r2-id@2.0.0": "sha512-dHdv" }));
  assert.equal(honest.ok, true);
  assert.deepEqual(honest.substituted, []);
  // name@version lists (a device tool's closure) have no bytes to compare.
  assert.deepEqual((await dependencyAgeGate([], ["trust-r2-id@2.0.0"])).substituted, []);
});

test("checkResolution refuses a re-resolution that swaps an existing version's source or bytes (SUPPLY2-02)", async () => {
  const base = lockfileOf({ "is-number@7.0.0": "sha512-b3JpZ2luYWw=" });
  const nothing = async () => assert.fail("no age check: nothing was added");
  await assert.rejects(
    checkResolution(base, lockfileOf({ "is-number@7.0.0": { integrity: "sha512-c3dhcHBlZA==", tarball: "http://127.0.0.1:9/payload.tgz" } }), { overrides: [], gate: nothing }),
    /is-number@7\.0\.0 is resolved from http:\/\/127\.0\.0\.1:9\/payload\.tgz, not the npm registry/,
  );
  await assert.rejects(checkResolution(base, lockfileOf({ "is-number@7.0.0": "sha512-c3dhcHBlZA==" }), { overrides: [], gate: nothing }), /changed what an already checked version is.*is-number@7\.0\.0/);
  // An override's fix skips the age gate, not the registry's bytes.
  const overrides = [{ selector: "is-number@7.0.0", version: "7.0.1", advisories: [] }];
  const badBytes = async () => ({ young: [], unknown: [], substituted: [{ pkg: "is-number@7.0.1", why: "locked as x, but the registry's tarball is y" }] });
  await assert.rejects(checkResolution(base, lockfileOf({ "is-number@7.0.1": "sha512-eA==" }), { overrides, gate: badBytes }), /is-number@7\.0\.1 \(locked as x/);
});

test("WORK's resolution and frozen install force pnpm's lockfile verification on", () => {
  const bin = path.join(scratch, "bin");
  const work = path.join(scratch, "work");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const record = path.join(scratch, "pnpm-args");
  fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$@" >> '${record}'\necho "lockfileVersion: '9.0'" > pnpm-lock.yaml\n`, { mode: 0o755 });
  resolveLockfile({ cwd: work, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.match(fs.readFileSync(record, "utf8"), /^install --lockfile-only --ignore-scripts --no-frozen-lockfile --no-trust-lockfile$/m);
  const source = fs.readFileSync(new URL("../lib/build.mjs", import.meta.url), "utf8");
  assert.match(source, /run\("pnpm", \["install", "--frozen-lockfile", "--no-trust-lockfile"/);
  assert.match(source, /pnpm_config_trust_lockfile: "false"/);
});
