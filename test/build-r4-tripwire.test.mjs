// node --test test/: the tripwire's round-4 gaps, each tried for real against a
// local DNS server and HTTP receiver. BUILD4-01: a wrapper or shell line that
// changes how its command is found (env PATH=, -i, -C, -P; a shell's PATH=, cd,
// export PATH; execve's cwd lookup) must not hide a network client: it's looked
// up where the child would look, or refused as unreadable, and so is a shell
// command word that isn't plain. Upstream's own launch lines still run. BUILD4-02:
// a worker started with this thread's env or SHARE_ENV gets the tripwire before
// any NODE_OPTIONS preload, and SHARE_ENV stays shared.
import { spawn, spawnSync } from "node:child_process";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TRIPWIRE = fs.realpathSync(new URL("../lib/files/tripwire.cjs", import.meta.url));
const CURL = ["/usr/bin/curl", "/opt/homebrew/bin/curl", "/usr/local/bin/curl"].find((file) => fs.existsSync(file));
const ZSH = ["/bin/zsh", "/usr/bin/zsh"].find((file) => fs.existsSync(file));

/** A DNS server that answers NXDOMAIN and an HTTP receiver, counting what reaches them. */
async function receivers() {
  const seen = { dns: [], http: [] };
  const dns = dgram.createSocket("udp4");
  dns.on("message", (message, remote) => {
    seen.dns.push(message.subarray(12).toString("latin1"));
    const answer = Buffer.from(message);
    answer[2] = 0x81;
    answer[3] = 0x83;
    dns.send(answer, remote.port, remote.address);
  });
  const web = http.createServer((req, res) => {
    seen.http.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => dns.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    dnsPort: dns.address().port,
    url: (name) => `http://127.0.0.1:${web.address().port}/${name}`,
    close: () => Promise.all([new Promise((r) => dns.close(r)), new Promise((r) => web.close(r))]),
  };
}

/** Runs `code` in a node with the tripwire in NODE_OPTIONS, in `cwd`; resolves its logged attempts. */
async function tripped(code, { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r4-trip-")), home = cwd } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r4-log-")), "tripwire.jsonl");
  const child = spawn(process.execPath, ["-e", code], {
    cwd,
    env: { PATH: "/usr/bin:/bin", HOME: home, NODE_OPTIONS: `--require ${JSON.stringify(TRIPWIRE)}`, T3BLACKOUT_TRIPWIRE_LOG: log },
    stdio: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/**
 * Code that spawns `file args` in a process group of its own (a line may `kill 0`)
 * with a pipe on fd 3 (Claude's watcher reads it), and exits when it does.
 */
const spawned = (file, args) =>
  `const c = require("node:child_process").spawn(${JSON.stringify(file)}, ${JSON.stringify(args)}, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
   c.on("error", () => process.exit(0));
   c.on("exit", () => process.exit(0));
   setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} process.exit(0); }, 8000);`;

/** A scratch dir with bin/helper, a link to curl. */
function helperDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r4-bin-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.symlinkSync(CURL, path.join(dir, "bin", "helper"));
  return dir;
}

/** Each case must be logged once, matching `pattern`, and reach nothing. */
async function assertBlocked(cases, pattern, net, options) {
  for (const [name, [file, args]] of Object.entries(cases)) {
    const attempts = await tripped(spawned(file, args), options);
    assert.equal(attempts.length, 1, `${name}: ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0].kind, "exec", name);
    assert.match(attempts[0].host, pattern, `${name}: ${attempts[0].host}`);
  }
  assert.deepEqual(net.seen.http, []);
}

test("BUILD4-01: env PATH=, -i PATH=, -C, --chdir, -P and a shell's PATH= are followed: a curl link found there is blocked", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const dir = helperDir();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(dir, "a=b"));
  fs.symlinkSync(CURL, path.join(dir, "a=b", "helper"));
  const quiet = ["-q", "-s", "--max-time", "3"];
  try {
    await assertBlocked(
      {
        envPath: ["/usr/bin/env", [`PATH=${bin}:/usr/bin:/bin`, "helper", ...quiet, net.url("env-path")]],
        envIgnorePath: ["/usr/bin/env", ["-i", `PATH=${bin}`, "helper", ...quiet, net.url("env-i-path")]],
        envCwd: ["/usr/bin/env", ["-C", bin, "./helper", ...quiet, net.url("env-cwd")]],
        envChdir: ["/usr/bin/env", [`--chdir=${dir}`, "bin/helper", ...quiet, net.url("env-chdir")]],
        envCwdRelativePath: ["/usr/bin/env", ["-C", dir, "PATH=bin", "helper", ...quiet, net.url("env-cwd-path")]],
        envSearch: ["/usr/bin/env", ["-P", bin, "helper", ...quiet, net.url("env-search")]],
        envSplitCwd: ["/usr/bin/env", ["-S", `-C ${bin} ./helper -q -s ${net.url("env-split-cwd")}`]],
        // env takes any word with an "=" as an assignment, not only NAME=value.
        envOddAssignment: ["/usr/bin/env", ["a-b=c", CURL, ...quiet, net.url("env-odd")]],
        shellPath: ["/bin/sh", ["-c", `PATH=${bin}:/usr/bin:/bin helper -q -s --max-time 3 ${net.url("shell-path")}`]],
        shellTimePath: ["/bin/sh", ["-c", `time PATH=${bin}:/usr/bin:/bin helper -q -s ${net.url("shell-time-path")}`]],
        // A program whose path has an "=" isn't an assignment.
        equalsInPath: [path.join(dir, "a=b", "helper"), [...quiet, net.url("equals-in-path")]],
      },
      /^curl /,
      net,
      { cwd: dir },
    );
  } finally {
    await net.close();
  }
});

test("BUILD4-01: process.execve looks a bare name up in the cwd, not on PATH", { skip: (!CURL || typeof process.execve !== "function") && "no curl or execve" }, async () => {
  const net = await receivers();
  const dir = helperDir();
  try {
    const attempts = await tripped(`try { process.execve("helper", ["helper", "-q", "-s", ${JSON.stringify(net.url("execve-cwd"))}]); } catch {}`, { cwd: path.join(dir, "bin") });
    assert.equal(attempts.length, 1, JSON.stringify(attempts));
    assert.match(attempts[0].host, /^curl /);
    assert.deepEqual(net.seen.http, []);
  } finally {
    await net.close();
  }
});

test("BUILD4-01: a shell line that changes how its commands are found, or whose command word isn't plain, is refused", { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  const dir = helperDir();
  const bin = path.join(dir, "bin");
  const url = (name) => net.url(name);
  try {
    const cases = {
      cdThen: ["/bin/sh", ["-c", `cd ${bin} && ./helper -q -s ${url("cd")}`]],
      commandCd: ["/bin/sh", ["-c", `command cd ${bin}; ./helper -q -s ${url("command-cd")}`]],
      exportPath: ["/bin/sh", ["-c", `export PATH=${bin}:/usr/bin:/bin; helper -q -s ${url("export")}`]],
      standalonePath: ["/bin/sh", ["-c", `PATH=${bin}:/usr/bin:/bin; helper -q -s ${url("standalone")}`]],
      expandedPath: ["/bin/sh", ["-c", `PATH=${bin}:$PATH helper -q -s ${url("expanded")}`]],
      appendedPath: ["/bin/bash", ["-c", `PATH+=:${bin}; helper -q -s ${url("appended")}`]],
      expandedEnvCwd: ["/bin/sh", ["-c", `env -C "$HOME/bin" ./helper -q -s ${url("env-home")}`]],
      sourced: ["/bin/sh", ["-c", `. /dev/null; helper -q -s ${url("sourced")}`]],
      aliased: ["/bin/sh", ["-c", `alias h=${CURL}\nh -q -s ${url("alias")}`]],
      variableCommand: ["/bin/sh", ["-c", `c=${CURL}; $c -q -s ${url("variable")}`]],
      quotedInside: ["/bin/sh", ["-c", `cu"r"l -q -s ${url("quoted")}`]],
      escaped: ["/bin/sh", ["-c", `cu\\rl -q -s ${url("escaped")}`]],
      tilde: ["/bin/sh", ["-c", `~/bin/helper -q -s ${url("tilde")}`]],
      glob: ["/bin/sh", ["-c", `${CURL.slice(0, -1)}? -q -s ${url("glob")}`]],
      setPositional: ["/bin/sh", ["-c", `set -- ${CURL} -q -s ${url("set")}; "$@"`]],
      functionArgs: ["/bin/sh", ["-c", `f() { "$@"; }; f ${CURL} -q -s ${url("function")}`]],
      sudoChroot: ["/usr/bin/sudo", ["-n", "-R", "/", CURL, url("sudo-chroot")]],
      ...(ZSH && {
        zshPathArray: [ZSH, ["-c", `path=(${bin} $path); helper -q -s ${url("zsh-path")}`]],
        zshEquals: [ZSH, ["-fc", `=curl -q -s ${url("zsh-equals")}`]],
      }),
    };
    if (!fs.existsSync("/bin/bash")) delete cases.appendedPath;
    await assertBlocked(cases, /\(unreadable\)/, net, { cwd: dir, home: dir });
  } finally {
    await net.close();
  }
});

test('BUILD4-01: "$@", shift, eval, trap, reserved words and redirections don\'t hide a network client', { skip: !CURL && "no curl" }, async () => {
  const net = await receivers();
  try {
    const url = (name) => net.url(name);
    await assertBlocked(
      {
        positional: ["/bin/sh", ["-c", 'exec "$@"', "sh", CURL, "-q", "-s", url("positional")]],
        numbered: ["/bin/sh", ["-c", '"$1" -q -s "$2"', "sh", CURL, url("numbered")]],
        shifted: ["/bin/sh", ["-c", 'shift 2; exec "$@"', "sh", "/usr/bin/true", "x", CURL, "-q", "-s", url("shifted")]],
        ifCondition: ["/bin/sh", ["-c", `if curl -q -s ${url("if")}; then :; fi`]],
        negated: ["/bin/sh", ["-c", `! curl -q -s ${url("negated")}`]],
        loopBody: ["/bin/sh", ["-c", `for host in a; do curl -q -s ${url("loop")}; done`]],
        redirectedFirst: ["/bin/sh", ["-c", `> /dev/null curl -q -s ${url("redirected")}`]],
        evaluated: ["/bin/sh", ["-c", `eval curl -q -s ${url("eval")}`]],
        trapped: ["/bin/sh", ["-c", `trap 'curl -q -s ${url("trap")}' EXIT`]],
        braceGroup: ["/bin/sh", ["-c", `{ curl -q -s ${url("brace")}; } 2>/dev/null`]],
      },
      /^curl /,
      net,
    );
  } finally {
    await net.close();
  }
});

test("BUILD4-01: upstream's launch lines and plain wrapper uses still run, unlogged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r4-ok-"));
  const mark = (name) => path.join(dir, name);
  // As upstream (pinned) launches agents (packages/shared/src/AgentScope.ts), Claude
  // (ClaudeAdapterV2.ts), ACP agents on Linux (AcpSessionRuntime.ts) and reads the
  // login shell's env (packages/shared/src/shell.ts).
  const raise = "{ echo 800 >/proc/self/oom_score_adj; } 2>/dev/null";
  const cases = {
    agentScope: ["/bin/sh", ["-c", [raise, 'exec "$@"'].join("\n"), "t3-agent", "/usr/bin/touch", mark("agent")]],
    scopedAgent: ["/bin/sh", ["-c", [raise, ': "${XDG_RUNTIME_DIR:=$1}"', "export XDG_RUNTIME_DIR", "shift", 'exec "$@"'].join("\n"), "t3-agent", dir, "/usr/bin/touch", mark("scoped")]],
    claudeWatch: ["/bin/sh", ["-c", ["{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &", 'exec "$@" 3<&-'].join("\n"), "t3-claude", "/usr/bin/touch", mark("claude")]],
    acpCgroup: [
      "/bin/sh",
      [
        "-c",
        [
          "lease_path=$1; expected=$2; shift 2",
          raise,
          'printf "%s\\n" "$$" > "$lease_path/cgroup.procs" || exit 125',
          "actual=",
          "while IFS= read -r line; do",
          '  case "$line" in 0::*) [ -z "$actual" ] || exit 126; actual=${line#0::};; esac',
          "done < /proc/self/cgroup || exit 125",
          '[ "$actual" = "$expected" ] || exit 126',
          "unset ELECTRON_RUN_AS_NODE T3_ACP_CGROUP_WRAPPER",
          "trap 'exit 125' 0",
          '[ -f "$1" ] && [ -x "$1" ] || { printf "%s: %s: not an executable file\\n" "$0" "$1" >&2; exit 125; }',
          'exec "$@"',
        ].join("\n"),
        "t3-acp-cgroup-wrapper",
        path.join(dir, "no-lease"),
        "relative",
        "/usr/bin/touch",
        mark("acp-never"),
      ],
    ],
    envCapture: ["/bin/sh", ["-c", "printf '%s\\n' '__T3_ENV_START__'; printenv PATH || true; printf '%s\\n' '__T3_ENV_END__'"]],
    envPathBare: ["/usr/bin/env", ["PATH=/usr/bin:/bin", "touch", mark("env-path")]],
    envIgnoreBare: ["/usr/bin/env", ["-i", "HOME=/tmp", "touch", mark("env-i")]],
    shellPathLiteral: ["/bin/sh", ["-c", `PATH=/usr/bin:/bin touch ${mark("shell-path")}; command -v curl >/dev/null; for host in a; do :; done`]],
    setOptions: ["/bin/sh", ["-c", 'set -eu; exec "$@"', "sh", "/usr/bin/touch", mark("set-options")]],
  };
  for (const [name, [file, args]] of Object.entries(cases)) assert.deepEqual(await tripped(spawned(file, args)), [], name);
  for (const name of ["agent", "scoped", "claude", "env-path", "env-i", "shell-path", "set-options"]) assert.ok(fs.existsSync(mark(name)), name);
});

test("BUILD4-02: a worker started with this thread's env or SHARE_ENV runs the tripwire before a NODE_OPTIONS preload", async () => {
  const net = await receivers();
  try {
    const pre = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-r4-pre-")), "early.cjs");
    fs.writeFileSync(pre, `const r = new (require("node:dns").promises.Resolver)(); r.setServers(["127.0.0.1:${net.dnsPort}"]); r.resolve4("worker-env.invalid").catch(() => {});\n`);
    const worker = (options) =>
      `const wt = require("node:worker_threads"); process.env.NODE_OPTIONS = ${JSON.stringify(`--require ${pre}`)};
       new wt.Worker("setTimeout(() => {}, 200)", { eval: true, ${options} });`;
    for (const options of ["execArgv: []", "", "execArgv: [], env: wt.SHARE_ENV", "env: wt.SHARE_ENV", "env: process.env"]) {
      assert.deepEqual((await tripped(worker(options))).map((a) => a.host), ["worker-env.invalid"], options || "defaults");
    }
    assert.deepEqual(net.seen.dns, []);
  } finally {
    await net.close();
  }
});

test("BUILD4-02: SHARE_ENV stays one shared env and an inherited env stays a copy, each starting with the tripwire", () => {
  const code = `
    const wt = require("node:worker_threads");
    const run = (env) => new Promise((resolve) => {
      const w = new wt.Worker("process.env.SET_BY_WORKER = 'yes'; require('node:worker_threads').parentPort.postMessage(process.env.NODE_OPTIONS)", { eval: true, ...(env ? { env } : {}) });
      w.on("message", (options) => w.on("exit", () => resolve(options)));
    });
    (async () => {
      process.env.NODE_OPTIONS = "--max-old-space-size=128";
      const inherited = await run();
      const afterInherited = process.env.SET_BY_WORKER ?? null;
      const parentOptions = process.env.NODE_OPTIONS;
      const shared = await run(wt.SHARE_ENV);
      console.log(JSON.stringify({ inherited, afterInherited, parentOptions, shared, afterShared: process.env.SET_BY_WORKER ?? null, parentShared: process.env.NODE_OPTIONS }));
    })();`;
  const result = spawnSync(process.execPath, ["--require", TRIPWIRE, "-e", code], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  const first = `--require ${JSON.stringify(TRIPWIRE)} --max-old-space-size=128`;
  assert.equal(seen.inherited, first);
  assert.equal(seen.afterInherited, null, "an inherited env is the worker's own copy");
  assert.equal(seen.parentOptions, "--max-old-space-size=128", "an inherited env leaves this thread's alone");
  assert.equal(seen.shared, first);
  assert.equal(seen.afterShared, "yes", "SHARE_ENV is still shared");
  assert.equal(seen.parentShared, first);
});
