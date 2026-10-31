// Before/after screenshots of the app, for the drift report: the installed build
// and the new one each boot their own server (no network, an empty profile, the
// tripwire loaded), headless Chrome pairs with each and photographs the same
// screens, and each pair gets a picture of what changed. Chrome is driven over
// the DevTools protocol, so nothing needs installing. Best effort: a screen that
// can't be captured is reported as such, and never fails an update. What the
// tripwire saw each server try is read before its scratch folder goes, and an
// outbound attempt by the new build's packaged server does fail the update
// (packagedEgress, in bin/t3blackout). Every
// DevTools request has a deadline and fails the moment Chrome goes away, and
// every server and browser is stopped within bounded time, so a hung Chrome
// can't hold an update (and its lock) open.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readAttempts } from "./smoke.mjs";
import { ROOT, freePort, log, sleep, sleepUnless } from "./util.mjs";

const TRIPWIRE = path.join(ROOT, "lib", "files", "tripwire.cjs");
const VIEWPORT = { width: 1280, height: 820 };
/** How long one DevTools request, a server's or Chrome's start, and a stop may take. */
const CDP_TIMEOUT_MS = 30_000;
const SERVER_START_MS = 90_000;
const STOP_MS = 5_000;

/** Settles when `child` has exited (by code or signal) or failed to start. */
const exitOf = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.once("error", resolve);
  });

/** SIGTERM (or straight to SIGKILL with `force`), then SIGKILL; waits at most twice STOP_MS. */
async function stopProcess(child, exited, { force = false } = {}) {
  const done = () => child.exitCode !== null || child.signalCode !== null;
  if (done()) return;
  if (!force) {
    child.kill("SIGTERM");
    await sleepUnless(STOP_MS, exited);
    if (done()) return;
  }
  child.kill("SIGKILL");
  await sleepUnless(STOP_MS, exited);
}

/** Rejects with `message` after `ms` unless cancelled; `cancel` clears the timer. */
function deadline(ms, message) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * The screens photographed for every build. `hover`: a selector to point at
 * first. `clip`: selectors whose area (together) is photographed close up, at
 * twice the size. `height`: a taller window, for settings pages that scroll.
 * `features`: which features (lib/features.mjs) show on it.
 */
export const SCREENS = [
  {
    name: "home",
    label: "Home",
    path: "/",
    features: ["wordmark", "stage-art", "send-button", "styles", "glow-sidebar", "glow-update", "names"],
  },
  {
    name: "composer",
    label: "Composer, attach button hovered (close up)",
    path: "/",
    hover: '[aria-label="Attach files"]',
    clip: ['[data-slot="composer-host"]', '[aria-label="Attach files"]'],
    features: ["glow-attach", "send-button", "styles"],
  },
  {
    name: "version",
    label: "Version stamp, hovered (close up)",
    path: "/",
    hover: ".t3b-version-stamp",
    clip: [".t3b-version-stamp", ".t3b-version-card"],
    features: ["version-stamp", "brand-file"],
  },
  {
    name: "appearance",
    height: 2000,
    label: "Settings → Appearance",
    path: "/settings/appearance",
    features: ["interface-settings", "names"],
  },
  {
    name: "general",
    height: 2000,
    label: "Settings → General",
    path: "/settings/general",
    features: [],
  },
];

/** The browser the screenshots are taken with, or null. */
export function findChrome() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    if (candidate.startsWith("/")) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const found = childProcess.spawnSync("/bin/sh", ["-c", `command -v ${candidate}`], { encoding: "utf8" }).stdout?.trim();
      if (found) return found;
    }
  }
  return null;
}

/**
 * Boots an app's server like the smoke test does; resolves once it prints its
 * pairing URL. By default it gets an empty profile and opens an empty folder
 * named "project". `baseDir`: a profile to use instead (then no folder opens).
 * `env`: added to the environment. `preload`: more modules to --require.
 * `wrap(command, args)`: runs it inside something, returning [command, args]
 * (the preview's sandbox).
 */
export async function bootServer({ exec, entry, electron }, home, { baseDir = null, env = {}, preload = [], wrap = null } = {}) {
  const port = await freePort();
  const tripLog = path.join(home, "tripwire.jsonl");
  // Both sides open a folder of the same name, so the project's name and badge match.
  const workspace = baseDir ? null : path.join(home, "project");
  if (workspace) fs.mkdirSync(workspace, { recursive: true });
  const args = [...[TRIPWIRE, ...preload].flatMap((module) => ["--require", module]), entry, "--base-dir", baseDir ?? path.join(home, "t3"), "--port", String(port), "--no-browser", "--mode", "web", ...(workspace ? [workspace] : [])];
  const [command, commandArgs] = wrap ? wrap(exec, args) : [exec, args];
  const child = childProcess.spawn(command, commandArgs, {
    cwd: home,
    env: {
      HOME: home,
      USER: process.env.USER ?? "",
      TMPDIR: os.tmpdir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      T3BLACKOUT_TRIPWIRE_LOG: tripLog,
      ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = exitOf(child);
  let output = "";
  const pairing = new Promise((resolve, reject) => {
    const scan = (chunk) => {
      output = (output + chunk).slice(-20_000);
      const url = /pairingUrl:\s*(\S+)/.exec(output)?.[1];
      if (url) resolve(url.replace("localhost", "127.0.0.1"));
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    exited.then(() => {
      const how = child.signalCode ? `was killed by ${child.signalCode}` : `exited with ${child.exitCode}`;
      reject(new Error(`server ${how}: ${output.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
  const timeout = deadline(SERVER_START_MS, `server printed no pairing URL in ${SERVER_START_MS / 1000} s`);
  const stop = () => stopProcess(child, exited);
  try {
    return { pairingUrl: await Promise.race([pairing, timeout.promise]), stop, tripLog };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    timeout.cancel();
  }
}

/**
 * A DevTools protocol client over `ws` (a WebSocket, or anything with send and
 * the on* handlers): `send(method, params, sessionId)` rejects after
 * `timeoutMs`, and every pending request rejects as soon as the socket closes or
 * errors or `gone` (say, Chrome exiting) settles. `listeners` hear events.
 */
export function cdpClient(ws, { timeoutMs = CDP_TIMEOUT_MS, gone = null } = {}) {
  let nextId = 0;
  let failure = null;
  const pending = new Map();
  const listeners = new Set();
  const fail = (error) => {
    failure ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    pending.clear();
  };
  ws.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    const waiting = data.id !== undefined ? pending.get(data.id) : undefined;
    if (!waiting) {
      for (const listener of listeners) listener(data);
      return;
    }
    pending.delete(data.id);
    clearTimeout(waiting.timer);
    if (data.error) waiting.reject(new Error(data.error.message));
    else waiting.resolve(data.result);
  };
  ws.onclose = () => fail(new Error("Chrome's DevTools connection closed"));
  ws.onerror = () => fail(new Error("Chrome's DevTools connection failed"));
  gone?.then(() => fail(new Error("Chrome exited")));
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome didn't answer ${method} within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  return { send, listeners, fail, pending };
}

/** The DevTools WebSocket URL Chrome prints on stderr; rejects if it exits or takes over `ms`. */
function devtoolsUrl(child, exited, ms) {
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => finish(new Error("Chrome didn't start")), ms);
    const scan = (chunk) => {
      err = (err + chunk).slice(-20_000);
      const url = /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1];
      if (url) finish(null, url);
    };
    function finish(error, url) {
      clearTimeout(timer);
      child.stderr.off("data", scan);
      // Keep draining stderr so Chrome never blocks writing to it.
      child.stderr.resume();
      if (error) reject(error);
      else resolve(url);
    }
    child.stderr.on("data", scan);
    exited.then(() => finish(new Error(`Chrome exited (${child.signalCode ?? child.exitCode})`)));
  });
}

/** Resolves once `ws` is open; rejects on its error or after `ms`. */
function opened(ws, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("couldn't connect to Chrome")), ms);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("couldn't connect to Chrome"));
    };
  });
}

/**
 * Chrome with the DevTools protocol over a WebSocket: headless, or with
 * `window` (extra flags) a window of its own. `exited` settles when it quits;
 * `close()` quits it (killing it if need be) within bounded time.
 */
export async function launchChrome(binary, profile, { window = null } = {}) {
  const child = childProcess.spawn(
    binary,
    [
      ...(window ?? ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-sync",
      "--disable-features=OptimizationHints,MediaRouter,Translate",
      "--metrics-recording-only",
      "--no-pings",
      ...(window ? [] : ["--hide-scrollbars"]),
      "--force-color-profile=srgb",
      ...(window ? [] : ["about:blank"]),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = exitOf(child);
  let ws = null;
  try {
    ws = new WebSocket(await devtoolsUrl(child, exited, CDP_TIMEOUT_MS));
    await opened(ws, CDP_TIMEOUT_MS);
  } catch (error) {
    ws?.close();
    await stopProcess(child, exited, { force: true });
    throw error;
  }
  const { send, listeners } = cdpClient(ws, { gone: exited });
  const close = async () => {
    // Asked nicely first, but never waited on for long.
    await Promise.race([send("Browser.close").catch(() => {}), sleepUnless(STOP_MS, exited)]);
    ws.close();
    await stopProcess(child, exited, { force: true });
  };
  return { send, listeners, close, exited };
}

/** A tab: navigate, wait, hover, photograph. */
async function openTab(chrome) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "dark" },
    ],
  });
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const waitFor = async (expression, ms = 15_000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) {
      if (await evaluate(expression).catch(() => false)) return true;
    }
    return false;
  };
  return {
    evaluate,
    waitFor,
    resize: (height) => send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, height, deviceScaleFactor: 1, mobile: false }),
    async goto(url) {
      await send("Page.navigate", { url });
      await waitFor("document.readyState === 'complete'");
    },
    async hover(selector) {
      const point = await evaluate(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
      );
      if (!point) return false;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      return true;
    },
    /** The area the `clip` selectors cover together, padded, or null if none is on screen. */
    async areaOf(selectors) {
      return evaluate(`(() => {
        const rects = ${JSON.stringify(selectors)}.flatMap((s) => [...document.querySelectorAll(s)]).map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
        if (!rects.length) return null;
        const pad = 24;
        const x = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad), y = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad);
        const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)) + pad), bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)) + pad);
        return { x, y, width: right - x, height: bottom - y, scale: 2 };
      })()`);
    },
    async shot(clip = null) {
      const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 82, ...(clip ? { clip } : {}) });
      return `data:image/jpeg;base64,${data}`;
    },
    close: () => chrome.send("Target.closeTarget", { targetId }),
  };
}

/**
 * The theme the screenshots and the preview use, set before the app reads it:
 * the default theme (Ink) in dark, picked explicitly so it doesn't follow the
 * system. Upstream accepts only light, dark, system or a defined theme's id
 * (apps/web/src/hooks/useTheme.ts); anything else falls back to its default.
 */
export const PREFERENCES = `(() => {
  localStorage.setItem("t3code:theme", "dark");
  localStorage.setItem("t3code:theme-follow-system", "false");
  localStorage.setItem("t3code:theme-appearance-mode", "dark");
  localStorage.removeItem("t3code:theme-halves:v1");
  return true;
})()`;

/** True once the app has applied PREFERENCES' theme. */
export const THEME_APPLIED = "document.documentElement.classList.contains('dark')";

/** Pairs with one server and photographs every screen; returns { name: dataUrl | null }. */
async function photograph(chrome, server, screens) {
  const tab = await openTab(chrome);
  try {
    const origin = new URL(server.pairingUrl).origin;
    await tab.goto(server.pairingUrl);
    if (!(await tab.waitFor("!location.pathname.startsWith('/pair')", 30_000))) throw new Error("pairing didn't finish");
    await tab.evaluate(PREFERENCES);
    const shots = {};
    for (const screen of screens) {
      try {
        await tab.resize(screen.height ?? VIEWPORT.height);
        await tab.goto(origin + screen.path);
        // The app renders after its connection settles; give fonts and data a moment.
        await tab.waitFor("document.querySelector('#root')?.childElementCount > 0", 20_000);
        const themed = await tab.waitFor(THEME_APPLIED, 5_000);
        await sleep(2500);
        if (screen.hover && !(await tab.hover(screen.hover))) {
          shots[screen.name] = { image: null, note: `nothing matches ${screen.hover}` };
          continue;
        }
        if (screen.hover) await sleep(1200);
        const clip = screen.clip ? await tab.areaOf(screen.clip) : null;
        shots[screen.name] = { image: await tab.shot(clip), note: themed ? null : "the dark theme didn't apply, so this isn't the usual comparison" };
      } catch (error) {
        shots[screen.name] = { image: null, note: error.message };
      }
    }
    return shots;
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Compares two screenshots in the browser; returns { changed (0-1), diff (data URL) }. */
async function compare(chrome, before, after) {
  const tab = await openTab(chrome);
  try {
    return await tab.evaluate(`(async () => {
      const load = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
      const [a, b] = await Promise.all([load(${JSON.stringify(before)}), load(${JSON.stringify(after)})]);
      const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
      const pixels = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
      const pa = pixels(a), pb = pixels(b);
      const out = new OffscreenCanvas(w, h), ctx = out.getContext("2d");
      ctx.drawImage(b, 0, 0);
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(0, 0, w, h);
      const overlay = ctx.getImageData(0, 0, w, h), od = overlay.data;
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
        if (d > 48) { changed++; od[i] = 255; od[i + 1] = 92; od[i + 2] = 40; od[i + 3] = 255; }
      }
      ctx.putImageData(overlay, 0, 0);
      const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.82 });
      const diff = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
      return { changed: changed / (w * h), diff };
    })()`);
  } finally {
    await tab.close().catch(() => {});
  }
}

/**
 * Photographs `before` and `after` ({ exec, entry, electron } for each app's
 * server). Returns { screens: [{ name, label, features, before, after, diff,
 * changed, note }], note, attempts: { before, after } } where `note` says why
 * there are none and `attempts` is what the tripwire blocked each server
 * trying ([{ kind, host, port, pid }]), read once it has stopped.
 * `chromeBinary`: the browser to use (findChrome's, by default).
 */
export async function captureLooks({ before, after }, { chromeBinary = findChrome() } = {}) {
  if (!chromeBinary) return { screens: [], note: "No Chrome or Chromium found, so there are no screenshots.", attempts: { before: [], after: [] } };
  log("screenshots: booting the installed and the new build's servers");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-looks-"));
  const servers = [];
  const attempts = { before: [], after: [] };
  let chrome = null;
  let result;
  try {
    const sides = await bootSides({ before, after }, scratch, servers);
    if (!sides.after) result = { screens: [], note: "The new build's server didn't start for screenshots." };
    else {
      chrome = await launchChrome(chromeBinary, path.join(scratch, "chrome"));
      const shots = {};
      for (const side of Object.keys(sides)) shots[side] = await photograph(chrome, sides[side], SCREENS);
      const screens = await pairShots(chrome, shots);
      log(`screenshots: ${screens.filter((s) => s.after).length} of ${screens.length} screens captured`);
      result = { screens, note: null };
    }
  } catch (error) {
    log(`screenshots skipped: ${error.message}`);
    result = { screens: [], note: `Screenshots failed: ${error.message}` };
  } finally {
    await chrome?.close();
    await Promise.all(servers.map((server) => server.stop()));
    // Before the scratch folder goes: a server that never started may have tried too.
    for (const side of Object.keys(attempts)) attempts[side] = readAttempts(path.join(scratch, side, "tripwire.jsonl"));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const tried = attempts.after.length ? `The new build's server tried to reach the network: ${describeAttempts(attempts.after)}.` : null;
  return { ...result, note: [result.note, tried].filter(Boolean).join(" ") || null, attempts };
}

/** Attempts as "host:port (kind)", each once. */
export const describeAttempts = (attempts) => [...new Set(attempts.map((a) => `${a.host}${a.port ? `:${a.port}` : ""} (${a.kind})`))].join(", ");

/**
 * Why the new build mustn't be installed, from captureLooks' result: its packaged
 * server tried to leave the machine while it was photographed. Null otherwise.
 */
export function packagedEgress(looks) {
  const after = looks?.attempts?.after ?? [];
  if (!after.length) return null;
  return (
    `the new build's packaged server tried to reach the network while it was photographed: ${describeAttempts(after)}. ` +
    "No harness credentials are visible to it, so this is T3's own traffic. Nothing was installed; add a strip rule for it in lib/rules.mjs."
  );
}

/** Boots each side's server in its own home under `scratch`, adding each to `servers`; a side that won't start is left out. */
async function bootSides(apps, scratch, servers) {
  const sides = {};
  for (const [side, app] of Object.entries(apps)) {
    if (!app) continue;
    const home = path.join(scratch, side);
    fs.mkdirSync(home, { recursive: true });
    try {
      servers.push((sides[side] = await bootServer(app, home)));
    } catch (error) {
      log(`screenshots: the ${side === "before" ? "installed" : "new"} build's server didn't start: ${error.message}`);
    }
  }
  return sides;
}

/** Each screen's before and after, with what changed between them where both were captured. */
async function pairShots(chrome, shots) {
  const screens = [];
  for (const screen of SCREENS) {
    const b = shots.before?.[screen.name] ?? { image: null, note: "the installed build couldn't be started" };
    const a = shots.after[screen.name];
    const result = { name: screen.name, label: screen.label, features: screen.features, before: b.image, after: a.image, diff: null, changed: null, note: a.note ?? b.note };
    if (b.image && a.image) Object.assign(result, await compare(chrome, b.image, a.image));
    screens.push(result);
  }
  return screens;
}
