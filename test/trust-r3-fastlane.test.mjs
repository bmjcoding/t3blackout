// node --test test/: unverified npm provenance never earns trust (decision I,
// SUPPLY3-02). A registry that lies about provenance (a payload with no
// signature, certificate or log entry) can't open the fast lane by naming the
// usual repository from a new publisher: a change of publisher, a switch to npm
// trusted publishing included, waits out the minimum age. Mocked npm and OSV.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeFastLane, publisherContinuity } from "../lib/fastlane.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const REPO = "https://github.com/original/trusted";
const integrity = `sha512-${createHash("sha512").update("untrusted tarball").digest("base64")}`;

/**
 * npm metadata for `NAME` (npm metadata is cached per name: one per test): the usual
 * maintainer's aged 1.0.0, with provenance, and an hour-old 1.0.1 from `publisher`
 * with unsigned provenance naming the same repository.
 */
function lyingRegistry(NAME, publisher) {
  const meta = {
    versions: {
      "1.0.0": { _npmUser: { name: "maintainer" }, repository: REPO, dist: { attestations: { url: "https://registry.npmjs.org/attested" } } },
      "1.0.1": { _npmUser: { name: publisher }, repository: REPO, dist: { integrity, attestations: { url: "https://registry.npmjs.org/attested" } } },
    },
    time: { "1.0.0": "2026-10-01T00:00:00Z", "1.0.1": "2026-10-30T11:00:00Z" },
  };
  const statement = {
    subject: [{ name: `pkg:npm/${NAME}@1.0.1`, digest: { sha512: Buffer.from(integrity.split("-")[1], "base64").toString("hex") } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: REPO, ref: "refs/heads/main" } } } },
  };
  // No signature, certificate, signed checkpoint, inclusion proof or log entry.
  const unsigned = { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
  globalThis.fetch = async (url) => {
    if (String(url) === `https://registry.npmjs.org/${NAME}`) return Response.json(meta);
    if (String(url).includes("/attestations/")) return Response.json(unsigned);
    if (String(url) === "https://api.osv.dev/v1/querybatch") return Response.json({ results: [{}] });
    throw new Error(`unexpected request ${url}`);
  };
}

test("SUPPLY3-02: a new publisher with unverified provenance gets no fast lane", async () => {
  const NAME = "trust-r3-forged-provenance";
  lyingRegistry(NAME, "GitHub Actions");
  const trust = await publisherContinuity(NAME, "1.0.1", { accepted: ["1.0.0"], now: NOW });
  assert.equal(trust.ok, false);
  assert.match(trust.summary, /published by GitHub Actions, not by maintainer/);
  const waive = makeFastLane({ basePackages: [`${NAME}@1.0.0`], openAdvisories: [{ id: "GHSA-r3-known-fix", packages: [{ pkg: `${NAME}@1.0.0`, fixed: ["1.0.1"] }] }], now: NOW });
  assert.equal(await waive(`${NAME}@1.0.1`), null, "the hour-old fix waits out the minimum age");
});

test("the usual publisher keeps the fast lane; what its provenance names is reported as unverified", async () => {
  const NAME = "trust-r3-usual-publisher";
  lyingRegistry(NAME, "maintainer");
  const trust = await publisherContinuity(NAME, "1.0.1", { accepted: ["1.0.0"], now: NOW });
  assert.deepEqual(trust, { ok: true, summary: `publisher maintainer, provenance (unverified) names ${REPO} refs/heads/main` });
});
