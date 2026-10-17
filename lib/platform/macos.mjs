// macOS: unsigned .app build, signed locally with the shared identity, installed
// to ~/Applications, scheduled with launchd.

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LAUNCHER,
  STATE,
  WORK,
  capture,
  findPaths,
  log,
  renderTemplate,
  run,
  stableNodePath,
  trackStageDirs,
} from "../util.mjs";

const APPS = path.join(os.homedir(), "Applications");
const APP = path.join(APPS, "T3 Blackout.app");
const APP_STAGED = path.join(APPS, ".T3 Blackout.new.app");
const APP_PREVIOUS = path.join(APPS, ".T3 Blackout.previous.app");
const UPDATE_LABEL = "dev.t3blackout.update";
// Earlier versions relaunched Dock launches into a sandbox through this agent.
const LEGACY_LAUNCH_LABEL = "dev.t3blackout.launch";

const SIGNING_KEYCHAIN = path.join(STATE, "signing.keychain-db");
const SIGNING_KEYCHAIN_PASS = path.join(STATE, "signing.keychain-pass");
const SIGNING_CN = "T3 Blackout Local Signing";
const OP_ITEM = "T3 Blackout code signing";
// The p12 only ever travels inside 1Password, which is what protects it; this
// passphrase exists because `security import` rejects passphrase-less p12s.
const P12_PASSPHRASE = "t3blackout";

// ---------------------------------------------------------------- signing --
// Keychain "Always Allow" grants are tied to the app's signature. Ad-hoc
// signatures change every build, so each update would prompt again. A stable
// self-signed identity (shared across your Macs via 1Password) keeps them.

function signingIdentity() {
  if (!fs.existsSync(SIGNING_KEYCHAIN) || !fs.existsSync(SIGNING_KEYCHAIN_PASS)) return null;
  const pass = fs.readFileSync(SIGNING_KEYCHAIN_PASS, "utf8").trim();
  childProcess.spawnSync("security", ["unlock-keychain", "-p", pass, SIGNING_KEYCHAIN]);
  const out = childProcess.spawnSync("security", ["find-identity", "-v", "-p", "codesigning", SIGNING_KEYCHAIN], {
    encoding: "utf8",
  }).stdout;
  return /\b([0-9A-F]{40})\b "T3 Blackout Local Signing"/.exec(out ?? "")?.[1] ?? null;
}

function sign(appPath) {
  const identity = signingIdentity();
  if (!identity) {
    log("no signing identity (run `t3blackout signing init` or `signing import`); signing ad-hoc, Keychain will re-prompt after this update");
    childProcess.spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
    return;
  }
  // codesign only resolves identities from keychains on the user search list,
  // even with --keychain. Add ours for this one call, then restore the list.
  const searchList = capture("security", ["list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  run("security", ["list-keychains", "-d", "user", "-s", ...searchList, SIGNING_KEYCHAIN]);
  try {
    run("codesign", ["--force", "--deep", "--keychain", SIGNING_KEYCHAIN, "--sign", identity, appPath]);
  } finally {
    run("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
  }
  log(`signed with ${SIGNING_CN} (${identity.slice(0, 10)})`);
}

function requireOp() {
  if (childProcess.spawnSync("op", ["--version"]).status !== 0) {
    throw new Error(
      "1Password CLI not found. Install it (brew install --cask 1password-cli), then in 1Password → Settings → Developer enable \"Integrate with 1Password CLI\".",
    );
  }
}

/** Imports a p12 into the dedicated keychain and trusts its cert for code signing. */
function installIdentity(p12) {
  if (!fs.existsSync(SIGNING_KEYCHAIN)) {
    const pass = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(SIGNING_KEYCHAIN_PASS, pass, { mode: 0o600 });
    run("security", ["create-keychain", "-p", pass, SIGNING_KEYCHAIN]);
    // No auto-lock timeout; `sign` unlocks it with the stored password anyway.
    run("security", ["set-keychain-settings", SIGNING_KEYCHAIN]);
  }
  const pass = fs.readFileSync(SIGNING_KEYCHAIN_PASS, "utf8").trim();
  run("security", ["unlock-keychain", "-p", pass, SIGNING_KEYCHAIN]);
  run("security", ["import", p12, "-k", SIGNING_KEYCHAIN, "-P", P12_PASSPHRASE, "-T", "/usr/bin/codesign"], {
    stdio: "ignore",
  });
  childProcess.spawnSync(
    "security",
    ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pass, SIGNING_KEYCHAIN],
    { stdio: "ignore" },
  );
  const certPem = path.join(path.dirname(p12), "cert.pem");
  run("/usr/bin/openssl", ["pkcs12", "-in", p12, "-clcerts", "-nokeys", "-passin", `pass:${P12_PASSPHRASE}`, "-out", certPem], {
    stdio: "ignore",
  });
  log("trusting the certificate for code signing (macOS will ask for your password once)");
  run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", SIGNING_KEYCHAIN, certPem]);
  const identity = signingIdentity();
  if (!identity) throw new Error("certificate imported but codesign still sees no valid identity");
  log(`signing identity ready: ${SIGNING_CN} (${identity.slice(0, 10)})`);
}

async function cmdSigning(opts, sub) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-signing-"));
  try {
    if (sub === "status") {
      const identity = signingIdentity();
      console.log(identity ? `signing: ${SIGNING_CN} (${identity})` : "signing: not set up (ad-hoc)");
      return;
    }
    requireOp();
    const p12 = path.join(tmp, "t3blackout-signing.p12");
    const vaultArgs = opts.vault ? ["--vault", opts.vault] : [];
    if (sub === "init") {
      if (childProcess.spawnSync("op", ["item", "get", OP_ITEM, ...vaultArgs], { stdio: "ignore" }).status === 0) {
        throw new Error(`"${OP_ITEM}" already exists in 1Password; use \`t3blackout signing import\``);
      }
      const cnf = path.join(tmp, "cert.cnf");
      fs.writeFileSync(
        cnf,
        [
          "[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no",
          "[dn]", `CN = ${SIGNING_CN}`,
          "[ext]", "basicConstraints = critical,CA:false", "keyUsage = critical,digitalSignature",
          "extendedKeyUsage = critical,codeSigning",
        ].join("\n"),
      );
      const key = path.join(tmp, "key.pem");
      const cert = path.join(tmp, "cert-init.pem");
      run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", key, "-out", cert, "-days", "3650", "-config", cnf], { stdio: "ignore" });
      run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${P12_PASSPHRASE}`], { stdio: "ignore" });
      log(`storing "${OP_ITEM}" in 1Password (approve in the 1Password app)`);
      run("op", ["document", "create", p12, "--title", OP_ITEM, "--file-name", "t3blackout-signing.p12", ...vaultArgs]);
    } else if (sub === "import") {
      log(`fetching "${OP_ITEM}" from 1Password (approve in the 1Password app)`);
      run("op", ["document", "get", OP_ITEM, "--out-file", p12, ...vaultArgs]);
    } else {
      throw new Error("usage: t3blackout signing init|import|status [--vault <name>]");
    }
    installIdentity(p12);
    console.log("Builds from the next `t3blackout update` on are signed with it.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- launchd --

const agentPlist = (label) => path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

function removeAgent(label) {
  childProcess.spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, agentPlist(label)]);
  fs.rmSync(agentPlist(label), { force: true });
}

// --------------------------------------------------------------- platform --

export default {
  name: "macOS",
  installedPath: APP,

  buildArgs: () => ["--platform", "mac", "--target", "dir", "--arch", process.arch === "arm64" ? "arm64" : "x64", "--keep-stage"],

  beginBuild() {
    const stages = trackStageDirs("mac");
    return {
      findArtifact() {
        const [app] = findPaths([path.join(WORK, "release"), ...stages.ours()], (entry) => entry.isDirectory() && entry.name === "T3 Blackout.app");
        if (!app) throw new Error("build finished but no 'T3 Blackout.app' was found");
        return app;
      },
      cleanup: stages.cleanup,
    };
  },

  stage(appPath) {
    fs.mkdirSync(APPS, { recursive: true });
    fs.rmSync(APP_STAGED, { recursive: true, force: true });
    run("ditto", [appPath, APP_STAGED]);
    // Our own artifact; make sure Gatekeeper doesn't treat it as downloaded.
    childProcess.spawnSync("xattr", ["-dr", "com.apple.quarantine", APP_STAGED]);
    sign(APP_STAGED);
    return APP_STAGED;
  },

  scanRoots: (staged) => [path.join(staged, "Contents", "Resources")],

  activate(staged) {
    fs.rmSync(APP_PREVIOUS, { recursive: true, force: true });
    if (fs.existsSync(APP)) fs.renameSync(APP, APP_PREVIOUS);
    fs.renameSync(staged, APP);
    removeAgent(LEGACY_LAUNCH_LABEL);
  },

  rollback() {
    if (!fs.existsSync(APP_PREVIOUS)) throw new Error("no previous build to roll back to");
    const tmp = path.join(APPS, ".T3 Blackout.swap.app");
    fs.renameSync(APP, tmp);
    fs.renameSync(APP_PREVIOUS, APP);
    fs.renameSync(tmp, APP_PREVIOUS);
  },

  launch() {
    if (!fs.existsSync(APP)) throw new Error(`${APP} is not installed; run \`t3blackout update\` first`);
    // `open` hands the app the caller's environment; drop what a shell inside the
    // official T3 Code carries (ELECTRON_RUN_AS_NODE would start it as plain Node).
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_|T3CODE_)/.test(key)));
    run("open", ["-a", APP], { env });
  },

  schedule(hour) {
    const plist = agentPlist(UPDATE_LABEL);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      renderTemplate(`launchd/${UPDATE_LABEL}.plist`, {
        __NODE__: stableNodePath(),
        __LAUNCHER__: LAUNCHER,
        __PATH__: process.env.PATH ?? "/usr/bin:/bin",
        __STATE__: STATE,
        __HOUR__: String(hour),
      }),
    );
    childProcess.spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist]);
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
  },

  unschedule() {
    removeAgent(UPDATE_LABEL);
    removeAgent(LEGACY_LAUNCH_LABEL);
  },

  isScheduled: () => childProcess.spawnSync("launchctl", ["list", UPDATE_LABEL], { stdio: "ignore" }).status === 0,

  notify(title, message) {
    childProcess.spawnSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  },

  statusLines() {
    const identity = signingIdentity();
    return [`signing:   ${identity ? `${SIGNING_CN} (${identity.slice(0, 10)})` : "ad-hoc (run `t3blackout signing init`)"}`];
  },

  commands: { signing: cmdSigning },
};
