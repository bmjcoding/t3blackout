// Copied to apps/server/src/device/ in a stripped upstream checkout and run there
// (rules server/device-tools-frozen, server/device-tools-native-assets-file):
// an install's completion marker names the exact closure reviewed for it, so a
// legacy or different install is redone (BUILD2-05), and installs run npm ci
// with no install scripts, then place native files from lib/native-assets.json
// (BUILD2-03).
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { BLACKOUT_NATIVE_ASSETS_SCRIPT } from "./blackoutNativeAssets.ts";
import { BLACKOUT_DEVICE_TOOL_LOCKS, DEVICE_HUB_VERSION, ensureDeviceHub, isDeviceHubInstalled } from "./DeviceToolchain.ts";
import { remoteDeviceScript } from "./sshDeviceScript.ts";

const HUB = `expo-device-hub@${DEVICE_HUB_VERSION}`;
const marker = `${DEVICE_HUB_VERSION} ${BLACKOUT_DEVICE_TOOL_LOCKS[HUB]?.digest ?? "unchecked"}`;
const ok = {
  code: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

/** An installed-looking hub at `base` whose .install-complete says `sentinel`. */
const installed = (base: string, sentinel: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(base, "tools", "expo-device-hub", DEVICE_HUB_VERSION);
    yield* fs.makeDirectory(path.join(dir, "node_modules/expo-device-hub/dist/server"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "node_modules/expo-device-hub/dist/server/cli.mjs"), "");
    yield* fs.writeFileString(path.join(dir, ".install-complete"), `${sentinel}\n`);
  });

it.effect("a version-only (legacy) marker isn't an install of the reviewed closure: it's redone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-device-marker-" });
    yield* installed(base, DEVICE_HUB_VERSION);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
    const calls: Array<ProcessRunner.ProcessRunInput> = [];
    yield* ensureDeviceHub(base).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input: ProcessRunner.ProcessRunInput) => {
          calls.push(input);
          return Effect.succeed(ok);
        },
      }),
      Effect.flip,
    );
    // Without a reviewed lock in this build nothing runs; with one, npm ci does.
    if (BLACKOUT_DEVICE_TOOL_LOCKS[HUB] === undefined) expect(calls).toEqual([]);
    else expect(calls[0]?.args).toEqual(["ci", "--ignore-scripts", "--no-fund", "--no-audit"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("the marker naming this build's closure is an install; another closure's isn't", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-device-marker-" });
    yield* installed(base, `${DEVICE_HUB_VERSION} ${"0".repeat(64)}`);
    expect(yield* isDeviceHubInstalled(base)).toBe(false);
    const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-device-marker-" });
    yield* installed(other, marker);
    expect(yield* isDeviceHubInstalled(other)).toBe(BLACKOUT_DEVICE_TOOL_LOCKS[HUB] !== undefined);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("installs run npm ci without scripts in the staging folder, then place the reviewed native files", () =>
  Effect.gen(function* () {
    const frozen = BLACKOUT_DEVICE_TOOL_LOCKS[HUB];
    if (frozen === undefined || frozen.needs.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-device-native-" });
    const calls: Array<ProcessRunner.ProcessRunInput> = [];
    yield* ensureDeviceHub(base).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input: ProcessRunner.ProcessRunInput) => {
          calls.push(input);
          return Effect.succeed(ok);
        },
      }),
      Effect.flip,
    );
    expect(calls[0]?.command).toBe("npm");
    expect(calls[0]?.cwd).toMatch(/\.staging-/);
    expect(calls[1]?.command).toBe(process.execPath);
    expect(calls[1]?.args.slice(0, 3)).toEqual(["-e", BLACKOUT_NATIVE_ASSETS_SCRIPT, calls[0]?.cwd]);
    expect(JSON.parse(calls[1]?.args[4] ?? "null")).toEqual(frozen.needs);
    expect(calls[1]?.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("the SSH device host script, with the locks and the native-files installer in it, is valid JavaScript", () => {
  const script = remoteDeviceScript("owner", "start");
  expect(() => new Function("require", script)).not.toThrow();
  expect(script).toContain("const installNativeAssets = async (dir, assets, needs) =>");
  expect(script).toContain("['ci', '--ignore-scripts', '--no-fund', '--no-audit']");
});
