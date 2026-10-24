// Before/after screenshots of the app, for the drift report: the installed build
// and the new one each boot their own server (no network, an empty profile, the
// tripwire loaded), headless Chrome pairs with each and photographs the same
// screens, and each pair gets a picture of what changed. Chrome is driven over
// the DevTools protocol, so nothing needs installing. Best effort: a screen that
// can't be captured is reported as such, and never fails an update.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ROOT, freePort, log, sleep } from "./util.mjs";

const TRIPWIRE = path.join(ROOT, "lib", "files", "tripwire.cjs");
const VIEWPORT = { width: 1280, height: 820 };

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
    features: ["wordmark", "stage-art", "send-button", "backdrop", "themes", "styles", "glow-sidebar", "glow-update", "names"],
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
    features: ["backdrop-setting", "glass-setting", "themes", "names"],
  },
  {
    name: "general",
    height: 2000,
    label: "Settings → General",
    path: "/settings/general",
    features: [],
  },
  {
    name: "skills",
    height: 2000,
    label: "Settings → Skills",
    path: "/settings/skills",
    features: ["skills"],
  },
];

/** The browser the screenshots are taken with, or null. */
function findChrome() {
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

/** Boots an app's server like the smoke test does; resolves once it prints its pairing URL. */
async function bootServer({ exec, entry, electron }, home) {
  const port = await freePort();
  const tripLog = path.join(home, "tripwire.jsonl");
  // Both sides open a folder of the same name, so the project's name and badge match.
  const workspace = path.join(home, "project");
  fs.mkdirSync(workspace, { recursive: true });
  const child = childProcess.spawn(
    exec,
    ["--require", TRIPWIRE, entry, "--base-dir", path.join(home, "t3"), "--port", String(port), "--no-browser", "--mode", "web", workspace],
    {
      env: {
        HOME: home,
        USER: process.env.USER ?? "",
        TMPDIR: os.tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        T3BLACKOUT_TRIPWIRE_LOG: tripLog,
        ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const pairing = new Promise((resolve, reject) => {
    const scan = (chunk) => {
      output = (output + chunk).slice(-20_000);
      const url = /pairingUrl:\s*(\S+)/.exec(output)?.[1];
      if (url) resolve(url.replace("localhost", "127.0.0.1"));
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${output.trim().split("\n").slice(-3).join(" ")}`)));
  });
  const timeout = sleep(90_000).then(() => {
    throw new Error("server printed no pairing URL in 90 s");
  });
  const stop = async () => {
    child.kill("SIGTERM");
    const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    if ((await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) === false) child.kill("SIGKILL");
  };
  try {
    return { pairingUrl: await Promise.race([pairing, timeout]), stop, tripLog };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Headless Chrome with the DevTools protocol over a WebSocket. */
async function launchChrome(binary, profile) {
  const child = childProcess.spawn(
    binary,
    [
      "--headless=new",
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
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
      const url = /DevTools listening on (ws:\/\/\S+)/.exec(err)?.[1];
      if (url) resolve(url);
    });
    child.once("exit", (code) => reject(new Error(`Chrome exited with ${code}`)));
    setTimeout(() => reject(new Error("Chrome didn't start")), 30_000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't connect to Chrome"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    } else {
      for (const listener of listeners) listener(data);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const close = async () => {
    try {
      await send("Browser.close");
    } catch {}
    ws.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  return { send, listeners, close };
}

/** A tab: navigate, wait, hover, photograph. */
async function openTab(chrome) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
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

/** The theme and motion the screenshots use, set before the app reads them. */
const PREFERENCES = `(() => {
  localStorage.setItem("t3code:theme", "blackout");
  localStorage.setItem("t3code:theme-follow-system", "false");
  localStorage.removeItem("t3code:theme-halves:v1");
  return true;
})()`;

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
        await sleep(2500);
        if (screen.hover && !(await tab.hover(screen.hover))) {
          shots[screen.name] = { image: null, note: `nothing matches ${screen.hover}` };
          continue;
        }
        if (screen.hover) await sleep(1200);
        const clip = screen.clip ? await tab.areaOf(screen.clip) : null;
        shots[screen.name] = { image: await tab.shot(clip), note: null };
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
 * changed, note }], note } where `note` says why there are none.
 */
export async function captureLooks({ before, after }) {
  const chromeBinary = findChrome();
  if (!chromeBinary) return { screens: [], note: "No Chrome or Chromium found, so there are no screenshots." };
  log("screenshots: booting the installed and the new build's servers");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-looks-"));
  const servers = [];
  let chrome = null;
  try {
    const sides = {};
    for (const [side, app] of Object.entries({ before, after })) {
      if (!app) continue;
      const home = path.join(scratch, side);
      fs.mkdirSync(home, { recursive: true });
      try {
        servers.push((sides[side] = await bootServer(app, home)));
      } catch (error) {
        log(`screenshots: the ${side === "before" ? "installed" : "new"} build's server didn't start: ${error.message}`);
      }
    }
    if (!sides.after) return { screens: [], note: "The new build's server didn't start for screenshots." };
    chrome = await launchChrome(chromeBinary, path.join(scratch, "chrome"));
    const shots = {};
    for (const side of Object.keys(sides)) shots[side] = await photograph(chrome, sides[side], SCREENS);
    const screens = [];
    for (const screen of SCREENS) {
      const b = shots.before?.[screen.name] ?? { image: null, note: "the installed build couldn't be started" };
      const a = shots.after[screen.name];
      const result = { name: screen.name, label: screen.label, features: screen.features, before: b.image, after: a.image, diff: null, changed: null };
      result.note = a.note ?? b.note;
      if (b.image && a.image) Object.assign(result, await compare(chrome, b.image, a.image));
      screens.push(result);
    }
    log(`screenshots: ${screens.filter((s) => s.after).length} of ${screens.length} screens captured`);
    return { screens, note: null };
  } catch (error) {
    log(`screenshots skipped: ${error.message}`);
    return { screens: [], note: `Screenshots failed: ${error.message}` };
  } finally {
    await chrome?.close();
    await Promise.all(servers.map((server) => server.stop()));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
