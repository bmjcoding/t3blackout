// Loaded with --require into the preview's server only (lib/preview.mjs).
//
// macOS refuses to run setuid programs inside a sandbox, and Node throws that
// from spawn synchronously, which takes the server down: upstream runs /bin/ps
// (setuid) at startup to track its own processes. This points such commands at
// the unprivileged copies the sandbox made, listed in $T3BLACKOUT_PREVIEW_EXEC
// as { "/bin/ps": "<copy>" }.

"use strict";
const { ChildProcess } = require("node:child_process");

const copies = JSON.parse(process.env.T3BLACKOUT_PREVIEW_EXEC || "{}");
const originalSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const copy = options && copies[options.file];
  return originalSpawn.call(this, copy ? { ...options, file: copy } : options);
};
