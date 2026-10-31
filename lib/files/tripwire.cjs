// Network tripwire for the update smoke test (and the screenshots and preview),
// loaded via NODE_OPTIONS=--require.
//
// Blocks, and appends to $T3BLACKOUT_TRIPWIRE_LOG, every attempt from this Node
// process to leave the machine:
//   - TCP, TLS, HTTP(S), fetch and WebSocket connections (they all end in
//     net.Socket#connect) to anything but this machine. A name counts as this
//     machine only if it is localhost, *.localhost or this host's own name, and
//     then only if every address it resolves to is loopback or one of this
//     machine's interfaces; an address counts only if net.isIP says it is one
//     and it is loopback, unspecified or this machine's.
//   - DNS: dns.lookup of any other name, every query that goes to a DNS server
//     (resolve*, reverse, on the dns module, dns.promises and every Resolver),
//     and reverse lookups (lookupService) of other addresses.
//   - UDP: send() to, and connect() of, other addresses (a connected socket's
//     send has no address to check, so connect is checked instead).
//   - Child processes: every one inherits this tripwire as its first preload (a
//     real `--require` of it goes at the front of NODE_OPTIONS, with the log, even
//     into an `env: {}`, so nothing the caller preloads runs before it); workers
//     too, at the front of their execArgv and of the NODE_OPTIONS they start with
//     (their own env, this thread's, or the shared one). A network client (curl,
//     wget, ssh, nc, ...) is blocked and logged unless it only asks for its
//     version or help, whether run directly (known by the program that really
//     runs, found as the child finds it, not the argv[0] it's shown as, links
//     followed), through a wrapper (env, env -S, exec, command, nohup, nice,
//     timeout, ...; looked up where the wrapper looks: env -C, -P, -i, -u PATH,
//     PATH=...) or in a shell command line, by spawn, a sync call (shell option
//     included) or process.execve; so is a git command that talks to a remote, a
//     wrapper used in a form that can't be read, and a shell line that changes
//     how its commands are found (cd, a PATH change, alias, hash, source) or runs
//     a command word that isn't plain (an expansion other than "$@" and $1..,
//     quotes or escapes inside a word, a glob).
// Not covered: native addons and non-Node programs making their own sockets,
// process.binding() internals, and a child that is given its own NODE_OPTIONS
// without --require after it starts. The smoke test hides harness credentials so
// the only traffic left to catch is T3's own.

"use strict";
const fs = require("node:fs");
const net = require("node:net");
const dns = require("node:dns");
const dgram = require("node:dgram");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const workerThreads = require("node:worker_threads");
const { syncBuiltinESMExports } = require("node:module");
const { isLoopbackAddress } = require("./loopback.cjs");

const LOG = process.env.T3BLACKOUT_TRIPWIRE_LOG;
const SELF = __filename;

function record(kind, host, port) {
  const line = JSON.stringify({ kind, host: String(host), port: port ?? null, pid: process.pid });
  try {
    if (LOG) fs.appendFileSync(LOG, line + "\n");
  } catch {}
}

const blocked = (what, code) => Object.assign(new Error(`t3blackout tripwire: blocked ${what}`), { code });

// ------------------------------------------------------------ what's local --

const bare = (host) => String(host).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/** This machine's own interface addresses: traffic to them never leaves it. */
const ownAddresses = new Set(
  Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((entry) => bare(entry.address)),
);

function isLocalAddress(address) {
  const ip = bare(address);
  return net.isIP(ip) !== 0 && (isLoopbackAddress(ip) || ownAddresses.has(ip));
}

/** Names that resolve to this machine (checked again on their resolved addresses). */
function isLocalName(host) {
  const name = bare(host);
  return name === "" || name === "localhost" || name.endsWith(".localhost") || name === os.hostname().toLowerCase();
}

/** An address or name this machine may reach without resolving anything further. */
const isLocalTarget = (host) => (net.isIP(bare(host)) ? isLocalAddress(host) : isLocalName(host));

// ------------------------------------------------------------------- DNS --

const originalLookup = dns.lookup;

/** Wraps a lookup(hostname, options, callback): only local names, and only to local addresses. */
function guardLookup(lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") [callback, options] = [options, {}];
    const name = hostname ?? "";
    const done = (error) => process.nextTick(() => callback(Object.assign(error, { hostname: name })));
    if (net.isIP(bare(name)) ? !isLocalAddress(name) : !isLocalName(name)) {
      record("dns", name);
      return done(blocked(`lookup of ${name}`, "ENOTFOUND"));
    }
    return lookup.call(this, hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const outside = (Array.isArray(address) ? address.map((entry) => entry.address) : [address]).find((ip) => !isLocalAddress(ip));
      if (outside === undefined) return callback(null, address, family);
      record("dns", `${name} -> ${outside}`);
      callback(Object.assign(blocked(`${name}, which resolves to ${outside}`, "ENOTFOUND"), { hostname: name }));
    });
  };
}
dns.lookup = guardLookup(originalLookup);

// Every one of these asks a DNS server, whatever the name: none is local.
const QUERIES = ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse"];

function blockQueries(target, promises) {
  for (const name of QUERIES) {
    if (typeof target[name] !== "function") continue;
    target[name] = function (hostname, ...rest) {
      record("dns", hostname);
      const error = Object.assign(blocked(`DNS query ${name} ${hostname}`, "ENOTFOUND"), { hostname });
      if (promises) return Promise.reject(error);
      const callback = rest.find((arg) => typeof arg === "function");
      if (callback) process.nextTick(() => callback(error));
      return {};
    };
  }
}

function guardLookupService(target, promises) {
  const original = target.lookupService;
  if (typeof original !== "function") return;
  target.lookupService = function (address, port, callback) {
    if (isLocalAddress(address)) return original.apply(this, arguments);
    record("dns", address, port);
    const error = blocked(`reverse lookup of ${address}`, "ENOTFOUND");
    if (promises) return Promise.reject(error);
    if (typeof callback === "function") process.nextTick(() => callback(error));
  };
}

const dnsPromises = require("node:dns/promises");
for (const [target, promises] of [
  [dns, false],
  [dns.Resolver.prototype, false],
  [dnsPromises, true],
  [dnsPromises.Resolver.prototype, true],
]) {
  blockQueries(target, promises);
  guardLookupService(target, promises);
}
const originalPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = function (hostname, options) {
  const all = options !== null && typeof options === "object" && options.all === true;
  // The same checks as the callback lookup, around the promise one.
  const lookup = (name, opts, callback) =>
    originalPromiseLookup.call(dnsPromises, name, opts).then(
      (result) => (all ? callback(null, result) : callback(null, result.address, result.family)),
      (error) => callback(error),
    );
  return new Promise((resolve, reject) =>
    guardLookup(lookup)(hostname, options ?? {}, (error, address, family) => (error ? reject(error) : resolve(all ? address : { address, family }))),
  );
};

// ----------------------------------------------------------------- sockets --

// net.connect, tls.connect, http(s), undici/fetch and WebSocket all end here.
const originalConnect = net.Socket.prototype.connect;
const NORMALIZED = typeof net._normalizeArgs === "function" ? Object.getOwnPropertySymbols(net._normalizeArgs([{}]))[0] : null;

net.Socket.prototype.connect = function (...args) {
  if (!NORMALIZED) return refuseUnparsed.call(this, args);
  const normalized = Array.isArray(args[0]) && args[0][NORMALIZED] ? args[0] : net._normalizeArgs(args);
  const options = normalized[0] ?? {};
  if (options.path) return originalConnect.apply(this, args); // unix socket
  const host = options.host ?? options.hostname ?? "localhost";
  if (net.isIP(bare(host)) && isLocalAddress(host)) return originalConnect.apply(this, args);
  if (!net.isIP(bare(host)) && isLocalName(host)) {
    // Its addresses are checked as it resolves.
    normalized[0] = { ...options, lookup: guardLookup(options.lookup ?? originalLookup) };
    return originalConnect.call(this, normalized);
  }
  record("connect", host, options.port);
  process.nextTick(() => this.destroy(blocked(`connection to ${host}`, "ECONNREFUSED")));
  return this;
};

/** Without net._normalizeArgs (a future Node): refuse anything that isn't plainly local. */
function refuseUnparsed(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : "localhost";
  if ((first && typeof first === "object" && first.path) || (typeof first === "string" && Number.isNaN(Number(first)))) return originalConnect.apply(this, args);
  if (net.isIP(bare(host)) && isLocalAddress(host)) return originalConnect.apply(this, args);
  record("connect", host);
  process.nextTick(() => this.destroy(blocked(`connection to ${host}`, "ECONNREFUSED")));
  return this;
}

const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = args.find((arg, i) => i > 0 && typeof arg === "string");
  if (address === undefined || isLocalTarget(address)) return originalSend.apply(this, args);
  record("udp", address);
  const callback = args.findLast((arg) => typeof arg === "function");
  if (callback) process.nextTick(() => callback(blocked(`UDP to ${address}`, "ECONNREFUSED")));
};

const originalUdpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (port, address, callback) {
  if (typeof address !== "string" || isLocalTarget(address)) return originalUdpConnect.apply(this, arguments);
  record("udp", address, port);
  process.nextTick(() => this.emit("error", blocked(`UDP connection to ${address}`, "ECONNREFUSED")));
};

// ------------------------------------------------------- child processes --

/** NODE_OPTIONS split as Node splits it: on spaces, with "double quotes" and backslash escapes inside them. */
function nodeOptionWords(value) {
  const words = [];
  let word = null;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\\" && i + 1 < value.length) {
      word = (word ?? "") + value[++i];
    } else if (char === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (char === " " && !quoted) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** Whether `words` (CLI options) start by preloading this file: `--require <it>`, `-r <it>` or `--require=<it>`. */
const preloadsSelfFirst = (words) => words[0] === `--require=${SELF}` || ((words[0] === "--require" || words[0] === "-r") && words[1] === SELF);

/**
 * `env` with this tripwire required first and its log set, whatever the caller
 * passed. NODE_OPTIONS preloads run before the command line's and before any
 * --import, in order, so nothing a caller preloads can reach the network before
 * the tripwire is in place (requiring it again later is a no-op).
 */
function withTripwire(env) {
  const out = { ...(env ?? process.env) };
  const nodeOptions = out.NODE_OPTIONS ?? "";
  if (!preloadsSelfFirst(nodeOptionWords(nodeOptions))) out.NODE_OPTIONS = `--require ${JSON.stringify(SELF)} ${nodeOptions}`.trim();
  if (LOG) out.T3BLACKOUT_TRIPWIRE_LOG = LOG;
  return out;
}

const NETWORK_TOOLS = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ssh", "scp", "sftp", "ftp", "rsync", "nslookup", "dig", "host", "ping", "ping6", "traceroute", "aria2c", "http", "https", "xh"]);
const GIT_REMOTE = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
/** What a network client may be run with: asking for its version or help, nothing else (a config file can name a URL). */
const INFORMATIONAL = new Set(["--version", "-V", "--help", "-h", "-?"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
/** NAME=value words before a command: as env and sudo take them (any "=" after the first character), and as a shell does. */
const ENV_ASSIGNMENT = /^[^=]+=/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** Where a program is looked for when there's no PATH (execvp's default, and the sbins of `command -p`). */
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Commands that run another command (their operands), with every option each
 * takes: 0 (a flag), 1 (a value: `-u NAME`, `-uNAME`, `--unset=NAME`), "attached"
 * (an optional value, only ever attached) or "split" (env -S: its value is split
 * into more arguments). `operands`: values before the command (timeout's
 * duration); `numeric`: nice's old `-10`; `context`: options that change where
 * the command is looked up or what it runs in (see changedContext), "unreadable"
 * for ones that change it past knowing; `assignments`: NAME=value words it takes
 * before the command ("follow": a PATH among them is where the command is looked
 * up; "skip": it looks up on its own). A form these don't describe is refused:
 * what it would run can't be known.
 */
const WRAPPERS = {
  env: {
    options: { "-": 0, "-i": 0, "--ignore-environment": 0, "-0": 0, "--null": 0, "-v": 0, "--debug": 0, "-u": 1, "--unset": 1, "-C": 1, "--chdir": 1, "-P": 1, "-S": "split", "--split-string": "split" },
    context: { "-": "clear", "-i": "clear", "--ignore-environment": "clear", "-u": "unset", "--unset": "unset", "-C": "cwd", "--chdir": "cwd", "-P": "lookup" },
    assignments: "follow",
  },
  exec: { options: { "-c": 0, "-l": 0, "-a": 1 } },
  command: { options: { "-p": 0 }, context: { "-p": "default" } },
  builtin: { options: {} },
  nohup: { options: {} },
  nice: { options: { "-n": 1, "--adjustment": 1 }, numeric: true },
  timeout: { options: { "-s": 1, "--signal": 1, "-k": 1, "--kill-after": 1, "-f": 0, "--foreground": 0, "-p": 0, "--preserve-status": 0, "-v": 0, "--verbose": 0 }, operands: 1 },
  // A shell's `time` is a keyword before a command and its NAME=value words.
  time: { options: { "-a": 0, "--append": 0, "-h": 0, "-l": 0, "-p": 0, "--portability": 0, "-q": 0, "--quiet": 0, "-v": 0, "--verbose": 0, "-o": 1, "--output": 1, "-f": 1, "--format": 1 }, assignments: "follow" },
  stdbuf: { options: { "-i": 1, "--input": 1, "-o": 1, "--output": 1, "-e": 1, "--error": 1 } },
  caffeinate: { options: { "-d": 0, "-i": 0, "-m": 0, "-s": 0, "-u": 0, "-t": 1, "-w": 1 } },
  xargs: {
    options: {
      ...Object.fromEntries(["-0", "-o", "-p", "-r", "-t", "-x", "--null", "--no-run-if-empty", "--interactive", "--verbose", "--exit", "--open-tty"].map((flag) => [flag, 0])),
      ...Object.fromEntries(["-E", "-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-a", "-d", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"].map((flag) => [flag, 1])),
      ...Object.fromEntries(["-e", "-i", "-l", "--eof", "--replace", "--max-lines"].map((flag) => [flag, "attached"])),
    },
  },
  sudo: {
    options: {
      ...Object.fromEntries(["-A", "--askpass", "-B", "--bell", "-b", "--background", "-E", "-e", "--edit", "-H", "--set-home", "-i", "--login", "-K", "--remove-timestamp", "-k", "--reset-timestamp", "-l", "--list", "-n", "--non-interactive", "-P", "--preserve-groups", "-S", "--stdin", "-s", "--shell", "-v", "--validate"].map((flag) => [flag, 0])),
      ...Object.fromEntries(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-T", "--command-timeout", "-t", "--type", "-U", "--other-user", "-u", "--user"].map((flag) => [flag, 1])),
      "--preserve-env": "attached",
    },
    // -i runs a login shell in the target's home; -R another root.
    context: { "-D": "cwd", "--chdir": "cwd", "-i": "unreadable", "--login": "unreadable", "-R": "unreadable", "--chroot": "unreadable" },
    assignments: "skip",
  },
  doas: { options: { "-n": 0, "-s": 0, "-u": 1, "-C": 1 } },
  busybox: { options: {} },
};
// GNU coreutils as Homebrew installs them.
for (const name of ["env", "nice", "nohup", "timeout", "time", "stdbuf", "xargs"]) WRAPPERS[`g${name}`] = WRAPPERS[name];

/** env -S's string as words: plain words and 'single' or "double" quotes; null for anything more (escapes, $, comments). */
function splitString(value) {
  if (/[\\$#]/.test(value)) return null;
  const words = [];
  let word = null;
  let quote = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

/**
 * The command a wrapper given `args` runs, past its options (by `spec`) and
 * leading operands: { argv, changes } (argv empty when it runs nothing; changes:
 * its `context` options in order, as [kind, value]), or { unsupported: arg } for
 * a form `spec` doesn't describe or a change it can't follow.
 */
function wrapped(spec, args, changes = []) {
  let i = 0;
  let at = 0;
  const unreadable = () => ({ unsupported: args.slice(at).join(" ") });
  // env -S: its words take the place of the option, options included.
  const split = (value, rest) => {
    const words = typeof value === "string" ? splitString(value) : null;
    return words ? wrapped(spec, [...words, ...rest], changes) : { unsupported: `-S ${value}` };
  };
  // Notes an option that changes the command's context; true if that can't be followed.
  const note = (flag, value) => {
    const kind = spec.context?.[flag];
    if (kind) changes.push([kind, value]);
    return kind === "unreadable";
  };
  for (; i < args.length; i++) {
    const arg = args[i];
    at = i;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--help" || arg === "--version") return { argv: [], changes };
    if (arg === "-" && spec.options["-"] === 0) {
      note("-");
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) continue;
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) {
      const [flag, value] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
      const takes = spec.options[flag];
      if (takes === undefined || (takes === 0 && value !== undefined)) return unreadable();
      if (takes === "split") return value === undefined ? split(args[i + 1], args.slice(i + 2)) : split(value, args.slice(i + 1));
      if (note(flag, takes === 1 && value === undefined ? args[++i] : value)) return unreadable();
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = `-${arg[j]}`;
      const takes = spec.options[flag];
      if (takes === undefined) return unreadable();
      if (takes === 0) {
        if (note(flag)) return unreadable();
        continue;
      }
      const value = arg.slice(j + 1);
      if (takes === "split") return value ? split(value, args.slice(i + 1)) : split(args[i + 1], args.slice(i + 2));
      if (note(flag, takes === 1 && !value ? args[++i] : value)) return unreadable();
      break;
    }
  }
  i += spec.operands ?? 0;
  return { argv: args.slice(i), changes };
}

/** Whether `file` is a program `ctx` could run: an executable regular file. */
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The names `command` runs under: as given, and the program it really is (found
 * where the child looks: a wrapper's own search path, the child's PATH, the
 * default one when it has none, or from its cwd; links followed), so a link named
 * anything still counts as curl.
 */
function commandNames(command, ctx) {
  const name = path.basename(command);
  const dirs = command.includes("/") ? [""] : String(ctx.lookup ?? (ctx.env ?? process.env).PATH ?? DEFAULT_PATH).split(":");
  for (const dir of dirs) {
    const file = path.resolve(ctx.cwd ?? process.cwd(), dir, command);
    if (!runnable(file)) continue;
    try {
      return [...new Set([name, path.basename(fs.realpathSync(file))])];
    } catch {
      break;
    }
  }
  return [name];
}

/**
 * The context a wrapper's command is found and run in, after the wrapper's
 * `changes`: env -C (its cwd), -P (where this one command is looked up), -i (an
 * empty env, so no PATH), -u PATH, command -p (the default PATH). Null for a
 * value a shell would expand first: what it becomes can't be known.
 */
function changedContext(ctx, changes) {
  const next = { ...ctx, lookup: undefined };
  for (const [kind, value = ""] of changes) {
    if (ctx.shell && !plainWord(value)) return null;
    if (kind === "cwd") next.cwd = path.resolve(next.cwd ?? process.cwd(), value);
    else if (kind === "lookup") next.lookup = value;
    else if (kind === "default") next.lookup = DEFAULT_PATH;
    else if (kind === "clear") next.env = {};
    else if (kind === "unset" && value === "PATH") next.env = Object.fromEntries(Object.entries(next.env ?? process.env).filter(([key]) => key !== "PATH"));
  }
  return next;
}

/**
 * `argv` past the NAME=value words it starts with (`pattern`: what counts as
 * one) and the context its command is found in: { argv, ctx, setsPath }, a PATH
 * among them followed when `follow`. Null in a shell line for a PATH change it
 * can't follow: PATH+=, zsh's path, a value with an expansion.
 */
function assigned(argv, pattern, ctx, follow = true) {
  let i = 0;
  let setsPath = false;
  for (; i < argv.length && pattern.test(argv[i]); i++) {
    const variable = argv[i].slice(0, argv[i].indexOf("="));
    const value = argv[i].slice(argv[i].indexOf("=") + 1);
    if (!/^path\+?$/i.test(variable)) continue;
    if (ctx.shell && (variable !== "PATH" || !plainWord(value))) return null;
    if (variable !== "PATH") continue;
    setsPath = true;
    if (follow) ctx = { ...ctx, env: { ...(ctx.env ?? process.env), PATH: value } };
  }
  return { argv: argv.slice(i), ctx, setsPath };
}

/**
 * The commands in a shell command line, as argv lists: split at separators,
 * subshells, brace groups and substitutions (not `${...}`), with redirections
 * (`2>/dev/null`, `> file`, `<&3`) set aside and the quotes at a word's ends dropped.
 */
function shellCommands(line) {
  return String(line)
    .split(/;|&&|\|\||\||&|\n|\(|\)|\{(?=\s|$)|(?<=^|[\s;])\}|`|\$\(/)
    .map((command) => {
      const words = command.trim().split(/\s+/).filter(Boolean);
      const argv = [];
      for (let i = 0; i < words.length; i++) {
        if (!/^\d*[<>]/.test(words[i])) argv.push(words[i].replace(/^['"]|['"]$/g, ""));
        else if (/^\d*[<>]+[|&]?$/.test(words[i])) i++; // an operator alone: its target is the next word
      }
      return argv;
    })
    .filter((argv) => argv.length);
}

/** A shell word that means what it says: no expansion ($, `, ~, zsh's =cmd), quotes or escapes inside, or glob (`[` and `[[` are commands). */
const plainWord = (word) => word === "[" || word === "[[" || !/^=|[~$`'"\\*?[\]{}]/.test(word);

/** A shell word with "$@" ("$*"), $0, $1, ... replaced by `args` ($0 first; unknown: left as it is, an expansion). */
function positionalWords(word, args) {
  if (!args) return [word];
  if (/^\$(?:[@*]|\{[@*]\})$/.test(word)) return args.slice(1);
  const n = /^\$(?:(\d)|\{(\d+)\})$/.exec(word);
  return n ? [args[Number(n[1] ?? n[2])] ?? ""] : [word];
}

/** Reserved words a command can follow (`if curl ...`, `! curl ...`; fish's `and curl ...`), and zsh's precommand modifiers. */
const LEADING = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "coproc", "noglob", "nocorrect", "and", "or", "not", "begin"]);
/** Reserved words that start something other than a command (`for host in ...`, `case $x in ...`). */
const NOT_COMMANDS = new Set(["for", "case", "select", "function"]);
/** Builtins that change how later commands are found (cd, alias, hash) or run a file's commands (source). */
const SHELL_CONTEXT = new Set(["cd", "pushd", "popd", "chdir", "alias", "hash", "enable", ".", "source"]);
/** Builtins that set or unset variables: given PATH (or zsh's and csh's path), they change where commands are found. */
const SHELL_VARIABLES = new Set(["export", "declare", "typeset", "local", "readonly", "unset", "integer", "float", "set", "setenv", "unsetenv"]);

/**
 * What a shell command line would send out (`ctx.shell` runs it; `ctx.state.args`:
 * its $0 and positional arguments, followed through shift and set): each command
 * read as networkCommand reads one, past the reserved words before it, with
 * "$@" and $1.. replaced.
 */
function shellLine(line, ctx) {
  // A function's "$@" is its own.
  if (/\w\s*\(\s*\)|\bfunction\s/.test(line)) ctx.state.args = null;
  for (const words of shellCommands(line)) {
    let argv = words.flatMap((word) => positionalWords(word, ctx.state.args));
    while (LEADING.has(argv[0])) argv = argv.slice(1);
    if (!argv.length || NOT_COMMANDS.has(argv[0])) continue;
    // Its NAME=value words hold for its command; a PATH change without one, for the rest of the line.
    const command = assigned(argv, SHELL_ASSIGNMENT, ctx);
    if (!command || (command.setsPath && !command.argv.length)) return `${ctx.shell} (unreadable) ${argv.join(" ")}`;
    const found = networkCommand(command.argv, command.ctx);
    if (found) return found;
  }
  return null;
}

/**
 * A builtin's part in a shell line: one that changes how later commands are
 * found is unreadable; eval and trap run their arguments as a line; shift and
 * set move the positional arguments (to ones unknown when run through a
 * wrapper: it may not be the builtin). Undefined for anything else.
 */
function shellBuiltin([command, ...args], ctx) {
  if (SHELL_CONTEXT.has(command) || (SHELL_VARIABLES.has(command) && args.some((arg) => /^path(\+?=|$)/i.test(arg)))) return `${ctx.shell} (unreadable) ${[command, ...args].join(" ")}`;
  if (command === "eval" || command === "trap") return shellLine((args[0] === "--" ? args.slice(1) : args).join(" "), ctx);
  if ((command === "shift" || command === "set") && ctx.wrapped) {
    ctx.state.args = null;
    return null;
  }
  if (command === "shift") {
    const n = args.length === 0 ? 1 : /^\d+$/.test(args[0]) ? Number(args[0]) : NaN;
    const old = ctx.state.args;
    ctx.state.args = old && !Number.isNaN(n) ? [old[0], ...old.slice(1 + n)] : null;
    return null;
  }
  if (command === "set") {
    // `set -- ...` or `set word ...` sets new positional arguments (-o and +o take a name).
    for (let i = 0; i < args.length; i++) {
      if (/^[-+][A-Za-z]*o$/.test(args[i])) i++;
      else if (args[i] === "--" || !/^[-+]./.test(args[i])) ctx.state.args = null;
    }
    return null;
  }
  return SHELL_VARIABLES.has(command) ? null : undefined;
}

/**
 * What running `input` (program first, then its arguments; `ctx`: the child's
 * env and cwd, and inside a shell line its shell and state) would send out, as
 * "curl https://example.com", or null: a network tool run for anything but its
 * version or help, a git command that talks to a remote, a wrapper (env, exec,
 * nohup, ...) used in a form that can't be read, or in a shell line what
 * shellBuiltin and plainWord refuse. Sees through wrappers (looking the command
 * up where they would, NAME=value words included), and into shell command lines
 * (`sh -c`, `bash -lc`, ...).
 */
function networkCommand(input, ctx) {
  const argv = input.map(String);
  if (!argv.length) return null;
  if (ctx.shell) {
    if (!plainWord(argv[0])) return `${ctx.shell} (unreadable) ${argv.join(" ")}`;
    const builtin = shellBuiltin(argv, ctx);
    if (builtin !== undefined) return builtin;
  }
  const names = commandNames(argv[0], ctx);
  const operands = argv.slice(1).filter((arg) => arg && !arg.startsWith("-"));
  const target = () => operands.find((arg) => /^[a-z][\w+.-]*:\/\//i.test(arg) || /@/.test(arg)) ?? operands.at(-1) ?? argv.slice(1).join(" ");
  const tool = names.find((name) => NETWORK_TOOLS.has(name));
  if (tool) return argv.length > 1 && argv.slice(1).every((arg) => INFORMATIONAL.has(arg)) ? null : `${tool} ${target()}`.trim();
  const name = names.find((candidate) => Object.hasOwn(WRAPPERS, candidate) || SHELLS.has(candidate) || candidate === "git");
  if (name && Object.hasOwn(WRAPPERS, name)) {
    // `command -v x` and `command -V x` only look x up.
    if (name === "command" && ["-v", "-V"].includes(argv[1])) return null;
    const spec = WRAPPERS[name];
    const inner = wrapped(spec, argv.slice(1));
    const next = inner.unsupported === undefined ? changedContext({ ...ctx, wrapped: true }, inner.changes) : null;
    const command = next && (spec.assignments ? assigned(inner.argv, ENV_ASSIGNMENT, next, spec.assignments === "follow") : { argv: inner.argv, ctx: next });
    return command ? networkCommand(command.argv, command.ctx) : `${name} (unreadable) ${inner.unsupported ?? argv.slice(1).join(" ")}`.trim();
  }
  if (name && SHELLS.has(name)) {
    const flag = argv.findIndex((arg, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag === -1) return null;
    // The line's $0, $1, ...: the arguments after it.
    const args = argv.length > flag + 2 ? argv.slice(flag + 2) : [name];
    return shellLine(argv[flag + 1] ?? "", { env: ctx.env, cwd: ctx.cwd, shell: name, state: { args } });
  }
  if (name !== "git") return null;
  // git [-C dir] [-c key=value] [--git-dir dir] <subcommand>: skip global options and their values.
  for (let i = 1; i < argv.length; i++) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"].includes(argv[i])) i++;
    else if (!String(argv[i]).startsWith("-")) {
      const sub = argv[i];
      const remote = GIT_REMOTE.has(sub) || (sub === "remote" && ["update", "show", "prune"].includes(argv[i + 1])) || (sub === "submodule" && argv[i + 1] === "update");
      return remote ? `git ${sub} ${target()}`.trim() : null;
    }
  }
  return null;
}

/** A command that exits 126 at once: what a blocked network client runs instead. */
const REFUSED = ["/bin/sh", "-c", "exit 126"];

// Node has already applied `shell` and `argv0` here: `file` is the program that
// really runs (args[0] is only the name it's shown, which the caller picks).
const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  if (!options || !Array.isArray(options.envPairs)) return originalSpawn.call(this, options);
  const env = Object.fromEntries(options.envPairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const next = { ...options, envPairs: Object.entries(withTripwire(env)).map(([key, value]) => `${key}=${value}`) };
  const found = networkCommand([options.file, ...(options.args ?? []).slice(1)], { env, cwd: options.cwd });
  if (found) {
    record("exec", found);
    Object.assign(next, { file: REFUSED[0], args: REFUSED });
  }
  return originalSpawn.call(this, next);
};

/** The program and arguments a sync call runs: with `shell`, as Node runs it ([shell, "-c", the joined command]). */
function syncArgv(name, args, options) {
  const command = name === "execSync" ? [String(args[0] ?? "")] : [String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])];
  const shell = name === "execSync" ? options.shell || true : options.shell;
  return shell ? [typeof shell === "string" ? shell : "/bin/sh", "-c", command.join(" ")] : command;
}

/** spawnSync, execSync and execFileSync don't pass through ChildProcess#spawn. */
const syncOriginals = { spawnSync: childProcess.spawnSync, execFileSync: childProcess.execFileSync, execSync: childProcess.execSync };
function guardSync(name) {
  childProcess[name] = function (...args) {
    const at = args.findIndex((arg, i) => i > 0 && arg && typeof arg === "object" && !Array.isArray(arg));
    const given = at === -1 ? {} : args[at];
    const options = { ...given, env: withTripwire(given.env) };
    const found = networkCommand(syncArgv(name, args, given), { env: given.env ?? process.env, cwd: given.cwd });
    if (found) {
      record("exec", found);
      const run = name === "spawnSync" ? syncOriginals.spawnSync : syncOriginals.execFileSync;
      return run(REFUSED[0], REFUSED.slice(1), { ...options, shell: false });
    }
    if (at === -1) return syncOriginals[name].apply(this, name === "execSync" ? [args[0], options] : [args[0], Array.isArray(args[1]) ? args[1] : [], options]);
    return syncOriginals[name].apply(this, args.map((arg, i) => (i === at ? options : arg)));
  };
}
guardSync("spawnSync");
guardSync("execFileSync");
guardSync("execSync");

// process.execve replaces this process with another program: the same checks.
if (typeof process.execve === "function") {
  const originalExecve = process.execve;
  process.execve = function (file, args = [], env = process.env) {
    // execve searches no PATH: a bare name is a file in the cwd.
    const found = networkCommand([file, ...args.slice(1)], { env, lookup: "" });
    if (found) {
      record("exec", found);
      throw blocked(`running ${found}`, "EACCES");
    }
    return originalExecve.call(this, file, args, withTripwire(env));
  };
}

const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class Worker extends OriginalWorker {
  constructor(filename, options = {}) {
    // A worker starts from its execArgv (by default this thread's): preload the tripwire there first
    // whatever it's given (`execArgv: []`, a cleared env, a CLI-only --require, another preload before
    // it). Its constructor also applies the NODE_OPTIONS of the env it starts with, preloads first: its
    // own, a copy of this thread's (the default) or this thread's itself (SHARE_ENV: normalized in
    // place, so it stays one shared env). Each gets the tripwire at the front.
    const execArgv = [...(options?.execArgv ?? process.execArgv)];
    if (!preloadsSelfFirst(execArgv)) execArgv.unshift("--require", SELF);
    const env = options?.env;
    if (env === workerThreads.SHARE_ENV) {
      process.env.NODE_OPTIONS = withTripwire(process.env).NODE_OPTIONS;
      if (LOG) process.env.T3BLACKOUT_TRIPWIRE_LOG = LOG;
    }
    const own = env == null || typeof env === "object" ? { env: withTripwire(env ?? process.env) } : {};
    super(filename, { ...options, execArgv, ...own });
  }
};

// ESM `import { lookup } from "node:dns"` sees these too.
syncBuiltinESMExports();
