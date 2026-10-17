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
// A verified build waiting for the running app to restart.
const APP_PENDING = path.join(APPS, ".T3 Blackout.pending.app");
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
// macOS Keychain grants check the app twice: its code requirement (stable for
// any certificate-signed build) and its "partition", which is the team ID for
// Apple-issued certificates but the per-build cdhash for anything else. So only
// an Apple-issued identity (a free Apple Development certificate is enough)
// stops the Safe Storage prompts after updates. The self-signed identity
// remains as a fallback. The identity lives in a dedicated keychain so the
// daily job can sign without prompts, and travels between Macs via 1Password.

const APPLE_IDENTITY = /^(Apple Development|Developer ID Application): /;

/** Code-signing identities in a keychain, as [{ hash, name }]; `validOnly` needs a full chain. */
function listIdentities(keychain, { validOnly = true } = {}) {
  const args = ["find-identity", ...(validOnly ? ["-v"] : []), "-p", "codesigning", keychain];
  const out = childProcess.spawnSync("security", args, { encoding: "utf8" }).stdout ?? "";
  const section = validOnly ? out : out.split("Valid identities only")[0];
  return [...section.matchAll(/\b([0-9A-F]{40})\b "([^"]+)"/g)].map(([, hash, name]) => ({ hash, name }));
}

const pemsIn = (keychain) =>
  childProcess.spawnSync("security", ["find-certificate", "-a", "-Z", "-p", keychain], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout ?? "";

/**
 * Whether an identity's certificate is unexpired and chains to a macOS root
 * through the intermediate kept in the signing keychain. `find-identity -v`
 * can't tell (it builds chains from the user's search list, which excludes
 * that keychain), and `security verify-cert` may check revocation online.
 */
function chainsToApple({ hash }) {
  const signing = pemsIn(SIGNING_KEYCHAIN);
  const leaf = new RegExp(`SHA-1 hash: ${hash}\\n(-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----)`).exec(signing)?.[1];
  if (!leaf) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-chain-"));
  try {
    const only = (text) => (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).join("\n") + "\n";
    fs.writeFileSync(path.join(tmp, "leaf.pem"), leaf + "\n");
    fs.writeFileSync(path.join(tmp, "intermediates.pem"), only(signing));
    fs.writeFileSync(path.join(tmp, "roots.pem"), only(pemsIn("/System/Library/Keychains/SystemRootCertificates.keychain")));
    // -ignore_critical: LibreSSL doesn't know Apple's critical developer-certificate extension.
    const args = ["verify", "-ignore_critical", "-CAfile", path.join(tmp, "roots.pem"), "-untrusted", path.join(tmp, "intermediates.pem"), path.join(tmp, "leaf.pem")];
    return childProcess.spawnSync("/usr/bin/openssl", args, { stdio: "ignore" }).status === 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function signingIdentity() {
  if (!fs.existsSync(SIGNING_KEYCHAIN) || !fs.existsSync(SIGNING_KEYCHAIN_PASS)) return null;
  const pass = fs.readFileSync(SIGNING_KEYCHAIN_PASS, "utf8").trim();
  childProcess.spawnSync("security", ["unlock-keychain", "-p", pass, SIGNING_KEYCHAIN]);
  const apple = listIdentities(SIGNING_KEYCHAIN, { validOnly: false }).find((id) => APPLE_IDENTITY.test(id.name) && chainsToApple(id));
  return apple ?? listIdentities(SIGNING_KEYCHAIN).find((id) => id.name === SIGNING_CN) ?? null;
}

function sign(appPath) {
  const identity = signingIdentity();
  if (!identity) {
    log("no signing identity (run `t3blackout signing adopt` or `signing import`); signing ad-hoc, Keychain will re-prompt after this update");
    childProcess.spawnSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "ignore" });
    return;
  }
  // codesign only resolves identities (and Apple's intermediate) from keychains
  // on the user search list, even with --keychain. Add ours for this one call.
  const searchList = capture("security", ["list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  run("security", ["list-keychains", "-d", "user", "-s", ...searchList, SIGNING_KEYCHAIN]);
  try {
    // --timestamp=none: never contact Apple's timestamp server.
    run("codesign", ["--force", "--deep", "--timestamp=none", "--keychain", SIGNING_KEYCHAIN, "--sign", identity.hash, appPath]);
  } finally {
    run("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
  }
  log(`signed with ${identity.name} (${identity.hash.slice(0, 10)})`);
}

function requireOp() {
  if (childProcess.spawnSync("op", ["--version"]).status !== 0) {
    throw new Error(
      "1Password CLI not found. Install it (brew install --cask 1password-cli), then in 1Password → Settings → Developer enable \"Integrate with 1Password CLI\".",
    );
  }
}

const openssl = (args, opts = {}) => run("/usr/bin/openssl", args, { stdio: "ignore", ...opts });
const isSelfSigned = (certPem) => subjectOf(certPem) === issuerOf(certPem);

/** Imports a p12 into the dedicated keychain; trusts it for code signing if self-signed. */
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
  openssl(["pkcs12", "-in", p12, "-clcerts", "-nokeys", "-passin", `pass:${P12_PASSPHRASE}`, "-out", certPem]);
  if (isSelfSigned(certPem)) {
    log("trusting the self-signed certificate for code signing (macOS will ask for your password once)");
    run("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", SIGNING_KEYCHAIN, certPem]);
  }
  const identity = signingIdentity();
  if (!identity) throw new Error("certificate imported but codesign still sees no valid identity");
  log(`signing identity ready: ${identity.name} (${identity.hash.slice(0, 10)})`);
}

/** Splits `openssl pkcs12 -nodes` output into PEM blocks with their localKeyID. */
function pemBlocks(text) {
  return [...text.matchAll(/(?:Bag Attributes[\s\S]*?localKeyID: ([0-9A-F ]+)[\s\S]*?)?(-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \3-----)/g)].map(
    ([, keyId, pem, type]) => ({ keyId: keyId?.trim() ?? null, pem: pem + "\n", type }),
  );
}

const subjectOf = (pem) => capture("/usr/bin/openssl", ["x509", "-in", pem, "-noout", "-subject"]).replace(/^subject=\s*/, "");
const issuerOf = (pem) => capture("/usr/bin/openssl", ["x509", "-in", pem, "-noout", "-issuer"]).replace(/^issuer=\s*/, "");

/** The certificate that issued `certPem`, from the macOS keychains, or null. */
function issuerFromKeychains(certPem, tmp) {
  const issuer = issuerOf(certPem);
  const keychains = [
    path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    "/Library/Keychains/System.keychain",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
  ];
  for (const keychain of keychains) {
    const all = childProcess.spawnSync("security", ["find-certificate", "-a", "-p", keychain], { encoding: "utf8" }).stdout ?? "";
    for (const [pem] of all.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)) {
      const candidate = path.join(tmp, "candidate.pem");
      fs.writeFileSync(candidate, pem + "\n");
      if (subjectOf(candidate) === issuer) return pem + "\n";
    }
  }
  return null;
}

/**
 * Apple's intermediate that issued `certPem`. Xcode doesn't always install the
 * current one (WWDR G3); then it's fetched from the URL in the certificate and
 * kept only if Apple's root, from the macOS trust store, verifies it.
 */
function findIssuer(certPem, tmp) {
  const local = issuerFromKeychains(certPem, tmp);
  if (local) return local;
  const text = capture("/usr/bin/openssl", ["x509", "-in", certPem, "-noout", "-text"]);
  const url = /CA Issuers - URI:(\S+)/.exec(text)?.[1];
  if (!url) throw new Error(`couldn't find the issuing certificate (${issuerOf(certPem)}) in your keychains`);
  log(`fetching Apple's intermediate certificate from ${url}`);
  const der = path.join(tmp, "issuer.der");
  const intermediate = path.join(tmp, "issuer.pem");
  run("curl", ["-fsSL", "--max-time", "30", "-o", der, url]);
  openssl(["x509", "-inform", "DER", "-in", der, "-out", intermediate]);
  if (subjectOf(intermediate) !== issuerOf(certPem)) throw new Error(`${url} isn't the certificate that issued yours`);
  const root = issuerFromKeychains(intermediate, tmp);
  if (!root) throw new Error(`no trusted root for ${subjectOf(intermediate)}`);
  const rootPem = path.join(tmp, "root.pem");
  fs.writeFileSync(rootPem, root);
  openssl(["verify", "-CAfile", rootPem, intermediate]);
  return fs.readFileSync(intermediate, "utf8");
}

/**
 * Takes the Apple Development (or Developer ID) identity Xcode created in the
 * login keychain, bundles it with Apple's intermediate so Macs without Xcode
 * can sign with it, stores it in 1Password and installs it here.
 */
function adoptAppleIdentity(tmp, vaultArgs) {
  const login = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
  // Not validOnly: if Xcode didn't install Apple's current intermediate, the
  // identity isn't "valid" here yet; findIssuer supplies it below.
  const apple = listIdentities(login, { validOnly: false }).filter((id) => APPLE_IDENTITY.test(id.name));
  if (!apple.length) {
    throw new Error(
      "no Apple Development certificate in your login keychain. In Xcode: Settings → Accounts → add your Apple ID → Manage Certificates → + → Apple Development",
    );
  }
  const { name } = apple.find((id) => id.name.startsWith("Developer ID")) ?? apple[0];
  log(`exporting "${name}" from your login keychain (macOS asks to allow the export)`);
  const exported = path.join(tmp, "exported.p12");
  run("security", ["export", "-k", login, "-t", "identities", "-f", "pkcs12", "-P", P12_PASSPHRASE, "-o", exported]);
  const blocks = pemBlocks(
    capture("/usr/bin/openssl", ["pkcs12", "-in", exported, "-nodes", "-passin", `pass:${P12_PASSPHRASE}`], { maxBuffer: 16 << 20 }),
  );
  const cert = blocks.find((block) => {
    if (block.type !== "CERTIFICATE") return false;
    const file = path.join(tmp, "probe.pem");
    fs.writeFileSync(file, block.pem);
    return capture("/usr/bin/openssl", ["x509", "-in", file, "-noout", "-subject"]).includes(`CN=${name}`);
  });
  const key = blocks.find((block) => block.type.endsWith("PRIVATE KEY") && block.keyId && block.keyId === cert?.keyId);
  if (!cert || !key) throw new Error(`couldn't find the certificate and key for "${name}" in the export`);
  const certPem = path.join(tmp, "leaf.pem");
  const keyPem = path.join(tmp, "key.pem");
  const chainPem = path.join(tmp, "chain.pem");
  fs.writeFileSync(certPem, cert.pem);
  fs.writeFileSync(keyPem, key.pem, { mode: 0o600 });
  fs.writeFileSync(chainPem, findIssuer(certPem, tmp));
  const p12 = path.join(tmp, "t3blackout-signing.p12");
  openssl(["pkcs12", "-export", "-inkey", keyPem, "-in", certPem, "-certfile", chainPem, "-name", name, "-out", p12, "-passout", `pass:${P12_PASSPHRASE}`]);
  const exists = childProcess.spawnSync("op", ["item", "get", OP_ITEM, ...vaultArgs], { stdio: "ignore" }).status === 0;
  log(`${exists ? "replacing" : "storing"} "${OP_ITEM}" in 1Password (approve in the 1Password app)`);
  if (exists) run("op", ["document", "edit", OP_ITEM, p12, "--file-name", "t3blackout-signing.p12", ...vaultArgs]);
  else run("op", ["document", "create", p12, "--title", OP_ITEM, "--file-name", "t3blackout-signing.p12", ...vaultArgs]);
  return p12;
}

function createSelfSigned(tmp, vaultArgs) {
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
  const p12 = path.join(tmp, "t3blackout-signing.p12");
  openssl(["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", key, "-out", cert, "-days", "3650", "-config", cnf]);
  openssl(["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${P12_PASSPHRASE}`]);
  log(`storing "${OP_ITEM}" in 1Password (approve in the 1Password app)`);
  run("op", ["document", "create", p12, "--title", OP_ITEM, "--file-name", "t3blackout-signing.p12", ...vaultArgs]);
  return p12;
}

async function cmdSigning(opts, sub) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3blackout-signing-"));
  try {
    if (sub === "status") {
      const identity = signingIdentity();
      console.log(identity ? `signing: ${identity.name} (${identity.hash})` : "signing: not set up (ad-hoc)");
      return;
    }
    requireOp();
    const vaultArgs = opts.vault ? ["--vault", opts.vault] : [];
    let p12;
    if (sub === "adopt") {
      p12 = adoptAppleIdentity(tmp, vaultArgs);
    } else if (sub === "init") {
      p12 = createSelfSigned(tmp, vaultArgs);
    } else if (sub === "import") {
      p12 = path.join(tmp, "t3blackout-signing.p12");
      log(`fetching "${OP_ITEM}" from 1Password (approve in the 1Password app)`);
      run("op", ["document", "get", OP_ITEM, "--out-file", p12, ...vaultArgs]);
    } else {
      throw new Error("usage: t3blackout signing adopt|import|init|status [--vault <name>]");
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
  pendingPath: APP_PENDING,

  isRunning() {
    const processes = childProcess.spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" }).stdout ?? "";
    return processes.split("\n").some((line) => line.startsWith(`${APP}/Contents/MacOS/`));
  },

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
    if (!identity) return ["signing:   ad-hoc (run `t3blackout signing adopt` or `signing import`)"];
    const note = APPLE_IDENTITY.test(identity.name) ? "" : " (self-signed: Keychain prompts after each update)";
    return [`signing:   ${identity.name} (${identity.hash.slice(0, 10)})${note}`];
  },

  commands: { signing: cmdSigning },
};
