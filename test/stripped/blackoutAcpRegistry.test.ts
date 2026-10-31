// Copied to packages/provider-acp-registry/src/server/ in a stripped upstream checkout and run there
// (rules acp-registry/installs-minimum-age, acp-registry/no-prebuilt-binaries, acp-registry/no-prebuilt-binaries-message).
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const registryUrl = "https://registry.test/registry.json";
const archiveUrl = "https://registry.test/example-agent.tar.gz";
const SHA = "a".repeat(64);
const binary = { "linux-x86_64": { archive: archiveUrl, cmd: "./bin/example-agent", sha256: SHA } };
const agent = (distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"]): AcpRegistrySupport.AcpRegistryAgent => ({
  id: "example-agent",
  name: "Example Agent",
  version: "1.2.3",
  description: "ACP Registry test agent",
  distribution,
});
const settings = (input: Partial<AcpRegistrySettings> = {}) => Schema.decodeSync(AcpRegistrySettings)({ agentId: "example-agent", ...input });

describe("blackout ACP Registry distributions", () => {
  it("never chooses a prebuilt binary, checksum or not, even when asked for one", () => {
    const resolve = (distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"], preference: "auto" | "binary" | "npx" = "auto") =>
      AcpRegistrySupport.resolveAcpRegistryDistribution({ agent: agent(distribution), preference, platformTarget: "linux-x86_64" })?.kind;
    expect(resolve({ binary, npx: { package: "example-agent@1.2.3" } })).toBe("npx");
    expect(resolve({ binary, uvx: { package: "example-agent==1.2.3" } })).toBe("uvx");
    expect(resolve({ binary })).toBeUndefined();
    expect(resolve({ binary, npx: { package: "example-agent@1.2.3" } }, "binary")).toBeUndefined();
  });
  it("installs npm and uv packages only from releases three days old", () => {
    const source = NodeFs.readFileSync(NodePath.join(import.meta.dirname, "AcpRegistrySupport.ts"), "utf8");
    expect(source).toContain('["install", "--global", `--before=${releaseAgeCutoff()}`, packageSpec]');
    expect(source).toContain('["tool", "install", "--force", "--exclude-newer", releaseAgeCutoff(), packageSpec]');
    expect(source).not.toMatch(/\["install", "--global", packageSpec\]|\["tool", "install", "--force", packageSpec\]/);
  });
  it("says a binary-only agent isn't supported in T3 Blackout", () => {
    const driver = NodeFs.readFileSync(NodePath.join(import.meta.dirname, "driver.ts"), "utf8");
    expect(driver).toContain("has no npx or uvx package for this environment, so it isn't supported in T3 Blackout");
  });
});

it.layer(NodeServices.layer)("blackout ACP Registry binaries", (it) => {
  const requests: Array<string> = [];
  const layer = (registry: AcpRegistrySupport.AcpRegistryAgent) =>
    Layer.mergeAll(
      NodeServices.layer,
      TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(HostProcess.Architecture, "x64"),
      Layer.succeed(HostProcess.Environment, process.env),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          const body = request.url === registryUrl ? JSON.stringify({ version: "1.0.0", agents: [registry] }) : "#!/bin/sh\necho prebuilt\n";
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
        }),
      ),
    );

  it.effect("refuses a binary-only agent without downloading it, and never reuses one already cached", () =>
    Effect.gen(function* () {
      requests.length = 0;
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3b-acp-binary-" });
      const toolsDir = `${cacheDir}/tools`;
      // A copy an earlier build cached, where installBinary would look first.
      const cached = `${toolsDir}/example-agent/1.2.3/linux-x86_64/bin/example-agent`;
      yield* fs.makeDirectory(NodePath.dirname(cached), { recursive: true });
      yield* fs.writeFileString(cached, "#!/bin/sh\necho stale\n");
      yield* fs.chmod(cached, 0o755);
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({ cacheDir, toolsDir, registryUrl });

      const prepared = yield* Effect.flip(catalog.prepare({ agentId: "example-agent" }));
      expect(prepared.reason).toBe("unsupported_distribution");
      expect(prepared.detail).toContain("isn't supported in T3 Blackout");
      for (const distribution of ["auto", "binary"] as const) {
        const resolved = yield* Effect.flip(catalog.resolve(settings({ distribution }), "/workspace"));
        expect(resolved.reason).toBe("unsupported_distribution");
        expect(yield* catalog.inspect(settings({ distribution }))).toMatchObject({ status: "unsupported" });
      }
      expect(requests.filter((url) => url !== registryUrl)).toEqual([]);

      const onPath = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({ cacheDir, toolsDir, platform: "linux", architecture: "x64" });
      expect(onPath.filter((directory) => directory.includes("linux-x86_64"))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(agent({ binary })))),
  );
});
