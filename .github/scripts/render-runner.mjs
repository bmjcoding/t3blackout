// CI: the SSH runner as the remote shell receives it, for `sh -n` and
// ShellCheck. lib/files/ssh-runner-blackout.sh is pasted into a TypeScript
// template literal in upstream's packages/ssh/src/tunnel.ts (rule
// ssh/runner-installed-blackout-only), so its text is template source: `\${`
// and `\\n` are escapes, and an unescaped `${` or backtick would break the
// template. Rendering decodes it the way JavaScript does.
//   node .github/scripts/render-runner.mjs fragment <ssh-runner-blackout.sh> <out>
//   node .github/scripts/render-runner.mjs tunnel <stripped tunnel.ts> <out>   (the whole runner)

import * as fs from "node:fs";

import { isMain } from "./is-main.mjs";

/** Template literal source as the string it evaluates to; throws on an interpolation or a stray backtick. */
export function decodeTemplate(source) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "`") throw new Error(`unescaped backtick at offset ${i}: it would end the template literal`);
    if (c === "$" && source[i + 1] === "{") throw new Error(`unescaped \${ at offset ${i}: it would be a template interpolation`);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = source[++i];
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (next === "\n") continue; // a line continuation
    if (next in simple) out += simple[next];
    else if (next === "x" || next === "u") {
      const braced = next === "u" && source[i + 1] === "{";
      const hex = braced ? source.slice(i + 2, source.indexOf("}", i)) : source.slice(i + 1, i + (next === "x" ? 3 : 5));
      if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`bad \\${next} escape at offset ${i}`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += braced ? hex.length + 2 : hex.length;
    } else if (next === undefined) throw new Error("the template ends in a backslash");
    else out += next;
  }
  return out;
}

/** The whole runner from a stripped tunnel.ts: REMOTE_RUNNER_SCRIPT, placeholders filled with harmless values. */
export function runnerFromTunnel(tunnel) {
  const start = tunnel.indexOf("const REMOTE_RUNNER_SCRIPT = `");
  if (start === -1) throw new Error("tunnel.ts has no REMOTE_RUNNER_SCRIPT anymore; update .github/scripts/render-runner.mjs");
  const body = tunnel.slice(start + "const REMOTE_RUNNER_SCRIPT = `".length);
  const end = body.search(/(?<!\\)`/);
  if (end === -1) throw new Error("REMOTE_RUNNER_SCRIPT doesn't end");
  return decodeTemplate(body.slice(0, end)).replace(/@@(T3_[A-Z_]+_SCRIPT)@@/g, ":").replace(/@@T3_[A-Z_]+@@/g, "''");
}

if (isMain(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  const text = fs.readFileSync(input, "utf8");
  const script = mode === "tunnel" ? runnerFromTunnel(text) : mode === "fragment" ? `#!/bin/sh\n${decodeTemplate(text)}` : null;
  if (script === null) {
    console.error("usage: render-runner.mjs fragment|tunnel <input> <output>");
    process.exit(2);
  }
  fs.writeFileSync(output, script);
}
