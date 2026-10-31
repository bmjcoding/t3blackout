// Shared by test/trust-*.test.mjs: throwaway upstream, origin and clone
// repositories with throwaway SSH keys, for self-update (lib/selfupdate.mjs), and a
// mocked npm. Nothing here touches this clone or ~/.ssh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";
import assert from "node:assert/strict";

// The tests' git must not pick up this machine's signing program, hooks or log settings.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { BOT_PRINCIPAL, selfUpdate } = await import("../lib/selfupdate.mjs");

export const DAY = 86_400_000;
export const scratch = [];
after(() => scratch.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
export const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
export const NIGHTLY = (build) => `v0.1.6-nightly.20261030.${build}`;

export function run(cwd, args, opts = {}) {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", ...opts });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A one-package pnpm lockfile per release: `deps` (name@version -> integrity), as importer dependencies. */
export function lockfileOf(deps) {
  const entries = Object.entries(deps);
  const name = (pkg) => pkg.slice(0, pkg.lastIndexOf("@"));
  const version = (pkg) => pkg.slice(pkg.lastIndexOf("@") + 1);
  const quote = (key) => (key.startsWith("@") ? `'${key}'` : key);
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...entries.flatMap(([pkg]) => [`      ${quote(name(pkg))}:`, `        specifier: ${version(pkg)}`, `        version: ${version(pkg)}`]),
    "packages:",
    ...entries.flatMap(([pkg, resolution]) => [`  ${quote(pkg)}:`, `    resolution: ${typeof resolution === "string" ? `{integrity: ${resolution}}` : JSON.stringify(resolution)}`]),
    "snapshots:",
    ...entries.map(([pkg]) => `  ${quote(pkg)}: {}`),
    "",
  ].join("\n");
}

export const OLD_DEPS = { "trust-su-dep@1.0.0": "sha512-b2xk" };

/** Upstream with three nightly tags (the middle one annotated), a branch that only looks like a tag, an owner and an evaluator key, origin, and a clone of it. `locks[n]`: release n's dependencies. */
export function fixture({ knownHosts = "", knownTools = "", locks = [OLD_DEPS, OLD_DEPS, OLD_DEPS] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-selfupdate-"));
  scratch.push(dir);
  const key = (name) => {
    const file = path.join(dir, name);
    assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file]).status, 0);
    return { file, pub: fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ") };
  };
  const owner = key("owner");
  const bot = key("bot");
  const stranger = key("stranger");

  const upstream = path.join(dir, "upstream");
  run(dir, ["init", "-q", "-b", "main", upstream]);
  const shas = [];
  // What each release pins in apps/server/src/device/deviceToolVersions.json.
  const tools = [
    { "trust-su-tool": "1.0.0" },
    { "trust-su-tool": "1.1.0", "trust-su-deps": "1.1.0", "trust-su-host": "1.1.0", "trust-su-net": "1.1.0", "trust-su-new": "2.0.0" },
    { "trust-su-tool": "1.1.0" },
  ];
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(upstream, "file"), `${n}\n`);
    fs.mkdirSync(path.join(upstream, "apps/server/src/device"), { recursive: true });
    fs.writeFileSync(path.join(upstream, "apps/server/src/device/deviceToolVersions.json"), JSON.stringify(tools[n - 1]));
    fs.writeFileSync(path.join(upstream, "pnpm-lock.yaml"), lockfileOf(locks[n - 1]));
    run(upstream, ["add", "-A"]);
    run(upstream, ["commit", "-q", "--no-gpg-sign", "-m", `upstream ${n}`]);
    shas.push(run(upstream, ["rev-parse", "HEAD"]));
  }
  run(upstream, ["tag", NIGHTLY(3904), shas[0]]);
  run(upstream, ["tag", "-a", "-m", "release", NIGHTLY(3917), shas[1]]);
  run(upstream, ["tag", NIGHTLY(3940), shas[2]]);
  run(upstream, ["update-ref", `refs/heads/refs/tags/${NIGHTLY(3999)}`, shas[2]]);

  const origin = path.join(dir, "origin");
  run(dir, ["init", "-q", "-b", "main", origin]);
  const commit = (signer, files, message) => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
      fs.writeFileSync(path.join(origin, name), content);
    }
    run(origin, ["add", "-A"]);
    const sign = signer ? ["-c", "gpg.format=ssh", "-c", "gpg.ssh.program=ssh-keygen", "-c", `user.signingkey=${signer.file}`, "commit", "-q", "-S"] : ["commit", "-q", "--no-gpg-sign"];
    run(origin, [...sign, "-m", message]);
    return run(origin, ["rev-parse", "HEAD"]);
  };
  commit(
    owner,
    {
      ".allowed_signers": `owner@example.com namespaces="git" ${owner.pub}\n${BOT_PRINCIPAL} namespaces="git" ${bot.pub}\n`,
      "pin.json": pin(NIGHTLY(3904), shas[0]),
      "lib/known-device-tools.txt": `# read by hand\n${knownTools}\n`,
      "lib/known-hosts.txt": `${knownHosts}\n`,
      "README.md": "fixture\n",
    },
    "root",
  );
  const clone = path.join(dir, "clone");
  run(dir, ["clone", "-q", origin, clone]);
  const logs = [];
  // The dependency-closure review runs npm; lib/device-tools.mjs's own tests cover it, so it passes here unless a test says otherwise.
  // Self-update fetches only from GitHub unless told where (`remote`): here, the local origin.
  const update = (opts = {}) => selfUpdate({ repo: clone, remote: origin, upstream, report: (line) => logs.push(line), reviewClosure: async (pin) => ({ ok: true, pin, reasons: [], notes: [] }), ...opts });
  return { dir, upstream, origin, clone, shas, owner, bot, stranger, commit, update, logs, head: () => run(clone, ["rev-parse", "HEAD"]) };
}

/** pin.json naming `ref` at `sha`; each tool in `locked` gets a frozen dependency lock (lib/device-tools.mjs). */
export function pin(ref, sha, deviceTools = ["trust-su-tool@1.0.0"], locked = deviceTools.filter((tool) => tool !== "trust-su-tool@1.0.0")) {
  const lockOf = (tool) => {
    const lock = `${JSON.stringify({ name: "t3blackout-device-tool", lockfileVersion: 3, packages: { [`node_modules/${tool.slice(0, tool.lastIndexOf("@"))}`]: {} } })}\n`;
    return { sha256: createHash("sha256").update(lock).digest("hex"), lock };
  };
  const locks = locked.length ? { deviceToolLocks: Object.fromEntries(locked.map((tool) => [tool, lockOf(tool)])) } : {};
  return `${JSON.stringify({ version: 1, channels: { nightly: { ref, sha, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } }, deviceTools, ...locks }, null, 2)}\n`;
}

/** Writes a commit object carrying `signature` as its gpgsig header straight onto origin's main. */
export function forgeSigned(f, armor) {
  const parent = run(f.origin, ["rev-parse", "HEAD"]);
  const tree = run(f.origin, ["rev-parse", "HEAD^{tree}"]);
  const body = [`tree ${tree}`, `parent ${parent}`, "author t <t@example.com> 1761800000 +0000", "committer t <t@example.com> 1761800000 +0000", `gpgsig -----BEGIN ${armor}-----`, " ", " AAAA", ` -----END ${armor}-----`, "", "forged", ""].join("\n");
  const sha = run(f.origin, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: body });
  run(f.origin, ["update-ref", "refs/heads/main", sha]);
  return sha;
}

/** npm serving `name` with versions { version: { files, publishedAt } }; returns fetch handlers by URL. */
export function npm(name, versions) {
  const routes = {};
  const meta = { versions: {}, time: {} };
  for (const [version, { files, publishedAt }] of Object.entries(versions)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-trust-tgz-"));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(tmp, "package"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "package", file), content);
    }
    assert.equal(spawnSync("tar", ["-czf", path.join(tmp, "p.tgz"), "-C", tmp, "package"]).status, 0);
    const bytes = fs.readFileSync(path.join(tmp, "p.tgz"));
    fs.rmSync(tmp, { recursive: true, force: true });
    const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
    routes[url] = () => new Response(bytes, { status: 200 });
    meta.versions[version] = { dist: { tarball: url, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } };
    meta.time[version] = publishedAt;
  }
  routes[`https://registry.npmjs.org/${name}`] = () => new Response(JSON.stringify(meta), { status: 200 });
  return routes;
}

export function mockFetch(routes, onCall = () => {}) {
  globalThis.fetch = async (url) => {
    onCall(String(url));
    const handler = routes[String(url)];
    return handler ? handler() : new Response("not found", { status: 404 });
  };
}

