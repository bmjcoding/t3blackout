// node --test test/: the strip engine (lib/strip-engine.mjs): rule writes stay
// inside the checkout, the host scan reads URLs the way a URL parser does, and
// the forbidden-string scan reads everything a packaged app ships.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyRules, findHosts, hostsIn, insideRoot, scanForbidden } from "../lib/strip-engine.mjs";
import { isReservedHost } from "../lib/build.mjs";
import loopback from "../lib/files/loopback.cjs";

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-build-strip-")));
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test("rules replace, write, transform and rebrand inside the checkout", () => {
  const root = scratch();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "const name = 'T3 Code';\n");
  const failures = quiet(() =>
    applyRules(root, [
      { id: "r", file: "src/a.ts", edits: [{ find: "const name", replace: "const title" }] },
      { id: "w", kind: "write", file: "src/new/b.ts", content: "export {};\n" },
      { id: "t", kind: "transform", file: "src/a.ts", transform: (text) => text.replace("title", "label") },
      { id: "b", kind: "rebrand", roots: ["src"], include: /\.ts$/, find: "T3 Code", replace: "T3 Blackout", minCount: 1 },
    ]),
  );
  assert.deepEqual(failures, []);
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "const label = 'T3 Blackout';\n");
  assert.equal(fs.readFileSync(path.join(root, "src", "new", "b.ts"), "utf8"), "export {};\n");
});

test("a missing anchor is drift, and a regex anchor carries its pattern", () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, "a.ts"), "x\n");
  const failures = quiet(() => applyRules(root, [{ id: "re", file: "a.ts", edits: [{ find: /cloud\(\w+\)/, replace: "" }] }]));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].anchor, "cloud\\(\\w+\\)");
  assert.ok(failures[0].pattern instanceof RegExp);
});

test("BUILD-11: a symlink in the checkout never redirects a rule's write", () => {
  const root = scratch();
  const outside = scratch();
  const victim = path.join(outside, "victim.png");
  fs.writeFileSync(victim, "keep me");
  // The target itself a symlink (an icon pointing at your file).
  fs.mkdirSync(path.join(root, "assets"));
  fs.symlinkSync(victim, path.join(root, "assets", "icon.png"));
  assert.throws(() => quiet(() => applyRules(root, [{ id: "icon", kind: "write", overwrite: true, file: "assets/icon.png", content: "pwned" }])), /symlink/);
  // An ancestor a symlink to a folder outside.
  fs.symlinkSync(outside, path.join(root, "linked"));
  assert.throws(() => quiet(() => applyRules(root, [{ id: "dir", kind: "write", overwrite: true, file: "linked/victim.png", content: "pwned" }])), /symlink/);
  assert.throws(() => quiet(() => applyRules(root, [{ id: "edit", file: "linked/victim.png", edits: [{ find: "keep", replace: "lose" }] }])), /symlink/);
  // `..` and absolute paths.
  assert.throws(() => insideRoot(root, "../escape.txt"), /outside the checkout/);
  assert.throws(() => insideRoot(root, victim), /outside the checkout/);
  // A rebrand walks past symlinks instead of following them.
  fs.writeFileSync(path.join(outside, "brand.ts"), "T3 Code");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "real.ts"), "T3 Code");
  fs.symlinkSync(path.join(outside, "brand.ts"), path.join(root, "web", "link.ts"));
  quiet(() => applyRules(root, [{ id: "b", kind: "rebrand", roots: ["web"], include: /\.ts$/, find: "T3 Code", replace: "T3 Blackout", minCount: 1 }]));
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
  assert.equal(fs.readFileSync(path.join(outside, "brand.ts"), "utf8"), "T3 Code");
  assert.equal(fs.readFileSync(path.join(root, "web", "real.ts"), "utf8"), "T3 Blackout");
});

test("BUILD-06: hosts are read the way a URL parser reads them", () => {
  const cases = {
    "https://example.com@unreviewed.tld/upload": ["unreviewed.tld"],
    "https://u:p@x.example.dev:8443/": ["x.example.dev"],
    "https://example。com/x": ["example.com"],
    "HTTPS://API.GitHub.com/": ["api.github.com"],
    "https://example.com./": ["example.com"],
    "https://%65xample.com/": ["example.com"],
    "https://bücher.de/": ["xn--bcher-kva.de"],
    "https://xn--80ak6aa92e.xn--p1ai/": ["xn--80ak6aa92e.xn--p1ai"],
    "http://10.0.0.5:80/": ["10.0.0.5"],
    "http://0x7f.1/": ["127.0.0.1"],
    "http://[::1]:3000/": ["::1"],
    "`https://${region}.collector.tld/x`": ["collector.tld"],
    "`https://${user}@evil.tld`": ["evil.tld"],
    "`https://api.example.net:${port}/`": ["api.example.net"],
    'credentials["https://auth.x.ai::b1a00492"]': ["auth.x.ai"],
    "`https://${host}/`": [],
    '"https://" + host': [],
    "http://localhost:3000": [],
  };
  for (const [text, hosts] of Object.entries(cases)) assert.deepEqual(hostsIn(text).map((h) => h.host), hosts, text);
});

test("findHosts names where each host first appears, skipping tests and links out of the checkout", () => {
  const root = scratch();
  const outside = scratch();
  fs.mkdirSync(path.join(root, "apps", "web", "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "web", "a.ts"), "\nfetch('https://Telemetry.Example.org/v1')\n");
  fs.writeFileSync(path.join(root, "apps", "web", "test", "b.ts"), "fetch('https://test-only.tld/')");
  fs.writeFileSync(path.join(outside, "c.ts"), "fetch('https://outside.tld/')");
  fs.symlinkSync(path.join(outside, "c.ts"), path.join(root, "apps", "web", "c.ts"));
  const hosts = findHosts(root, ["apps"]);
  assert.deepEqual([...hosts], [["telemetry.example.org", "apps/web/a.ts:2"]]);
});

test("BUILD-07: example.com/net/org need a known-hosts entry; reserved TLDs and loopback don't", () => {
  for (const host of ["x.invalid", "t3-boot.test", "foo.localhost", "FOO.LOCALHOST.", "a.example", "127.0.0.1", "127.9.9.9", "0.0.0.0", "::1", "::"]) {
    assert.equal(isReservedHost(host), true, host);
  }
  for (const host of ["example.com", "example.net", "api.example.org", "127.collector.attacker.tld", "10.0.0.1", "169.254.169.254", "fe80::1"]) {
    assert.equal(isReservedHost(host), false, host);
  }
  assert.equal(loopback.isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(loopback.isLoopbackAddress("0:0:0:0:0:0:0:1"), true);
  assert.equal(loopback.isLoopbackAddress("::ffff:10.0.0.1"), false);
  assert.equal(loopback.isLoopbackAddress("127.collector.tld"), false);
});

test("BUILD-10: the forbidden scan reads unpacked node_modules, binaries, any case, UTF-16", () => {
  const root = scratch();
  const unpacked = path.join(root, "Resources", "app.asar.unpacked", "node_modules", "x");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, "entry.js"), "fetch('https://ingest.t3.codes/e')");
  fs.writeFileSync(path.join(unpacked, "addon.node"), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("INGEST.T3.CODES"), Buffer.from([0])]));
  fs.writeFileSync(path.join(root, "Resources", "sidecar"), Buffer.from("us.i.posthog.com", "utf16le"));
  // A needle straddling the scanner's 8 MiB read boundary.
  const big = Buffer.alloc((8 << 20) + 64, 0x20);
  big.write("ingest.t3.codes", (8 << 20) - 5, "latin1");
  fs.writeFileSync(path.join(root, "Resources", "big.bin"), big);
  // Not followed: a symlink to a file outside.
  const outside = scratch();
  fs.writeFileSync(path.join(outside, "elsewhere.js"), "ingest.t3.codes");
  fs.symlinkSync(path.join(outside, "elsewhere.js"), path.join(root, "Resources", "link.js"));
  // The documented limit: a name built at runtime isn't a literal to find.
  fs.writeFileSync(path.join(root, "Resources", "split.js"), "const host = 'ingest.' + 't3.codes';");
  const hits = scanForbidden([path.join(root, "Resources")], ["ingest.t3.codes", "us.i.posthog.com"]).map((hit) => path.relative(root, hit.split(": ")[0]) + ": " + hit.split(": ")[1]);
  assert.deepEqual(hits.sort(), [
    "Resources/app.asar.unpacked/node_modules/x/addon.node: ingest.t3.codes",
    "Resources/app.asar.unpacked/node_modules/x/entry.js: ingest.t3.codes",
    "Resources/big.bin: ingest.t3.codes",
    "Resources/sidecar: us.i.posthog.com (UTF-16)",
  ]);
});
