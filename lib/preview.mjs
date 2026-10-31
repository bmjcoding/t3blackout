// A look at a build before it's installed (`t3blackout preview`). Its server
// boots in the OS sandbox (lib/platform: no network but localhost, no writes
// outside a scratch folder) with the tripwire loaded, against a copy of your
// profile: your projects, threads and settings, not your secrets. It opens in a
// Chrome window of its own; closing the window stops it and deletes the copy.
// Without a sandbox (Linux for now) the profile stays empty instead, like the
// screenshots', so nothing in it can reach your projects.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { emit } from "./events.mjs";
import { PREFERENCES, bootServer, findChrome, launchChrome } from "./looks.mjs";
import { ROOT, log, sleep } from "./util.mjs";

const SHIM = path.join(ROOT, "lib", "files", "preview-shim.cjs");

// What a profile copy takes from the app's userdata folder. Never secrets/
// (keys the server makes anew), server-owner.sqlite (who's signed in), logs or
// the browser cache.
const PROFILE_FILES = ["settings.json", "keybindings.json", "client-settings.json", "environment-id", "usage-model-rates.json"];
const PROFILE_DIRS = ["themes", "attachments"];
const DATABASE = "statev2.sqlite";

/** Copies the profile in `userdata` to `to`; the database as a consistent snapshot, while the app runs. */
function copyProfile(userdata, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of PROFILE_FILES) {
    const from = path.join(userdata, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(to, name), fs.constants.COPYFILE_FICLONE);
  }
  for (const name of PROFILE_DIRS) {
    const from = path.join(userdata, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(to, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
  const database = path.join(userdata, DATABASE);
  if (!fs.existsSync(database)) return;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(path.join(to, DATABASE));
  } finally {
    db.close();
  }
}

/** The page target of Chrome's window, once it has one. */
async function windowPage(chrome) {
  for (let tries = 0; tries < 40; tries++, await sleep(250)) {
    const { targetInfos } = await chrome.send("Target.getTargets");
    const page = targetInfos.find((target) => target.type === "page");
    if (page) return page.targetId;
  }
  throw new Error("Chrome opened no window");
}

/**
 * Signs the window in with the pairing URL (its token works once, so it's
 * opened here rather than on Chrome's command line), applies the screenshots'
 * theme, and lands on the home screen.
 */
async function pairWindow(chrome, targetId, pairingUrl) {
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  const origin = new URL(pairingUrl).origin;
  await send("Runtime.enable");
  await send("Page.navigate", { url: pairingUrl });
  const paired = `location.origin === ${JSON.stringify(origin)} && !location.pathname.startsWith("/pair")`;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(250)) {
    if (await evaluate(paired).catch(() => false)) break;
  }
  await evaluate(PREFERENCES);
  await send("Page.navigate", { url: origin + "/" });
  await chrome.send("Target.detachFromTarget", { sessionId });
}

/** Resolves once the window is closed (Chrome may stay running without one) or `signal` aborts. */
async function untilClosed(chrome, signal) {
  let quit = false;
  chrome.exited.then(() => (quit = true));
  while (!quit && !signal?.aborted) {
    await sleep(1000);
    const pages = await chrome
      .send("Target.getTargets")
      .then(({ targetInfos }) => targetInfos.filter((target) => target.type === "page").length)
      .catch(() => 0);
    if (pages === 0) return;
  }
}

/**
 * Previews `app` ({ exec, entry, electron }, from platform.serverOf) until its
 * window closes. `userdata`: the app's profile, copied when `sandbox` (from
 * platform.sandbox) gives one; lib/files/preview-shim.cjs adapts the server to it. Logs the hosts the server tried to reach (and
 * was refused) when it closes.
 */
export async function preview({ app, version, userdata, sandbox, signal }) {
  const chromeBinary = findChrome();
  if (!chromeBinary) throw new Error("the preview opens in Chrome or Chromium, and neither is installed");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-preview-")));
  let server = null;
  let chrome = null;
  try {
    const jail = sandbox?.(scratch) ?? null;
    const wrap = jail?.wrap ?? null;
    const baseDir = path.join(scratch, "t3");
    if (wrap) {
      log(`preview: copying your profile (projects, threads and settings; not your secrets)`);
      copyProfile(userdata, path.join(baseDir, "userdata"));
    } else {
      log("preview: no OS sandbox here, so the preview gets an empty profile instead of a copy of yours");
    }
    fs.mkdirSync(path.join(scratch, "tmp"), { recursive: true });
    log(`preview: starting ${version}${wrap ? " in the sandbox (no network, no writes outside its copy)" : ""}`);
    server = await bootServer(app, scratch, {
      baseDir,
      wrap,
      preload: jail ? [SHIM] : [],
      env: {
        ...(jail ? { T3BLACKOUT_PREVIEW_EXEC: JSON.stringify(jail.exec) } : {}),
        TMPDIR: path.join(scratch, "tmp"),
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        // Inside the sandbox the agent CLIs can be found, so their cards show as
        // installed; with no network and no credentials (HOME is the scratch
        // folder) they can't do anything.
        ...(wrap ? { PATH: process.env.PATH ?? "/usr/bin:/bin" } : {}),
      },
    });
    chrome = await launchChrome(chromeBinary, path.join(scratch, "chrome"), {
      window: ["--app=about:blank", "--window-size=1440,960"],
    });
    await pairWindow(chrome, await windowPage(chrome), server.pairingUrl);
    log(`preview: ${version} is open; close its window to stop it`);
    // The app's Preview button waits for this (blackoutDriftReport.ts).
    emit({ type: "preview-open", version });
    await untilClosed(chrome, signal);
  } finally {
    await chrome?.close();
    await server?.stop();
    const attempts = server && fs.existsSync(server.tripLog)
      ? [...new Set(fs.readFileSync(server.tripLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).host))]
      : [];
    fs.rmSync(scratch, { recursive: true, force: true });
    log(`preview: closed${attempts.length ? `; the server tried to reach ${attempts.join(", ")} and was refused` : ""}`);
  }
}
