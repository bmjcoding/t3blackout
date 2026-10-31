// node --test test/: values in the systemd units are inserted as written
// (lib/platform/jobs.mjs), never read as replacement patterns.
import { test } from "node:test";
import assert from "node:assert/strict";

import { systemdArg, systemdEnv, systemdUpdateUnits } from "../lib/platform/jobs.mjs";

test("$ sequences in paths and PATH survive into the units (HOST2-13)", () => {
  const launcher = "/opt/${HOME}/$&/t3blackout";
  const pathEnv = "/usr/bin:/odd/$&/$1/$$:/bin";
  const { service } = systemdUpdateUnits({ node: "/usr/bin/node", launcher, pathEnv, hour: 4, weekday: "hourly" });
  assert.ok(service.includes(systemdArg(launcher)), service);
  assert.ok(service.includes('"/opt/$${HOME}/$$&/t3blackout"'), "ExecStart keeps the doubled $");
  assert.ok(service.includes(systemdEnv("PATH", pathEnv)), service);
  assert.doesNotMatch(service, /__PATH_ASSIGNMENT__|__LAUNCHER__|__NODE__/);
});
