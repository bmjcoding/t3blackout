// node --test test/: what the screenshot servers try is read before their
// scratch folders go, and an outbound attempt by the new build's packaged
// server fails the update (BUILD2-13, SUPPLY2-09), even when the screenshots
// themselves fail.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { captureLooks, packagedEgress } from "../lib/looks.mjs";

/** A stand-in server: tries `host` (if any) through the tripwire, then prints its pairing URL and waits. */
function server(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r2-looks-"));
  const entry = path.join(dir, "server.cjs");
  const attempt = host ? `require("node:net").connect(443, ${JSON.stringify(host)}).on("error", () => {});` : "";
  fs.writeFileSync(entry, `${attempt}\nconsole.log("pairingUrl: http://localhost:1/pair#token=x");\nsetInterval(() => {}, 1000);`);
  return { exec: process.execPath, entry, electron: false };
}

test("BUILD2-13: the new build's attempts are read and fail the update, though the screenshots failed", async () => {
  const looks = await captureLooks({ before: server("installed.example.org"), after: server("phone-home.example.org") }, { chromeBinary: "/usr/bin/false" });
  assert.match(looks.note, /Screenshots failed/);
  assert.deepEqual(looks.attempts.after.map((a) => `${a.kind} ${a.host}:${a.port}`), ["connect phone-home.example.org:443"]);
  assert.deepEqual(looks.attempts.before.map((a) => a.host), ["installed.example.org"]);
  assert.match(looks.note, /The new build's server tried to reach the network: phone-home\.example\.org:443 \(connect\)/);
  assert.match(packagedEgress(looks), /packaged server tried to reach the network.*phone-home\.example\.org:443.*Nothing was installed/);
});

test("a quiet new build passes, and the installed build's own attempts don't hold the update", async () => {
  const looks = await captureLooks({ before: server("installed.example.org"), after: server(null) }, { chromeBinary: "/usr/bin/false" });
  assert.deepEqual(looks.attempts.after, []);
  assert.equal(packagedEgress(looks), null);
  assert.equal(packagedEgress({ screens: [], note: "No Chrome or Chromium found, so there are no screenshots." }), null);
});
