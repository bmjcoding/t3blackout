// node --test test/*.test.mjs: CI's own checks (.github/scripts/) and which
// channels a machine builds (lib/channels.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { unpinned, usesValues } from "../.github/scripts/check-action-pins.mjs";
import { decodeTemplate, runnerFromTunnel } from "../.github/scripts/render-runner.mjs";
import { destinationOf } from "../.github/scripts/stripped-tests.mjs";
import { channelPolicy, unpinnedProblem } from "../lib/channels.mjs";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

test("action pins are read the way YAML reads them: quoted or not, comments stripped (PIPE-22)", () => {
  const workflow = [
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    `      - uses: "actions/setup-node@${SHA}"`,
    `      - uses: 'actions/cache@${SHA}' # quoted, then a comment`,
    "      - uses: actions/upload-artifact@v4",
    "      - uses: ./local-action",
    "      - uses: docker://alpine:3.20",
    "      - run: |",
    "          echo uses: nothing",
  ].join("\n");
  const values = usesValues(workflow);
  assert.deepEqual(values.map((v) => v.value), [`actions/checkout@${SHA}`, `actions/setup-node@${SHA}`, `actions/cache@${SHA}`, "actions/upload-artifact@v4", "./local-action", "docker://alpine:3.20"]);
  assert.deepEqual(values.map((v) => unpinned(v.value)), [null, null, null, "not pinned to a full commit SHA", null, "docker image without a sha256 digest"]);
  assert.equal(unpinned(`actions/checkout@${SHA.slice(0, 39)}`), "not pinned to a full commit SHA");
});

test("the runner fragment decodes as its template literal would, and refuses what would break it (PIPE-21)", () => {
  assert.equal(decodeTemplate('A="\\${HOME:-x}" printf \'%s\\\\n\' "$A"'), 'A="${HOME:-x}" printf \'%s\\n\' "$A"');
  assert.throws(() => decodeTemplate('echo "${HOME}"'), /unescaped \$\{/);
  assert.throws(() => decodeTemplate("echo `date`"), /unescaped backtick/);
  const tunnel = "const X = 1;\nconst REMOTE_RUNNER_SCRIPT = `#!/bin/sh\nset -eu\n@@T3_NODE_ENV_SCRIPT@@\nV=@@T3_ARCHIVE_VERSION@@\necho \"\\${V}\"\n`;\nconst Y = `${X}`;\n";
  assert.equal(runnerFromTunnel(tunnel), "#!/bin/sh\nset -eu\n:\nV=''\necho \"${V}\"\n");
  assert.throws(() => runnerFromTunnel("const Z = 1;"), /no REMOTE_RUNNER_SCRIPT/);
});

test("the injected SSH runner, rendered, parses as /bin/sh", () => {
  const fragment = fs.readFileSync(new URL("../lib/files/ssh-runner-blackout.sh", import.meta.url), "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-"));
  try {
    const file = path.join(dir, "runner.sh");
    fs.writeFileSync(file, `#!/bin/sh\n${decodeTemplate(fragment)}`);
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every stripped test says where in upstream it goes (APP-15)", () => {
  const dir = new URL("../test/stripped/", import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => /\.test\.tsx?$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) assert.match(destinationOf(fs.readFileSync(new URL(name, dir), "utf8"), name), /^(apps|packages)\//, name);
  assert.throws(() => destinationOf("// Copied to ../../etc/ in a stripped upstream checkout", "x.test.ts"), /doesn't start with/);
  assert.throws(() => destinationOf("// nothing here", "x.test.ts"), /doesn't start with/);
});

test("with a pin.json, a channel it doesn't pin is refused unless --unpinned (PIPE-12, SUPPLY-10)", () => {
  const pin = { version: 1, channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: "9".repeat(40), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } }, deviceTools: [] };
  assert.match(unpinnedProblem(pin, "stable", { soakHours: 48 }), /stable channel has no evaluated release.*switch the update track to nightly, or pass --unpinned/);
  assert.equal(unpinnedProblem(pin, "stable", { unpinned: true, soakHours: 48 }), null);
  assert.equal(unpinnedProblem(pin, "nightly", { soakHours: 48 }), null);
  assert.equal(unpinnedProblem(null, "stable", { soakHours: 48 }), null, "no pin.json: the legacy soak");
});

test("status names the pin and the gates that chose it, not a fixed soak (DOCS-26)", () => {
  const pin = { version: 1, channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: "97e35bcf23e4dcf34c2dcffadd37c08db0e01e52", evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } }, deviceTools: [] };
  const pinned = channelPolicy(pin, "nightly", { soakHours: 48, minAgeDays: 3 });
  assert.match(pinned, /^nightly: pinned to v0\.1\.6-nightly\.20261030\.3917 \(97e35bcf23\), evaluated 2026-10-30T17:46:51\.852Z: new dependencies at least 3 days old/);
  assert.doesNotMatch(pinned, /48h/);
  assert.match(channelPolicy(pin, "stable", { soakHours: 48, minAgeDays: 3 }), /^stable: not pinned, so updates are refused/);
  assert.match(channelPolicy(null, "stable", { soakHours: 48, minAgeDays: 3 }), /no pin\.json, so the newest release 48h old/);
});
