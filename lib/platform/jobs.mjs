// The files that run the CLI later: the launchd job and systemd units for the
// scheduled update, and the ~/.t3blackout/bin/t3blackout shim. Paths and PATH
// come from the user's machine, so each is encoded for where it lands (XML,
// systemd's quoting, a shell word) rather than pasted in.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * `schedule`'s options as { hour, weekday }: --day hourly (the default), daily,
 * or a weekday name (weekday 0-6, Sunday first); --hour a whole hour, 0-23.
 */
export function parseSchedule({ hour = "4", day = "hourly" } = {}) {
  const at = Number(hour);
  const name = String(day).toLowerCase();
  const weekday = name === "hourly" ? "hourly" : name === "daily" ? null : WEEKDAYS.findIndex((w) => w.startsWith(name.slice(0, 3)));
  // Whole hours only: launchd and systemd take integers.
  if (weekday === -1 || !/^\d{1,2}$/.test(String(hour).trim()) || !Number.isInteger(at) || at < 0 || at > 23) {
    throw new Error("usage: t3blackout schedule [--hour 0-23] [--day hourly|daily|monday..sunday]");
  }
  return { hour: at, weekday };
}

const escapeXml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function plistValue(value, indent) {
  const pad = "  ".repeat(indent);
  if (typeof value === "boolean") return `${pad}<${value}/>`;
  if (Number.isInteger(value)) return `${pad}<integer>${value}</integer>`;
  if (typeof value === "string") return `${pad}<string>${escapeXml(value)}</string>`;
  if (Array.isArray(value)) return [`${pad}<array>`, ...value.map((item) => plistValue(item, indent + 1)), `${pad}</array>`].join("\n");
  if (value && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([key, item]) => [`${pad}  <key>${escapeXml(key)}</key>`, plistValue(item, indent + 1)]);
    return [`${pad}<dict>`, ...entries, `${pad}</dict>`].join("\n");
  }
  throw new Error(`can't put ${JSON.stringify(value)} in a property list`);
}

/** A property list (XML) for strings, integers, booleans, arrays and plain objects. */
export const plist = (value) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(value, 0),
    "</plist>",
    "",
  ].join("\n");

/**
 * The launchd job that runs `t3blackout update`: hourly (`weekday` "hourly") or
 * at `hour` daily (`weekday` null) or weekly (0-6, Sunday first), and whenever a
 * server here drops an update request. `daemon` (the host role): a system
 * LaunchDaemon that runs as `user`, so updates keep running with nobody logged
 * in; otherwise a LaunchAgent in that user's login session.
 */
export function launchdUpdateJob({ label, node, launcher, pathEnv, state, requests, hour, weekday, daemon = null }) {
  const trigger =
    weekday === "hourly"
      ? { StartInterval: 3600 }
      : { StartCalendarInterval: { ...(weekday === null ? {} : { Weekday: weekday }), Hour: hour, Minute: 0 } };
  return plist({
    Label: label,
    ...(daemon ? { UserName: daemon.user, InitGroups: true } : {}),
    ProgramArguments: [node, launcher, "update"],
    EnvironmentVariables: {
      PATH: pathEnv,
      // launchd gives a daemon none of a login's environment; T3BLACKOUT_HEADLESS
      // skips desktop notifications, which have no session to show in.
      ...(daemon ? { HOME: daemon.home, USER: daemon.user, LOGNAME: daemon.user, T3BLACKOUT_HEADLESS: "1" } : {}),
    },
    ...trigger,
    WatchPaths: [requests],
    StandardOutPath: path.join(state, "update.out.log"),
    StandardErrorPath: path.join(state, "update.out.log"),
    LowPriorityIO: true,
    Nice: 10,
    ...(daemon ? { ProcessType: "Background" } : {}),
  });
}

const noNewline = (text) => {
  if (/[\n\r]/.test(text)) throw new Error(`a path with a line break can't go in a systemd unit: ${JSON.stringify(text)}`);
  return text;
};

/** One systemd command-line argument: quoted, with \ " escaped and % and $ doubled (no specifiers, no variables). */
export const systemdArg = (text) => `"${noNewline(text).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** One Environment= assignment, quoted, with \ " escaped and % doubled. */
export const systemdEnv = (key, value) => `"${noNewline(`${key}=${value}`).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

/** The systemd user service and timer that run `t3blackout update` (see launchdUpdateJob for the schedule). */
export function systemdUpdateUnits({ node, launcher, pathEnv, hour, weekday }) {
  const calendar =
    weekday === "hourly"
      ? "hourly"
      : `${weekday === null ? "" : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]} `}*-*-* ${String(hour).padStart(2, "0")}:00:00`;
  // A callback, so `$&`, `$$` and the like in a value are inserted as written, not as replacement patterns.
  const fill = (name, values) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(key, () => value), fs.readFileSync(path.join(ROOT, "systemd", name), "utf8"));
  return {
    service: fill("t3blackout-update.service", {
      __PATH_ASSIGNMENT__: systemdEnv("PATH", pathEnv),
      __NODE__: systemdArg(node),
      __LAUNCHER__: systemdArg(launcher),
    }),
    timer: fill("t3blackout-update.timer", { __CALENDAR__: calendar }),
  };
}

/** `text` as one shell word: single-quoted, so nothing in it ($, `, \, spaces) is expanded. */
export const shellQuote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

/** The ~/.t3blackout/bin/t3blackout shim: this clone's CLI at a path skills can name. */
export const cliShim = ({ node, launcher }) =>
  `#!/bin/sh\n# Written by t3blackout: runs the CLI in the clone that builds this app.\nexec ${shellQuote(node)} ${shellQuote(launcher)} "$@"\n`;
