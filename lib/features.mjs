// Which strip rules a build may leave out.
//
// A rule listed under a feature fails open: if upstream moves the code it hooks
// into, the build drops the whole feature (every rule in it, and every feature
// that requires it) and still installs. The update says what it left out, and
// `t3blackout drift` shows what upstream changed (lib/drift.mjs).
//
// Every rule not listed here is strict: telemetry, phone-homes, the CSP, the app's
// identity and the updater. A strict rule that stops matching stops the update.
// New rules are strict until added here, so only list a rule whose absence costs
// looks or convenience, never privacy.
//
// `rules` are rule ids; a trailing * matches every id with that prefix.
// `requires` names features this one can't build or show without. Data
// attributes for t3blackout.css don't count: they're inert without it.

export const features = [
  {
    name: "names",
    label: "Blackout names",
    description: "T3 Blackout as the app name in a plain browser and the page title; the Ink and Orchid theme names",
    rules: ["web/branding-name", "web/branding-title", "web/theme-name-ink", "web/theme-name-orchid"],
  },
  {
    name: "product-name",
    label: "T3 Blackout in dialogs and menus",
    description: "Upstream's ~400 hardcoded mentions of T3 Code",
    rules: ["brand/name"],
  },
  {
    name: "styles",
    label: "Blackout styles",
    description: "t3blackout.css and the Blackout interface switches it loads with",
    rules: ["web/blackout-css", "web/blackout-css-import", "web/blackout-interface-file"],
  },
  {
    name: "brand-file",
    label: "Blackout brand components",
    description: "The wordmark, redaction art and version stamp components, and this build's version info and drift report",
    rules: ["web/blackout-brand-file", "web/blackout-build-info", "web/blackout-drift-report"],
    // Its components read the interface switches, which load with the styles.
    requires: ["styles"],
  },
  {
    name: "wordmark",
    label: "T3 BLACKOUT wordmark",
    description: "The sidebar logo",
    rules: ["web/blackout-wordmark"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "stage-art",
    label: "Redaction art",
    description: "Replaces the nightly starfield behind the sidebar and send button",
    rules: ["web/blackout-stage-art"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "version-stamp",
    label: "Version stamp",
    description: "The build version in the window's corner, with its changes and this report on hover",
    rules: ["web/blackout-version-stamp"],
    requires: ["brand-file", "styles"],
  },
  {
    name: "drift-viewer",
    label: "Report with screenshots in the app",
    description: "The version stamp opens this report, screenshots included; without it, a copy without them",
    rules: ["desktop/drift-report-*", "contracts/drift-report-bridge"],
  },
  {
    name: "send-button",
    label: "Ringed send button",
    description: "Lets t3blackout.css find the send button and the composer around it",
    rules: ["web/blackout-send-button"],
  },
  {
    name: "interface-settings",
    label: "Blackout interface switches",
    description: "The Blackout switches in Settings → Appearance → Interface; without them everything stays on",
    rules: ["web/blackout-interface-setting-file", "web/blackout-interface-setting-search", "web/blackout-interface-setting-rows"],
    requires: ["styles"],
  },
  {
    name: "glow-sidebar",
    label: "Glow on the sidebar footer buttons",
    description: "An ember ring and glow when you hover the icon buttons at the foot of the sidebar",
    rules: ["web/blackout-glow-sidebar"],
  },
  {
    name: "glow-update",
    label: "Glow on the update button",
    description: "An ember ring and glow when you hover the sidebar's update button",
    rules: ["web/blackout-glow-update"],
  },
  {
    name: "glow-attach",
    label: "Glow on the attach button",
    description: "An ember ring and glow when you hover the composer's attach button",
    rules: ["web/blackout-glow-attach"],
  },
  {
    name: "stage-pins",
    label: "Pinned patched dependencies",
    description: "Builds the app when a dependency upstream patches has published a newer version than its patch",
    rules: ["desktop/stage-pin-patched"],
  },
  {
    name: "app-icon",
    label: "Redacted app icon",
    description: "The redaction-bar app icon in the Dock and Finder, layered for Liquid Glass",
    rules: ["desktop/app-icon-*"],
  },
  {
    name: "host-update-requests",
    label: "Update everything for SSH hosts",
    description: "Update everything includes SSH hosts and asks each one's T3 Blackout updater to build the signed pin; without it, they need a manual update",
    rules: [
      "server/blackout-host-update-file",
      "server/self-update-requests-host-build",
      "server/self-update-host-capability",
      "contracts/self-update-blackout-host",
      "client/self-update-blackout-host-queued",
      "web/self-update-blackout-host*",
    ],
  },
  {
    name: "pdf-preview",
    label: "PDFs in the preview browser",
    description: "A PDF the preview browser opens shows in upstream's PDF viewer; without it, the CSP refuses upstream's embed and the page stays blank",
    rules: ["web/preview-pdf-viewer"],
  },
  {
    name: "update-track-note",
    label: "Update track explained",
    description: "Picking another update track says how T3 Blackout's pinned tracks are switched; without it, it says npm has no release",
    rules: ["web/update-track-pinned"],
  },
  {
    name: "usage-limits",
    label: "Usage limits after a failed probe",
    description: "Live limit updates replace 'Could not read limits'; Claude's idle reading says when limits will appear",
    rules: ["provider/usage-limits-clear-probe-failure", "provider/claude-usage-*"],
  },
];

const matches = (pattern, id) => (pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern);

/**
 * Maps each rule id in `rules` to its feature's name (strict rules are absent),
 * after checking the list above against them.
 */
export function featureIndex(rules) {
  const names = new Set(features.map((feature) => feature.name));
  const index = new Map();
  for (const feature of features) {
    for (const required of feature.requires ?? []) {
      if (!names.has(required)) throw new Error(`lib/features.mjs: ${feature.name} requires unknown feature ${required}`);
    }
    for (const pattern of feature.rules) {
      const hits = rules.filter((rule) => matches(pattern, rule.id));
      if (!hits.length && !pattern.endsWith("*")) throw new Error(`lib/features.mjs: ${feature.name} lists unknown rule ${pattern}`);
      for (const rule of hits) {
        const other = index.get(rule.id);
        if (other && other !== feature.name) throw new Error(`lib/features.mjs: ${rule.id} is in both ${other} and ${feature.name}`);
        index.set(rule.id, feature.name);
      }
    }
  }
  return index;
}

export const featureByName = (name) => features.find((feature) => feature.name === name);

/** Adds every feature that requires one in `skipped`, transitively, with why. */
export function skipDependents(skipped) {
  for (let grew = true; grew; ) {
    grew = false;
    for (const feature of features) {
      if (skipped.has(feature.name)) continue;
      const missing = (feature.requires ?? []).find((name) => skipped.has(name));
      if (missing) {
        skipped.set(feature.name, { reason: "requires", requires: missing });
        grew = true;
      }
    }
  }
  return skipped;
}
