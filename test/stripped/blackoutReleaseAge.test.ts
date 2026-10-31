// Copied to packages/provider-core/src/server/ in a stripped upstream checkout and run there
// (rules provider/release-age-file, provider/updates-minimum-age, provider/updates-manual-reason).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { MIN_RELEASE_AGE_MINUTES, newestSettledVersion, releaseAgeCutoff, satisfiesEngine } from "./blackoutReleaseAge.ts";
import {
  createProviderVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  resolveLatestProviderUpdateAction,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
} from "./maintenanceResolver.ts";
import * as ProviderLatestVersions from "./ProviderLatestVersions.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const NODE = { node: "v20.11.1", npm: null };
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
type Release = { readonly age: number; readonly deprecated?: unknown; readonly engines?: unknown };
const doc = (latest: string, releases: Record<string, number | Release>) => {
  const entries = Object.entries(releases).map(([v, r]) => [v, typeof r === "number" ? { age: r } : r] as const);
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(entries.map(([v, { age: _, ...manifest }]) => [v, { name: "pkg", version: v, ...manifest }])),
    time: { created: daysAgo(400), modified: daysAgo(0), ...Object.fromEntries(entries.map(([v, { age }]) => [v, daysAgo(age)])) },
  };
};
const pick = (latest: string, releases: Record<string, number | Release>) => newestSettledVersion(doc(latest, releases), NOW, NODE);
const codex = (updateExecutable: string, updateArgs: ReadonlyArray<string>, updateLockKey: string) =>
  makeProviderMaintenanceCapabilities({ provider: ProviderDriverKind.make("codex"), packageName: "@openai/codex", updateExecutable, updateArgs, updateLockKey });

describe("blackout release age", () => {
  it("cuts off three days back, in whole seconds", () => {
    expect(releaseAgeCutoff(NOW)).toBe("2026-10-27T12:00:00Z");
    expect(MIN_RELEASE_AGE_MINUTES).toBe(4320);
  });
  it("takes the latest tag once it is three days old, deprecated or not, as npm does", () => {
    expect(pick("2.1.0", { "2.0.0": 30, "2.1.0": 3 })).toBe("2.1.0");
    expect(pick("2.1.0", { "2.0.0": 30, "2.1.0": { age: 5, deprecated: "use 2.2" } })).toBe("2.1.0");
  });
  it("falls back to the best older release while the tag is young, never past it", () => {
    expect(pick("2.1.0", { "2.0.0": 30, "2.0.5": 5, "2.1.0": 1, "2.1.0-beta.1": 10 })).toBe("2.0.5");
    expect(pick("2.0.5", { "2.0.4": 20, "2.0.5": 1, "3.0.0": 9 })).toBe("2.0.4");
  });
  it("reads hyphenated prereleases and build metadata as SemVer does", () => {
    // npm installs .2 here; a split on "-" picked .1.
    expect(pick("1.0.0-alpha-preview.3", { "1.0.0-alpha-preview.1": 10, "1.0.0-alpha-preview.2": 5, "1.0.0-alpha-preview.3": 1 })).toBe(
      "1.0.0-alpha-preview.2",
    );
    expect(pick("1.0.0-rc.3", { "0.9.0": 50, "1.0.0-rc.2": 7, "1.0.0-rc.3": 1, "0.9.1-beta": 9 })).toBe("1.0.0-rc.2");
    expect(pick("2.0.0", { "1.5.0+build.7": 9, "1.4.0": 20, "2.0.0": 1 })).toBe("1.5.0+build.7");
    expect(pick("1.0.0-rc.10", { "1.0.0-rc.9": 9, "1.0.0-rc.10": 1, "1.0.0-rc.1-0": 8 })).toBe("1.0.0-rc.9");
  });
  it("prefers live, engine-compatible releases the way npm-pick-manifest sorts them", () => {
    // An empty deprecation message clears it.
    expect(pick("1.3.0", { "1.1.0": 20, "1.2.0": { age: 10, deprecated: "" }, "1.3.0": 1 })).toBe("1.2.0");
    expect(pick("1.3.0", { "1.1.0": 20, "1.2.0": { age: 10, deprecated: "broken" }, "1.3.0": 1 })).toBe("1.1.0");
    expect(pick("1.3.0", { "1.1.0": 20, "1.2.0": { age: 10, engines: { node: ">=22" } }, "1.3.0": 1 })).toBe("1.1.0");
    // Fitting the engine outranks not being deprecated (npm-pick-manifest picks 1.1.0 here too).
    expect(pick("1.3.0", { "1.1.0": { age: 20, deprecated: "x" }, "1.2.0": { age: 10, engines: { node: ">=22" } }, "1.3.0": 1 })).toBe("1.1.0");
    expect(pick("1.3.0", { "1.1.0": 20, "1.2.0": { age: 10, engines: "node >= 0.6" }, "1.3.0": 1 })).toBe("1.2.0");
  });
  it("checks engines with node-semver's range grammar", () => {
    expect(satisfiesEngine("v20.11.1", "^18.17.0 || >=20.5.0")).toBe(true);
    expect(satisfiesEngine("v20.11.1", ">=14.17 <15 || >=16")).toBe(true);
    expect(satisfiesEngine("v20.11.1", "18.x || 22.x")).toBe(false);
    expect(satisfiesEngine("v20.11.1", "16 - 20")).toBe(true);
    expect(satisfiesEngine("v20.11.1", ">= 20.12")).toBe(false);
    expect(satisfiesEngine("v20.11.1", "not a range")).toBe(false);
    expect(satisfiesEngine("v20.11.1", 20)).toBe(false);
  });
  it("reports nothing when nothing qualifies, the tag has no publish time, or the document is malformed", () => {
    expect(pick("1.0.0", { "1.0.0": 1 })).toBeNull();
    const undated = doc("1.1.0", { "1.0.0": 30 });
    expect(newestSettledVersion({ ...undated, versions: { ...undated.versions, "1.1.0": {} } }, NOW, NODE)).toBeNull();
    expect(newestSettledVersion({ version: "1.0.0" }, NOW)).toBeNull();
    expect(newestSettledVersion(null, NOW)).toBeNull();
  });
  it("installs exactly the version the check reported with npm and pnpm, prereleases included", () => {
    const before = `--before=${releaseAgeCutoff(NOW)}`;
    const npm = codex("npm", ["install", "-g", before, "@openai/codex@latest"], "npm-global:/usr/local");
    expect(resolveLatestProviderUpdateAction(npm, "1.2.3")?.args).toEqual(["install", "-g", before, "@openai/codex@1.2.3"]);
    expect(resolveLatestProviderUpdateAction(npm, "1.3.0-rc.2")?.args.at(-1)).toBe("@openai/codex@1.3.0-rc.2");
    expect(resolveLatestProviderUpdateAction(npm, null)?.args.at(-1)).toBe("@openai/codex@latest");
    const pnpm = codex("pnpm", ["add", "-g", `--config.minimum-release-age=${MIN_RELEASE_AGE_MINUTES}`, "@openai/codex@latest"], "pnpm-global");
    expect(resolveLatestProviderUpdateAction(pnpm, "1.3.0-rc.2")?.args.at(-1)).toBe("@openai/codex@1.3.0-rc.2");
    expect(createProviderVersionAdvisory({ driver: ProviderDriverKind.make("codex"), currentVersion: "1.0.0", latestVersion: "1.2.3", maintenanceCapabilities: npm }).updateCommand).toContain("@openai/codex@1.2.3");
  });
  it.effect("asks the registry for the full document and reports the settled version", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      const client = HttpClient.make((request) => {
        requested.push(request.url);
        const now = Date.now();
        const body = {
          "dist-tags": { latest: "0.2.0" },
          versions: { "0.1.0": {}, "0.2.0": {} },
          time: { "0.1.0": new Date(now - 10 * 86_400_000).toISOString(), "0.2.0": new Date(now - 3_600_000).toISOString() },
        };
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })));
      });
      const version = yield* resolveLatestProviderVersion(codex("npm", ["install", "-g", "@openai/codex@latest"], "npm-global:/usr/local")).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(ProviderLatestVersions.layer),
      );
      expect(requested).toEqual(["https://registry.npmjs.org/%40openai%2Fcodex"]);
      expect(version).toBe("0.1.0");
    }),
  );
});

it.layer(NodeServices.layer)("blackout installers without a minimum age", (it) => {
  const definition = { provider: ProviderDriverKind.make("codex"), npmPackageName: "@openai/codex", nativeUpdate: null };
  const at = (resolved: string, real = resolved) =>
    resolvePackageManagedProviderMaintenance(definition, { binaryPath: "codex", resolvedCommandPath: resolved, realCommandPath: real, env: {}, platform: "darwin" });

  it.effect("leaves bun, yarn, Vite+ and Volta installs to the user, saying why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const volta = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-volta-" });
      yield* fs.makeDirectory(`${volta}/tools/image/packages/@openai/codex`, { recursive: true });
      const installs = [
        ["bun", yield* at("/Users/me/.bun/bin/codex")],
        ["yarn", yield* at("/Users/me/.config/yarn/global/node_modules/@openai/codex/bin/codex.js")],
        ["Vite+", yield* at("/Users/me/.vite-plus/bin/codex")],
        ["Volta", yield* at(`${volta}/bin/codex`, `${volta}/bin/volta-shim`)],
      ] as const;
      for (const [installer, capabilities] of installs) {
        expect(capabilities.update).toBeNull();
        expect(capabilities.manualReason).toContain(`installed with ${installer}`);
        const advisory = createProviderVersionAdvisory({
          driver: ProviderDriverKind.make("codex"),
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          maintenanceCapabilities: capabilities,
        });
        expect(advisory).toMatchObject({ status: "behind_latest", canUpdate: false, canInstallVersion: false, updateCommand: null });
        expect(advisory.message).toBe(`Version 1.2.0 is out. ${capabilities.manualReason}`);
        expect(advisory.message).toContain("Update this provider with npm or pnpm, or its own updater.");
      }
    }).pipe(Effect.scoped),
  );
  it.effect("still updates an npm global install, under --before", () =>
    Effect.gen(function* () {
      const capabilities = yield* at("/usr/local/bin/codex", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js");
      expect(capabilities.update?.lockKey).toBe("npm-global:/usr/local");
      expect(capabilities.update?.args.filter((arg) => /^--before=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(arg))).toHaveLength(1);
      expect(capabilities.manualReason).toBeUndefined();
    }),
  );
});
