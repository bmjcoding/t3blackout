// Strip rules applied to every upstream checkout before it is built.
//
// Each rule targets one choke point, chosen so upstream churn rarely touches it.
// `count` is how many times the anchor must match; a mismatch aborts the update
// (see strip-engine.mjs). The zero-egress smoke test (lib/smoke.mjs) is the
// backstop for anything new upstream adds before a rule exists for it.

import * as fs from "node:fs";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const readFile = (name) => fs.readFileSync(path.join(here, "files", name), "utf8");

export const makeRules = () => [
  // ---------------------------------------------------------------- server --
  {
    id: "server/analytics-noop-layer",
    why: "PostHog batch upload every second, keyed by a hash of your Codex/Claude account id",
    file: "apps/server/src/server.ts",
    edits: [
      {
        find: "Layer.provideMerge(AnalyticsService.layer),",
        replace: "Layer.provideMerge(AnalyticsService.AnalyticsService.layerTest),",
      },
    ],
  },
  {
    id: "server/analytics-defaults",
    why: "Second guard: no PostHog key/host baked in, disabled even if the layer comes back",
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    edits: [
      { find: /Config\.withDefault\("phc_[A-Za-z0-9]+"\)/, replace: 'Config.withDefault("")' },
      { find: 'Config.withDefault("https://us.i.posthog.com")', replace: 'Config.withDefault("")' },
      {
        find: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true))',
        replace: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false))',
      },
    ],
  },
  {
    id: "shared/otel-export-off",
    why: "OTLP traces/metrics/logs export; picks up any OTEL_EXPORTER_OTLP_* in your shell",
    file: "packages/shared/src/otelEnvironment.ts",
    edits: [
      {
        find: "const disabled = t3.value ?? spec.value ?? false;",
        replace: "const disabled = true || (t3.value ?? spec.value);",
      },
    ],
  },
  {
    id: "server/cloud-public-config-off",
    why: "T3 Connect (relay.t3.codes, Clerk, cloudflared tunnel) gate",
    file: "apps/server/src/cloud/publicConfig.ts",
    edits: [
      {
        find: "export const hasCloudPublicConfig = Boolean(",
        replace: "export const hasCloudPublicConfig = false && Boolean(",
      },
    ],
  },
  {
    id: "server/cloud-reconcile-off",
    why: "Restarts a managed relay tunnel from stored secrets even when cloud config is absent",
    file: "apps/server/src/server.ts",
    edits: [
      {
        // The layer must still run: server activation waits on cloudLinkParked.
        // Skip straight to parking so no tunnel is ever started or recovered.
        find: /(const layerCloudDesiredLinkReconcile = Layer\.effectDiscard\(\n(\s+)Effect\.gen\(function\* \(\) \{\n)/,
        replace:
          "$1$2  if (!hasCloudPublicConfig) {\n$2    yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);\n$2    return;\n$2  }\n",
      },
      {
        // Assert-only: if upstream renames the parking signal, the guard above is wrong.
        find: "yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);",
        replace: "yield* Deferred.succeed(cloudLinkParked, undefined).pipe(Effect.orDie);",
        count: 2,
      },
    ],
  },
  {
    id: "server/relay-awareness-off",
    why: "Publishes agent activity to a stored relay URL",
    file: "apps/server/src/relay/AgentAwarenessRelay.ts",
    edits: [
      {
        find: /(const readRelayConfig = Effect\.gen\(function\* \(\) \{\s+const \[url, issuer, environmentCredential\] = yield\* Effect\.all\(\[\s+)readSecretString\(RELAY_URL_SECRET\),/,
        replace: "$1Effect.succeed<string | null>(null),",
      },
    ],
  },
  {
    id: "server/model-manifest-bundled-only",
    why: "Fetches model-manifest.json from raw.githubusercontent.com/pingdotgg; each rebuild ships the fresh bundled copy instead",
    file: "apps/server/src/server.ts",
    edits: [
      {
        find: "ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),",
        replace: "ModelManifest.layerTest,",
      },
    ],
  },
  {
    id: "contracts/provider-update-checks-off",
    why: "npm registry / Meta polling for provider CLI versions",
    file: "packages/contracts/src/settings.ts",
    edits: [
      {
        find: "enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),",
        replace: "enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),",
      },
    ],
  },
  {
    id: "server/litellm-rates-off",
    why: "Ungated fetch of LiteLLM pricing table from raw.githubusercontent.com",
    file: "apps/server/src/usage/UsageService.ts",
    edits: [
      {
        find: "yield* httpClient.get(LITELLM_RATES_URL).pipe(",
        replace: 'yield* Effect.fail("t3blackout: remote rate table disabled").pipe(',
      },
    ],
  },
  {
    id: "server/build-defines-empty",
    why: "Never bake relay/Clerk/Axiom values into the server bundle, whatever the build env holds",
    file: "apps/server/vite.config.ts",
    edits: [
      {
        find: /JSON\.stringify\(\s*repoEnv\.T3CODE_[A-Z_]+\?\.trim\(\) \?\? "",?\s*\)/,
        replace: 'JSON.stringify("")',
        count: 6,
      },
    ],
  },

  // ------------------------------------------------------------------- web --
  {
    id: "web/build-defines-empty",
    why: "Clerk, relay and browser-side relay tracing (Axiom) constants",
    file: "apps/web/vite.config.ts",
    edits: [
      {
        find: /repoEnv\.VITE_(?:T3CODE_RELAY_URL|CLERK_PUBLISHABLE_KEY|CLERK_JWT_TEMPLATE|CLERK_CLI_OAUTH_CLIENT_ID|RELAY_OTLP_TRACES_URL|RELAY_OTLP_TRACES_DATASET|RELAY_OTLP_TRACES_TOKEN)\?\.trim\(\) \|\| ""/,
        replace: '""',
        count: 7,
      },
    ],
  },
  {
    id: "shared/no-google-favicons",
    why: "Sends every hostname linked in chat to www.google.com/s2/favicons",
    file: "packages/shared/src/favicon.ts",
    edits: [
      {
        find: /return `https:\/\/www\.google\.com\/s2\/favicons\?domain=\$\{[^`]+`;/,
        replace: "return null;",
      },
    ],
  },
  {
    id: "web/no-npm-release-poll",
    why: "Polls registry.npmjs.org every 5 minutes",
    file: "apps/web/src/state/npmRelease.ts",
    edits: [
      {
        find: "`https://registry.npmjs.org/t3/${encodeURIComponent(version)}`",
        replace: '"data:application/json,{}"',
      },
    ],
  },
  {
    id: "web/branding-name",
    why: "Name in the UI when no desktop branding is injected (browser / `serve` mode)",
    file: "apps/web/src/branding.ts",
    edits: [
      {
        find: 'export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "T3 Code";',
        replace: 'export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "T3 Blackout";',
      },
    ],
  },
  {
    id: "web/branding-title",
    why: "Page title before the app mounts",
    file: "apps/web/index.html",
    edits: [{ find: "<title>T3 Code (Beta)</title>", replace: "<title>T3 Blackout</title>" }],
  },
  {
    id: "web/csp-plugin-file",
    why: "Fail-closed CSP for the UI: only loopback is reachable from the page",
    kind: "write",
    file: "apps/web/vite/t3blackout-csp.ts",
    content: readFile("t3blackout-csp.ts"),
  },
  {
    id: "web/csp-plugin-register",
    why: "Wire the CSP plugin into the web build",
    file: "apps/web/vite.config.ts",
    edits: [
      {
        find: 'import { tailwindPlugins } from "./vite/tailwind";',
        replace:
          'import { tailwindPlugins } from "./vite/tailwind";\nimport { t3blackoutCspPlugin } from "./vite/t3blackout-csp";',
      },
      {
        find: /plugins: \[\n(\s+)devCompressionPlugin\(\),/,
        replace: "plugins: [\n$1t3blackoutCspPlugin(),\n$1devCompressionPlugin(),",
      },
    ],
  },

  // --------------------------------------------------------------- desktop --
  {
    id: "desktop/boot-env",
    why: "Telemetry/updater env off for the app and every CLI it spawns; own data dir ~/.t3blackout",
    file: "apps/desktop/src/boot.ts",
    edits: [{ find: 'require("./compileCache.cjs");', replace: readFile("boot-env.cjs") + 'require("./compileCache.cjs");' }],
  },
  {
    id: "desktop/updater-off",
    why: "electron-updater polls the pingdotgg GitHub feed every 4 minutes; t3blackout rebuilds from source instead",
    file: "apps/desktop/src/updates/DesktopUpdates.ts",
    edits: [
      {
        find: "}): string | null {\n  if (!args.hasUpdateFeedConfig) {",
        replace:
          '}): string | null {\n  if (args) return "Updates are managed by t3blackout.";\n  if (!args.hasUpdateFeedConfig) {',
      },
    ],
  },
  {
    id: "desktop/no-publish-feed",
    why: "Never package app-update.yml (GITHUB_REPOSITORY / GH_TOKEN would otherwise add one)",
    file: "scripts/build-desktop-artifact.ts",
    edits: [
      {
        find: "if (!isDesktopPreviewVersion(version)) {\n    const publishConfig",
        replace: "if (false as boolean) {\n    const publishConfig",
      },
    ],
  },
  {
    id: "desktop/csp-no-cloudflare",
    why: "Drop the Turnstile script origin from the desktop CSP",
    file: "apps/desktop/src/electron/ElectronProtocol.ts",
    edits: [{ find: /\n\s+"https:\/\/challenges\.cloudflare\.com",/, replace: "" }],
  },
  {
    id: "desktop/identity-app-id",
    why: "Separate bundle id so it never collides with an installed official T3 Code",
    file: "scripts/build-desktop-artifact.ts",
    edits: [
      {
        find: 'const DESKTOP_APP_ID = "com.t3tools.t3code";',
        replace: 'const DESKTOP_APP_ID = "dev.t3blackout.app";',
      },
      {
        find: /(export function resolveDesktopProductName\(version: string\): string \{\n)/,
        replace: '$1  if (version) return "T3 Blackout";\n',
      },
    ],
  },
  {
    id: "desktop/identity-runtime-name",
    why: "Name shown in menus, About and macOS Keychain prompts (upstream hardcodes \"T3 Code\")",
    file: "apps/desktop/src/app/DesktopEnvironment.ts",
    edits: [{ find: 'const APP_BASE_NAME = "T3 Code";', replace: 'const APP_BASE_NAME = "T3 Blackout";' }],
  },
  {
    id: "desktop/identity-package-name",
    why: "Electron names the Keychain Safe Storage item after this; don't share the official app's key",
    file: "scripts/build-desktop-artifact.ts",
    edits: [{ find: '    name: "t3code",\n    version: appVersion,', replace: '    name: "t3blackout",\n    version: appVersion,' }],
  },
  {
    id: "desktop/identity-user-data",
    why: "Separate Chromium profile and single-instance lock from the official app",
    file: "apps/desktop/src/app/DesktopUserData.ts",
    edits: [
      {
        find: '{ current: "t3code-v2", legacy: "T3 Code (Alpha)" }',
        replace: '{ current: "t3blackout", legacy: "t3blackout-legacy" }',
      },
    ],
  },
];

/**
 * Strings that must not appear anywhere in the built output. Catches both rule
 * regressions and new phone-homes upstream adds with the same infrastructure.
 */
export const forbiddenInBuild = [
  "us.i.posthog.com",
  "phc_XOWci4",
  "relay.t3.codes",
  "clerk.t3.codes",
  // The production Clerk key, and its base64 payload (clerk.t3.codes). A bare
  // "pk_live_" would match Clerk's own prefix-parsing code.
  "pk_live_Y2xlcmsudDMuY29kZXMk",
  "Y2xlcmsudDMuY29kZXMk",
  "hzxSgY2cH10sDU2r",
  "api.axiom.co",
  "www.google.com/s2/favicons",
];
