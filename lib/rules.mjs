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

/** `updater`: { node, launcher, path } the app runs bin/t3blackout with. */
export const makeRules = ({ updater }) => [
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
    id: "provider/codex-analytics-off",
    why: "Codex posts usage events to chatgpt.com and Statsig metrics even under app-server; only config flags turn them off",
    file: "apps/server/src/provider/codexLaunchArgs.ts",
    edits: [
      {
        // Every launch (app-server, managed mode, exec) goes through here;
        // the user's own launch args come after, so they still win.
        find: "const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);",
        replace:
          'const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => [\n  "-c",\n  "analytics.enabled=false",\n  "-c",\n  \'otel.metrics_exporter="none"\',\n  ...tokenizeCliArgs(launchArgs),\n];',
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
    // Any stage label: builds trail upstream by the soak window, across renames like Alpha → Beta.
    edits: [{ find: /<title>T3 Code(?: \([A-Za-z]+\))?<\/title>/, replace: "<title>T3 Blackout</title>" }],
  },
  {
    // Labels only; the ids ("default", "t3-chat") stay so saved choices and
    // upstream's per-theme styling keep working. Must run before brand/name.
    id: "web/theme-name-ink",
    why: "The default theme is called Ink, not the product name",
    file: "apps/web/src/components/settings/ThemePreviewCircles.tsx",
    edits: [{ find: '    id: "default",\n    label: "T3 Code",', replace: '    id: "default",\n    label: "Ink",' }],
  },
  {
    id: "web/theme-name-orchid",
    why: "The T3 Chat theme is called Orchid",
    file: "packages/shared/src/themePalettes.ts",
    edits: [{ find: '  id: "t3-chat",\n  label: "T3 Chat",', replace: '  id: "t3-chat",\n  label: "Orchid",' }],
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

  {
    id: "web/claude-spinner-file",
    why: "Claude desktop-style working indicator: accent-coloured dots per activity, plus a random verb",
    kind: "write",
    file: "apps/web/src/components/chat/ClaudeSpinner.tsx",
    content: readFile("ClaudeSpinner.tsx"),
  },
  {
    id: "web/claude-spinner-css",
    why: "Its colour (the theme's accent), ellipsis and pulse",
    kind: "write",
    file: "apps/web/src/components/chat/ClaudeSpinner.css",
    content: readFile("ClaudeSpinner.css"),
  },
  {
    id: "web/claude-spinner-rows",
    why: "The Working row gets the mark and a random verb (Thinking rows keep upstream's brain); running tools tell the mark what they are doing",
    file: "apps/web/src/components/chat/MessagesTimeline.tsx",
    edits: [
      {
        find: 'import { WorkLogBlock, WorkLogButton, WorkLogDetails, WorkLogList, WorkLogRow } from "./WorkLog";',
        replace:
          'import { WorkLogBlock, WorkLogButton, WorkLogDetails, WorkLogList, WorkLogRow } from "./WorkLog";\nimport { ClaudeSpinnerLabel, useReportLiveActivity } from "./ClaudeSpinner";',
      },
      {
        find: "const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =\n    use(TimelineRowActivityCtx);",
        replace: "const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup, awaitingUser } =\n    use(TimelineRowActivityCtx);",
      },
      {
        // Worktree setup and compaction keep upstream's labels.
        find: /\) : row\.createdAt \? \(\n\s+<>\n\s+Working for <WorkingTimer createdAt=\{row\.createdAt\} \/>\n\s+<\/>\n(\s+)\) : \(\n\s+"Working\.\.\."\n\s+\);/,
        replace:
          ") : (\n$1  <ClaudeSpinnerLabel blocked={awaitingUser}>\n$1    {row.createdAt ? <WorkingTimer createdAt={row.createdAt} /> : null}\n$1  </ClaudeSpinnerLabel>\n$1);",
      },
      {
        find: "  const animated = active && !failed;\n  const showShimmer = animated && shimmer;\n",
        replace:
          "  const animated = active && !failed;\n  const showShimmer = animated && shimmer;\n  useReportLiveActivity(animated ? iconName : undefined);\n",
      },
    ],
  },

  // -------------------------------------------------------------- blackout --
  {
    id: "web/blackout-css",
    why: "Wordmark size, nightly redaction art, ringed send button, composer glow",
    kind: "write",
    file: "apps/web/src/t3blackout.css",
    content: readFile("t3blackout.css"),
  },
  {
    id: "web/blackout-css-import",
    why: "Load it after index.css",
    file: "apps/web/src/main.tsx",
    edits: [{ find: 'import "./index.css";', replace: 'import "./index.css";\nimport "./t3blackout.css";' }],
  },
  {
    id: "web/blackout-brand-file",
    why: "The T3 BLACKOUT wordmark and the redaction art that replaces the nightly starfield",
    kind: "write",
    file: "apps/web/src/components/BlackoutBrand.tsx",
    content: readFile("BlackoutBrand.tsx"),
  },
  {
    id: "web/blackout-wordmark",
    why: "Sidebar logo reads T3 BLACKOUT instead of T3 Code",
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    edits: [
      { find: 'import { T3Wordmark } from "../T3Wordmark";', replace: 'import { BlackoutWordmark } from "../BlackoutBrand";' },
      {
        find: /function SidebarBrandMark\(\{ onBackdrop \}: \{ onBackdrop: boolean \}\) \{\n  return \([\s\S]*?\n  \);\n\}/,
        replace:
          "function SidebarBrandMark(_props: { onBackdrop: boolean }) {\n  return <BlackoutWordmark />;\n}",
      },
    ],
  },
  {
    id: "web/blackout-stage-art",
    why: "The nightly starfield becomes Blackout's redaction bars; the send button drops its starfield fill for a ring (t3blackout.css)",
    file: "apps/web/src/components/SidebarStageBackdrop.tsx",
    edits: [
      { find: 'import { useId } from "react";', replace: 'import { useId } from "react";\n\nimport { BlackoutRedactedArt } from "./BlackoutBrand";' },
      {
        find: 'return variant === "nightly" ? <NightlySkyArt /> : <DevBlueprintArt />;',
        replace: 'return variant === "nightly" ? <BlackoutRedactedArt /> : <DevBlueprintArt />;',
      },
      {
        find: 'return variant === "nightly" ? <NightlySkyArt compact /> : <DevBlueprintArt compact />;',
        replace: 'return variant === "nightly" ? null : <DevBlueprintArt compact />;',
      },
    ],
  },
  {
    id: "web/blackout-send-button",
    why: "Lets t3blackout.css find the send button, and the composer around it, and the stage they are drawn for",
    file: "apps/web/src/components/chat/ComposerPrimaryActions.tsx",
    edits: [
      {
        find: 'type={showResume ? "button" : "submit"}',
        replace:
          'type={showResume ? "button" : "submit"}\n      data-t3b-send=""\n      data-stage-art={stageBackdropVariant ?? undefined}',
      },
    ],
  },
  {
    id: "shared/blackout-theme",
    why: "Built-in Blackout theme",
    file: "packages/shared/src/themePalettes.ts",
    edits: [
      {
        find: 'export const BUILT_IN_THEME_IDS = ["t3-chat", "grove", "ocean", "ember", "iris"] as const;',
        replace: 'export const BUILT_IN_THEME_IDS = ["blackout", "t3-chat", "grove", "ocean", "ember", "iris"] as const;',
      },
      {
        find: "export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [\n  T3_CHAT_THEME,",
        replace:
          readFile("blackout-theme.ts") +
          "export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [\n  BLACKOUT_THEME,\n  T3_CHAT_THEME,",
      },
    ],
  },
  {
    id: "web/blackout-theme-settings",
    why: "List Blackout first in Settings → Appearance",
    file: "apps/web/src/components/settings/ThemeSettings.tsx",
    edits: [
      {
        find: 'import { ThemeWireframe } from "./ThemeWireframe";',
        replace:
          'import { ThemeWireframe } from "./ThemeWireframe";\nimport { BLACKOUT_THEME } from "@t3tools/shared/themePalettes";',
      },
      {
        find: "const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [\n  T3_CHAT_THEME,",
        replace: "const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [\n  BLACKOUT_THEME,\n  T3_CHAT_THEME,",
      },
    ],
  },

  // --------------------------------------------------------------- desktop --
  {
    id: "desktop/boot-env",
    why: "Telemetry env off for the app and every CLI it spawns; own data dir ~/.t3blackout",
    file: "apps/desktop/src/boot.ts",
    edits: [{ find: 'require("./compileCache.cjs");', replace: readFile("boot-env.ts") + 'require("./compileCache.cjs");' }],
  },
  {
    id: "desktop/updater-file",
    why: "Updates are rebuilt from source by bin/t3blackout; this drives it from upstream's update UI",
    kind: "write",
    file: "apps/desktop/src/electron/BlackoutUpdater.ts",
    content: readFile("BlackoutUpdater.ts")
      .replace("__T3BLACKOUT_NODE__", () => JSON.stringify(updater.node))
      .replace("__T3BLACKOUT_LAUNCHER__", () => JSON.stringify(updater.launcher))
      .replace("__T3BLACKOUT_PATH__", () => JSON.stringify(updater.path)),
  },
  {
    id: "desktop/updater-layer",
    why: "electron-updater polls the pingdotgg GitHub feed every 4 minutes; swap in the t3blackout updater",
    file: "apps/desktop/src/main.ts",
    edits: [
      {
        find: 'import * as ElectronUpdater from "./electron/ElectronUpdater.ts";',
        replace:
          'import * as ElectronUpdater from "./electron/ElectronUpdater.ts";\nimport * as BlackoutUpdater from "./electron/BlackoutUpdater.ts";',
      },
      { find: "\n  ElectronUpdater.layer,\n", replace: "\n  BlackoutUpdater.layer,\n" },
    ],
  },
  {
    id: "desktop/updater-enabled",
    why: "Re-enable upstream's update UI in packaged builds (there is no release feed to require)",
    file: "apps/desktop/src/updates/DesktopUpdates.ts",
    edits: [
      {
        find: "}): string | null {\n  if (!args.hasUpdateFeedConfig) {",
        replace:
          "}): string | null {\n  if (args.isPackaged && !args.isDevelopment) return null;\n  if (!args.hasUpdateFeedConfig) {",
      },
    ],
  },
  {
    id: "desktop/updater-manual-checks-only",
    why: "Only checks you start reach GitHub; the startup and 4-minute polls read local state",
    file: "apps/desktop/src/updates/DesktopUpdates.ts",
    edits: [
      {
        find: 'import * as ElectronUpdater from "../electron/ElectronUpdater.ts";',
        replace:
          'import * as ElectronUpdater from "../electron/ElectronUpdater.ts";\nimport * as BlackoutUpdater from "../electron/BlackoutUpdater.ts";',
      },
      {
        find: "      return yield* electronUpdater.checkForUpdates.pipe(",
        replace:
          "      return yield* (\n        BlackoutUpdater.isManualCheck(reason)\n          ? BlackoutUpdater.checkUpstream\n          : electronUpdater.checkForUpdates\n      ).pipe(",
      },
      {
        // Assert-only: BlackoutUpdater.isManualCheck lists this reason.
        find: 'checkForUpdates("channel-change", "held")',
        replace: 'checkForUpdates("channel-change", "held")',
      },
    ],
  },
  {
    // Assert-only: if upstream renames these reasons, the sidebar button and app
    // menu would quietly stop reaching upstream. Keep BlackoutUpdater in sync.
    id: "desktop/updater-reason-web-ui",
    why: "Sidebar and Settings checks are user actions",
    file: "apps/desktop/src/ipc/methods/updates.ts",
    edits: [{ find: 'updates.check("web-ui")', replace: 'updates.check("web-ui")' }],
  },
  {
    id: "desktop/updater-reason-menu",
    why: "App menu \"Check for Updates\" is a user action",
    file: "apps/desktop/src/window/DesktopApplicationMenu.ts",
    edits: [{ find: 'updates.check("menu")', replace: 'updates.check("menu")' }],
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

  // ----------------------------------------------------------------- brand --
  {
    // Last: earlier rules anchor on some of these strings.
    id: "brand/name",
    why: "Upstream hardcodes the product name in ~400 dialogs, menus, notifications, permission prompts and CLI messages",
    kind: "rebrand",
    find: "T3 Code",
    replace: "T3 Blackout",
    roots: ["apps/web/src", "apps/web/index.html", "apps/desktop/src", "apps/server/src", "packages", "scripts/build-desktop-artifact.ts"],
    include: /\.(ts|tsx|html)$/,
    minCount: 200,
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
