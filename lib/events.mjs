// The app and the build account run t3blackout with --json and read
// `t3blackout:event {...}` lines from stdout; everything else is build output.
// The app only redraws progress on 10% steps, so each step should cross one.

export const EVENT_PREFIX = "t3blackout:event ";

let enabled = false;

export const enableEvents = (on) => {
  enabled = on;
};

export const emit = (event) => {
  if (enabled) console.log(EVENT_PREFIX + JSON.stringify(event));
};

export const progress = (percent) => emit({ type: "progress", percent });

export function parseEvent(line) {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
}
