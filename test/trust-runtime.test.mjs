// node --test test/: a release index the runtime scan needs that answers 404 fails
// the scan instead of reading as "no Node security releases" (PIPE-03). Its own
// file: lib/fastlane.mjs caches the index for the run.
import { test } from "node:test";
import assert from "node:assert/strict";

import { electronSecurityReason, runtimeAdvisories } from "../lib/fastlane.mjs";

test("a missing Node.js release index fails the runtime scan", async () => {
  globalThis.fetch = async (url) => {
    if (String(url) === "https://releases.electronjs.org/releases.json") {
      return new Response(JSON.stringify([{ version: "44.10.1", node: "24.22.1", chrome: "152.0.7977.167" }, { version: "44.10.0", node: "24.22.0", chrome: "152.0.7977.167" }]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  await assert.rejects(electronSecurityReason("44.10.0", "44.10.1"), /index\.json answered 404/);
  await assert.rejects(runtimeAdvisories(["electron@44.10.0"]), /answered 404/);
});
