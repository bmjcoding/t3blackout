// Copied to apps/desktop/src/ipc/methods/ in a stripped upstream checkout and run there
// (rule desktop/drift-report-file; lib/preview.mjs emits "preview-open").
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0" } }));

import { startPreview } from "./blackoutDriftReport.ts";

/** A stand-in CLI: `script` runs as `t3blackout preview --json`. */
function fakeCli(script: string) {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3b-preview-start-"));
  const state = NodePath.join(dir, "state");
  NodeFs.mkdirSync(state);
  NodeFs.writeFileSync(NodePath.join(state, "pending.json"), "{}");
  const launcher = NodePath.join(dir, "t3blackout.mjs");
  NodeFs.writeFileSync(launcher, script);
  return { node: process.execPath, launcher, state, dir };
}

const event = (value: object) => `console.log("t3blackout:event " + ${JSON.stringify(JSON.stringify(value))});`;

describe("blackout preview start", () => {
  it("answers once the preview's window is open", async () => {
    const cli = fakeCli(`console.log("starting"); setTimeout(() => { ${event({ type: "preview-open", version: "1.0.0" })} setTimeout(() => {}, 300); }, 200);`);
    await expect(startPreview(cli)).resolves.toBeNull();
  });
  it("reports the CLI's error when the preview fails to start", async () => {
    const cli = fakeCli(`${event({ type: "error", message: "the preview opens in Chrome or Chromium, and neither is installed" })} process.exit(1);`);
    await expect(startPreview(cli)).resolves.toBe("The preview couldn't start: the preview opens in Chrome or Chromium, and neither is installed");
  });
  it("reports a CLI that can't be run at all", async () => {
    const cli = fakeCli("");
    const node = NodePath.join(cli.dir, "node");
    NodeFs.writeFileSync(node, "", { mode: 0o644 });
    await expect(startPreview({ ...cli, node })).resolves.toMatch(/^The preview couldn't start: .*EACCES/);
  });
  it("says so when it's still starting", async () => {
    const cli = fakeCli("setTimeout(() => {}, 2000);");
    await expect(startPreview({ ...cli, timeoutMs: 300 })).resolves.toMatch(/still starting/);
  });
  it("needs a staged build", async () => {
    const cli = fakeCli("");
    NodeFs.rmSync(NodePath.join(cli.state, "pending.json"));
    await expect(startPreview(cli)).resolves.toBe("No update is waiting to be previewed.");
  });
});
