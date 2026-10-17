// Zero-egress smoke test, identical on macOS and Linux.
//
// Boots the freshly built server with lib/files/tripwire.cjs preloaded, an empty
// HOME (no ~/.claude or ~/.codex credentials, so no harness traffic) and a PATH
// without the harness CLIs. Whatever still tries to reach the network is T3's
// own code: a phone-home upstream added that no rule covers yet. That fails the
// update. Unstripped upstream trips it within seconds (PostHog, GitHub).

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ROOT, STATE, WORK, freePort, log, sleep } from "./util.mjs";

const TRIPWIRE = path.join(ROOT, "lib", "files", "tripwire.cjs");
// Background refreshes (manifests, rate tables, update checks) start after boot.
const OBSERVE_MS = 20_000;

export async function smokeTest() {
  log("smoke test: booting the built server with the network tripwire");
  const entry = path.join(WORK, "apps", "server", "dist", "bin.mjs");
  if (!fs.existsSync(entry)) throw new Error(`no built server at ${entry}; run \`t3blackout update\``);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-smoke-"));
  const tripLog = path.join(home, "tripwire.jsonl");
  const port = await freePort();
  const out = fs.openSync(path.join(STATE, "smoke.log"), "w");
  const child = childProcess.spawn(
    process.execPath,
    [entry, "--base-dir", path.join(home, "t3"), "--port", String(port), "--no-browser", "--mode", "web", home],
    {
      env: {
        HOME: home,
        USER: process.env.USER ?? "",
        TMPDIR: os.tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        NODE_OPTIONS: `--require ${TRIPWIRE}`,
        T3BLACKOUT_TRIPWIRE_LOG: tripLog,
      },
      stdio: ["ignore", out, out],
    },
  );
  try {
    let html = null;
    const deadline = Date.now() + 90_000;
    while (html === null && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("server exited during smoke test; see state/smoke.log");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) html = await res.text();
      } catch {}
      if (html === null) await sleep(1000);
    }
    if (html === null) throw new Error("built server never answered GET / (hung startup?); see state/smoke.log");
    if (!html.includes('http-equiv="Content-Security-Policy"')) {
      throw new Error("served index.html is missing the t3blackout CSP");
    }
    await sleep(OBSERVE_MS);
    if (child.exitCode !== null) throw new Error("server crashed after boot; see state/smoke.log");
  } finally {
    // A server stuck before activation also ignores SIGTERM; don't hang on it.
    child.kill("SIGTERM");
    const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    if ((await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) === false) {
      child.kill("SIGKILL");
    }
  }
  const attempts = fs.existsSync(tripLog)
    ? fs
        .readFileSync(tripLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  fs.rmSync(home, { recursive: true, force: true });
  if (attempts.length) {
    const hosts = [...new Set(attempts.map((a) => `${a.host}${a.port ? `:${a.port}` : ""} (${a.kind})`))];
    throw new Error(
      `the built server tried to reach the network on its own:\n` +
        hosts.map((h) => `  - ${h}`).join("\n") +
        "\nNo harness credentials are visible to this test, so this is T3's own traffic.\n" +
        "Add a strip rule for it in lib/rules.mjs, then rerun.",
    );
  }
  log("smoke test passed: server answered with CSP, zero outbound attempts");
}
