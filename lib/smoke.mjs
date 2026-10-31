// Zero-egress smoke test, identical on macOS and Linux.
//
// Boots the freshly built server with lib/files/tripwire.cjs preloaded, an empty
// HOME (no ~/.claude or ~/.codex credentials, so no harness traffic) and a PATH
// without the harness CLIs. Whatever still tries to reach the network is T3's
// own code: a phone-home upstream added that no rule covers yet. That fails the
// update. Unstripped upstream trips it within seconds (PostHog, GitHub).
//
// What it covers, and what it doesn't: it runs WORK's built server
// (apps/server/dist/bin.mjs under this node), not the packaged Electron app, and
// watches only its startup: an empty profile, OBSERVE_MS after it first answers.
// The desktop's main process, code paths that need a stored configuration, a
// signed-in provider or someone using the app, and anything that starts later
// are outside it, as is what the tripwire can't see (native code, programs
// other than known network clients). The literal scan of the packaged app
// (scanForbidden) and the strip rules are the checks for those.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ROOT, STATE, WORK, freePort, log, sleepUnless as wait } from "./util.mjs";

const TRIPWIRE = path.join(ROOT, "lib", "files", "tripwire.cjs");
// Background refreshes (manifests, rate tables, update checks) start after boot.
const OBSERVE_MS = 20_000;
const STARTUP_MS = 90_000;
const STOP_MS = 5_000;

/** NODE_OPTIONS that load the tripwire into a process and every Node process it starts. */
export const tripwireOptions = () => `--require ${JSON.stringify(TRIPWIRE)}`;

/** How a process ended, for an error message. */
export const describeExit = ({ code, signal, error }) => (error ? `couldn't start (${error.message})` : signal ? `was killed by ${signal}` : `exited with ${code}`);

/** `child`'s end: `ended` settles once it exits (by code or signal) or fails to start; `exit` says how. */
function track(child) {
  const life = { exit: null };
  life.ended = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve((life.exit ??= { code, signal })));
    child.once("error", (error) => resolve((life.exit ??= { error })));
  });
  return life;
}

/** GET / once; the body when it answers 200, else null. */
async function answer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Stops `child` if it's still running: SIGTERM, then SIGKILL; never waits unbounded. */
async function stop(child, life) {
  if (life.exit) return;
  // A server stuck before activation also ignores SIGTERM; don't hang on it.
  child.kill("SIGTERM");
  await wait(STOP_MS, life.ended);
  if (life.exit) return;
  child.kill("SIGKILL");
  await wait(STOP_MS, life.ended);
}

/**
 * Starts `node <args>` and watches it: waits up to `startupMs` for GET / on
 * `port` to answer, passes the HTML to `check` (which may throw), then watches
 * for `observeMs`. Throws if the server exits at any point before it's stopped,
 * on its own or by a signal (SIGTERM, SIGSEGV, SIGKILL), or no longer answers
 * at the end. Always stops it. `out`: a file descriptor for its output.
 */
export async function observeServer({ args, env, port, out, check = () => {}, observeMs = OBSERVE_MS, startupMs = STARTUP_MS }) {
  const child = childProcess.spawn(process.execPath, args, { env, stdio: ["ignore", out, out] });
  const life = track(child);
  try {
    let html = null;
    for (const deadline = Date.now() + startupMs; html === null && !life.exit && Date.now() < deadline; ) {
      html = await answer(port);
      if (html === null) await wait(1000, life.ended);
    }
    if (life.exit) throw new Error(`server ${describeExit(life.exit)} during the smoke test; see state/smoke.log`);
    if (html === null) throw new Error("built server never answered GET / (hung startup?); see state/smoke.log");
    check(html);
    await wait(observeMs, life.ended);
    if (life.exit) throw new Error(`server ${describeExit(life.exit)} after it answered; see state/smoke.log`);
    if ((await answer(port)) === null) throw new Error("built server stopped answering GET / while it was watched; see state/smoke.log");
    if (life.exit) throw new Error(`server ${describeExit(life.exit)} after it answered; see state/smoke.log`);
    return html;
  } finally {
    await stop(child, life);
  }
}

/** The tripwire log's attempts, as [{ kind, host, port, pid }]. */
export const readAttempts = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

export async function smokeTest() {
  log(`smoke test: booting the built server with the network tripwire (its startup, ${OBSERVE_MS / 1000} s, empty profile)`);
  const entry = path.join(WORK, "apps", "server", "dist", "bin.mjs");
  if (!fs.existsSync(entry)) throw new Error(`no built server at ${entry}; run \`t3blackout update\``);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-smoke-"));
  const tripLog = path.join(home, "tripwire.jsonl");
  const port = await freePort();
  const out = fs.openSync(path.join(STATE, "smoke.log"), "w");
  let attempts;
  try {
    await observeServer({
      args: [entry, "--base-dir", path.join(home, "t3"), "--port", String(port), "--no-browser", "--mode", "web", home],
      port,
      env: {
        HOME: home,
        USER: process.env.USER ?? "",
        TMPDIR: os.tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        NODE_OPTIONS: tripwireOptions(),
        T3BLACKOUT_TRIPWIRE_LOG: tripLog,
      },
      out,
      check: (html) => {
        if (!html.includes('http-equiv="Content-Security-Policy"')) throw new Error("served index.html is missing the t3blackout CSP");
      },
    });
    attempts = readAttempts(tripLog);
  } finally {
    fs.closeSync(out);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (attempts.length) {
    const hosts = [...new Set(attempts.map((a) => `${a.host}${a.port ? `:${a.port}` : ""} (${a.kind})`))];
    throw new Error(
      `the built server tried to reach the network on its own:\n` +
        hosts.map((h) => `  - ${h}`).join("\n") +
        "\nNo harness credentials are visible to this test, so this is T3's own traffic.\n" +
        "Add a strip rule for it in lib/rules.mjs, then rerun.",
    );
  }
  log(`smoke test passed: the built server answered with the CSP and made no outbound attempt in its first ${OBSERVE_MS / 1000} s (startup only; lib/smoke.mjs says what that leaves out)`);
}
