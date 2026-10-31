// node --test test/: install.sh and scripts/add-agent-account.sh, sourced for
// their functions (neither runs its main when sourced), with stubs in place of
// sudo, the build account and the network. Nothing here needs root or touches
// the system: sshd only checks configs in a scratch folder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const INSTALL = path.join(ROOT, "install.sh");
const ADD_ACCOUNT = path.join(ROOT, "scripts", "add-agent-account.sh");
const isMac = process.platform === "darwin";
const SSHD = "/usr/sbin/sshd";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-host-scripts-")));

/** Runs `script` in bash after sourcing `file`, in `cwd`. */
const bash = (file, script, { cwd = tmp(), env = {} } = {}) =>
  spawnSync("bash", ["-c", `source ${JSON.stringify(file)}\n${script}`], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

test("the scripts parse, and shellcheck passes where it's installed", () => {
  for (const file of [INSTALL, ADD_ACCOUNT, path.join(ROOT, "scripts", "set-claude-token.sh")]) {
    const parsed = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
  if (spawnSync("shellcheck", ["--version"]).status !== 0) return;
  const linted = spawnSync("shellcheck", ["-S", "warning", INSTALL, ADD_ACCOUNT, path.join(ROOT, "scripts", "set-claude-token.sh")], { encoding: "utf8" });
  assert.equal(linted.status, 0, linted.stdout);
});

// ------------------------------------------------------------------ install.sh

/** Stubs for setup_builder: sudo and account creation do nothing; the build account is this one. */
const BUILDER_STUBS = `
uname() { if [[ "\${1:-}" == -m ]]; then command uname -m; else echo Darwin; fi; }
sudo() { :; }
id() { echo staff; }
builder_user_mac() { :; }
private_home() { [[ "$(ls -ld "$HOME" | cut -c5-10)" == "------" ]]; }
as_builder() {
  case "$1" in
    node) [[ -z "\${FAKE_OLD_NODE:-}" ]] ;;
    cargo) return 0 ;;
    test) ! private_home ;;
    */pnpm) echo "$PNPM_VERSION" ;;
    *) "$@" ;;
  esac
}
BUILDER_HOME="$PWD/builder"
mkdir -p "$BUILDER_HOME" upstream build
`;

test("setup_builder stops at the first failing step, before the marker and the cleanup", () => {
  const cwd = tmp();
  const result = bash(INSTALL, `${BUILDER_STUBS}\nas_builder() { case "$1" in */pnpm) echo 0.0.1 ;; *) return 0 ;; esac; }\ninstall_pnpm() { echo "pnpm failed" >&2; return 3; }\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd } });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /REACHED/);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".t3blackout-builder")), false);
  assert.equal(fs.existsSync(path.join(cwd, "build")), true);
});

test("the build account's Node must meet the security floor", () => {
  const cwd = tmp();
  const result = bash(INSTALL, `${BUILDER_STUBS}\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd, FAKE_OLD_NODE: "1" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /isn't Node 24\+ with the Oct 2026 security fixes/);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".t3blackout-builder")), false);
});

test("a home the build account can read is made private before builds use the account", () => {
  const cwd = tmp();
  fs.chmodSync(cwd, 0o750);
  const result = bash(INSTALL, `${BUILDER_STUBS}\nsetup_builder\necho REACHED`, { cwd, env: { HOME: cwd } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Making .* private/);
  assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(cwd, "builder", ".t3blackout-builder")), true);
  assert.equal(fs.existsSync(path.join(cwd, "build")), false, "old build data cleared only at the end");
});

test("node_ok checks the given Node against the security floor", () => {
  const dir = tmp();
  const fake = (version) => {
    const file = path.join(dir, `node-${version}`);
    // A Node that reports `version` but runs the real check (called as: node -e CHECK ARGS...).
    const shim = [
      `const real = globalThis.process; const versions = { ...real.versions, node: "${version}" };`,
      'const process = new Proxy(real, { get: (t, k) => (k === "versions" ? versions : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });',
      "eval(real.env.T3B_CHECK);",
    ].join(" ");
    fs.writeFileSync(file, `#!/bin/sh\nshift\nT3B_CHECK="$1"; export T3B_CHECK; shift\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(shim)} "$@"\n`, { mode: 0o755 });
    return file;
  };
  const ok = (version) => bash(INSTALL, `node_ok ${JSON.stringify(fake(version))} -- && echo yes || echo no`).stdout.trim();
  assert.equal(ok("24.22.1"), "yes");
  assert.equal(ok("24.22.0"), "no");
  assert.equal(ok("22.23.4"), "no", "under NODE_MAJOR");
  assert.equal(ok("26.12.1"), "yes");
  assert.equal(ok("26.11.9"), "no");
});

/** npm-style tarballs (package/...) for a fake pnpm, and a curl that serves them. */
function pnpmFixtures() {
  const dir = tmp();
  const make = (name, files) => {
    const src = path.join(dir, `${name}-src`, "package");
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
      fs.writeFileSync(path.join(src, file), content, { mode: 0o755 });
    }
    const tgz = path.join(dir, `${name}.tgz`);
    assert.equal(spawnSync("tar", ["-czf", tgz, "-C", path.dirname(src), "package"]).status, 0);
    return { tgz, sha512: createHash("sha512").update(fs.readFileSync(tgz)).digest("hex") };
  };
  const wrapper = make("wrapper", { "package.json": "{}", pnpm: "placeholder", pn: "placeholder", pnpx: "placeholder", pnx: "placeholder", "dist/node-gyp-bin/node-gyp": "gyp" });
  const exe = make("exe", { pnpm: '#!/bin/sh\necho 12.14.0\n' });
  const stubs = `
curl() { local out="" url=""; while (($#)); do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
  case "$url" in */exe.*) cp ${JSON.stringify(exe.tgz)} "$out" ;; *) cp ${JSON.stringify(wrapper.tgz)} "$out" ;; esac; }
pnpm_sha512() { case "$1" in wrapper) echo ${wrapper.sha512} ;; *) echo ${exe.sha512} ;; esac; }
`;
  return { stubs };
}

test("pnpm installs from its pinned packages, laid out as npm -g would, with no scripts", () => {
  const { stubs } = pnpmFixtures();
  const prefix = path.join(tmp(), "prefix");
  const result = bash(INSTALL, `${stubs}\ninstall_pnpm ${JSON.stringify(prefix)}\n${JSON.stringify(prefix)}/bin/pnpx --version`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^12\.14\.0$/m);
  assert.equal(fs.readlinkSync(path.join(prefix, "bin", "pnpm")), "../lib/node_modules/pnpm/pnpm");
  assert.equal(fs.existsSync(path.join(prefix, "lib", "node_modules", "pnpm", "dist", "node-gyp-bin", "node-gyp")), true);
});

test("a download that doesn't match its pinned digest stops the install", () => {
  const { stubs } = pnpmFixtures();
  const prefix = path.join(tmp(), "prefix");
  const result = bash(INSTALL, `${stubs}\npnpm_sha512() { echo 0000; }\ninstall_pnpm ${JSON.stringify(prefix)}\necho REACHED`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /doesn't match its pinned SHA-512 digest/);
  assert.doesNotMatch(result.stdout, /REACHED/);
  assert.equal(fs.existsSync(path.join(prefix, "bin", "pnpm")), false);
});

test("host and both roles are refused on Linux before anything runs", () => {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
  for (const role of ["host", "both"]) {
    const result = spawnSync("bash", [INSTALL, "--role", role], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--role ${role} is macOS only`));
  }
});

// -------------------------------------------------------- add-agent-account.sh

/** A scratch sshd layout like macOS's: the main config includes sshd_config.d/* first. */
function sshdLayout(dropin) {
  const dir = tmp();
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "hostkey")]);
  fs.mkdirSync(path.join(dir, "d"));
  fs.writeFileSync(path.join(dir, "d", "010-t3blackout.conf"), dropin);
  // macOS's own drop-in: UsePAM is not allowed inside a Match block, so it parsing
  // proves ours ended its Match.
  fs.writeFileSync(path.join(dir, "d", "100-macos.conf"), "UsePAM yes\nAcceptEnv LANG LC_*\n");
  fs.writeFileSync(
    path.join(dir, "sshd_config"),
    `Include ${dir}/d/*\nAuthorizedKeysFile .ssh/authorized_keys\nSubsystem sftp /usr/libexec/sftp-server\nHostKey ${dir}/hostkey\nPidFile ${dir}/pid\n`,
  );
  return path.join(dir, "sshd_config");
}

const effective = (config, user) => {
  const result = spawnSync(SSHD, ["-T", "-f", config, "-C", `user=${user},host=desktop,addr=127.0.0.1`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // Lowercased: Apple's sshd prints keywords as written (AuthorizedKeysFile), OpenSSH's lowercase.
  return Object.fromEntries(result.stdout.split("\n").filter(Boolean).map((line) => [line.split(" ")[0].toLowerCase(), line.slice(line.indexOf(" ") + 1)]));
};

test("agent accounts get root's keys file and loopback-only forwarding; everyone else keeps theirs", { skip: !(isMac && fs.existsSync(SSHD)) && "macOS sshd" }, () => {
  const me = os.userInfo().username;
  const myGroup = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
  const render = (group) => bash(ADD_ACCOUNT, `AGENT_GROUP=${group}\nrender_dropin`).stdout;
  const agent = sshdLayout(render(myGroup));
  assert.equal(spawnSync(SSHD, ["-t", "-f", agent]).status, 0);
  const asAgent = effective(agent, me);
  assert.equal(asAgent.authorizedkeysfile, "/etc/ssh/t3blackout/authorized_keys/%u");
  assert.equal(asAgent.allowtcpforwarding, "local");
  assert.equal(asAgent.permitopen, "127.0.0.1:* localhost:* [::1]:*");
  assert.equal(asAgent.authenticationmethods, "publickey");
  assert.equal(asAgent.passwordauthentication, "no");
  assert.equal(asAgent.kbdinteractiveauthentication, "no");
  assert.equal(asAgent.usepam, "yes");
  const other = effective(sshdLayout(render("t3b-no-such-group")), me);
  assert.equal(other.authorizedkeysfile, ".ssh/authorized_keys");
  assert.equal(other.passwordauthentication, "no");
  assert.equal(other.permitrootlogin, "no");
});

test("the standby sshd listens on loopback only, for agent accounts, keys only", { skip: !(isMac && fs.existsSync(SSHD)) && "macOS sshd" }, () => {
  const dir = tmp();
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "hostkey")]);
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, bash(ADD_ACCOUNT, `LOOPBACK_HOSTKEY=${dir}/hostkey\nrender_loopback_config`).stdout);
  const check = spawnSync(SSHD, ["-t", "-f", config], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const settings = spawnSync(SSHD, ["-T", "-f", config, "-C", "user=nobody,host=x,addr=127.0.0.1"], { encoding: "utf8" }).stdout.toLowerCase();
  assert.deepEqual(settings.match(/^listenaddress .*$/gm).sort(), ["listenaddress 127.0.0.1:2222", "listenaddress [::1]:2222"]);
  assert.match(settings, /^allowgroups t3blackout-agents$/m);
  assert.match(settings, /^authenticationmethods publickey$/m);
  assert.match(settings, /^passwordauthentication no$/m);
  const plist = path.join(dir, "sshd.plist");
  fs.writeFileSync(plist, bash(ADD_ACCOUNT, "render_loopback_plist").stdout);
  assert.equal(spawnSync("plutil", ["-lint", plist]).status, 0);
  const job = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
  assert.deepEqual(job.ProgramArguments, ["/usr/sbin/sshd", "-D", "-f", "/etc/ssh/t3blackout/sshd_config"]);
});

test("a missing host key is reported as such, not as a config error", { skip: !(isMac && fs.existsSync(SSHD)) && "macOS sshd" }, () => {
  const dir = tmp();
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, bash(ADD_ACCOUNT, `LOOPBACK_HOSTKEY=${dir}/missing\nrender_loopback_config`).stdout);
  const check = spawnSync(SSHD, ["-t", "-f", config], { encoding: "utf8" });
  assert.notEqual(check.status, 0);
  // install_dropin keys its message off this text.
  assert.match(check.stderr, /no hostkeys available/);
  assert.match(fs.readFileSync(ADD_ACCOUNT, "utf8"), /grep -q 'no hostkeys available'/);
});
