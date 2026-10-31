// Shared fixtures for test/pipeline-*.test.mjs: small pnpm lockfiles with the
// shapes the real one has (two documents, peers, aliases, links, `?` keys).

export const OVERRIDES = [{ selector: "vuln@1.0.0", version: "1.0.1", advisories: ["GHSA-test"] }];

export const LONG_PEERS = Array.from({ length: 60 }, (_, i) => `(peer-${i}@1.0.0)`).join("");

const TOOLCHAIN = [
  "---",
  "lockfileVersion: '9.0'",
  "importers:",
  "  .:",
  "    configDependencies: {}",
  "    packageManagerDependencies:",
  "      pnpm:",
  "        specifier: 12.14.0",
  "        version: 12.14.0",
  "packages:",
  "  pnpm@12.14.0:",
  "    resolution: {integrity: sha512-a}",
  "snapshots:",
  "  pnpm@12.14.0: {}",
];

/**
 * A two-document pnpm lockfile: pnpm's toolchain, then a workspace whose root
 * depends on app (with a peer), an aliased typescript and a workspace link, and
 * whose packages/local depends on `big`, whose peer suffix makes a `?` key.
 * `snapshots`: { "name@version": [dependency "name: version" lines] }; undefined leaves one out.
 */
export function lockfile(snapshots) {
  const keys = Object.keys(snapshots).filter((key) => snapshots[key]);
  return [
    ...TOOLCHAIN,
    "---",
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      app:",
    "        specifier: 1.0.0",
    "        version: 1.0.0(peer@2.0.0)",
    "      typescript:",
    "        specifier: 'catalog:'",
    "        version: '@tsc-rs/typescript@0.8.0'",
    "      local:",
    "        specifier: workspace:*",
    "        version: link:packages/local",
    "  packages/local:",
    "    devDependencies:",
    "      big:",
    "        specifier: 1.0.0",
    `        version: 1.0.0${LONG_PEERS}`,
    "packages:",
    ...keys.flatMap((key) => [`  '${key}':`, `    resolution: {integrity: sha512-${key.length}}`]),
    "snapshots:",
    ...keys.flatMap((key) => {
      const snapshot = key === "app@1.0.0" ? `app@1.0.0(peer@2.0.0)` : key === "big@1.0.0" ? `big@1.0.0${LONG_PEERS}` : key;
      const deps = snapshots[key];
      // pnpm writes keys over 1024 characters as an explicit `?` entry.
      const head = snapshot.length > 1024 ? [`  ? ${snapshot}`, deps.length ? "  : dependencies:" : "  : {}"] : [`  '${snapshot}':${deps.length ? "" : " {}"}`, ...(deps.length ? ["    dependencies:"] : [])];
      return [...head, ...deps.map((dep) => `      ${dep}`)];
    }),
    "",
  ].join("\n");
}

export const COMMON = { "peer@2.0.0": [], "@tsc-rs/typescript@0.8.0": [], "shared@1.0.0": [], "big@1.0.0": ["shared: 1.0.0"] };

/** Upstream's: app -> vuln -> only-via-vuln; app and vuln -> shared. */
export const UPSTREAM = lockfile({
  ...COMMON,
  "app@1.0.0": ["vuln: 1.0.0", "shared: 1.0.0"],
  "vuln@1.0.0": ["only-via-vuln: 1.0.0", "shared: 1.0.0"],
  "only-via-vuln@1.0.0": [],
});

/** What a build resolves with the override: vuln@1.0.1, which brings newdep and no longer needs only-via-vuln. */
export const RESOLVED = lockfile({
  ...COMMON,
  "app@1.0.0": ["vuln: 1.0.1", "shared: 1.0.0"],
  "vuln@1.0.1": ["newdep: 3.0.0"],
  "newdep@3.0.0": [],
});

// ----------------------------------------------- the staged production install --

/** Upstream's sources a stage lockfile is checked against (lib/inventory.mjs stagedDependencies), by file. */
export const STAGE_SOURCES = {
  "apps/server/package.json": JSON.stringify({ dependencies: { "@cursor/sdk": "1.0.0", "@bufbuild/protobuf": "^2.0.0", effect: "catalog:", "node-pty": "workspace:*" } }),
  "apps/desktop/package.json": JSON.stringify({ dependencies: { "electron-webauthn": "catalog:", electron: "44.0.0", "react-grab": "^0.1.0" } }),
  "pnpm-workspace.yaml": "catalog:\n  effect: 4.0.5\n  electron-webauthn: 1.3.1\n  '@electron-webauthn/macos': 1.3.1\noverrides:\n  undici@^8: 8.12.2\n  '@electron-webauthn/macos': 'catalog:'\n",
  "scripts/lib/cli-external-packages.ts": [
    "/** Keep bundler externals and staged runtime dependency roots aligned. */",
    "const CLI_RUNTIME_EXTERNAL_PREFIXES = [",
    "  // Cursor ships computed imports; its \"helpers\" are packages too.",
    '  "@cursor/sdk",',
    '  "@yuuang/",',
    "] as const;",
    "",
    "const CURSOR_RUNTIME_DEPENDENCIES = [",
    '  "@bufbuild/protobuf",',
    '  "@connectrpc/connect",',
    "] as const;",
    "",
  ].join("\n"),
  "scripts/lib/desktop-external-packages.ts": 'const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = ["electron-webauthn"] as const;\n',
};

/** What STAGE_SOURCES has the packager stage, at the versions a fresh resolution picked. */
export const STAGED = { "@cursor/sdk": "1.0.0", "@bufbuild/protobuf": "2.0.1", "electron-webauthn": "1.3.1" };

/** A staged install's pnpm-lock.yaml: the staged app asking for `direct` (name -> version), `snapshots` as lockfile() takes them. */
export function stageLockfile(direct, snapshots) {
  const keys = Object.keys(snapshots).filter((key) => snapshots[key]);
  return [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    ...Object.entries(direct).flatMap(([name, version]) => [`      '${name}':`, `        specifier: ${version}`, `        version: ${version}`]),
    "packages:",
    ...keys.flatMap((key) => [`  '${key}':`, `    resolution: {integrity: sha512-${key.length}}`]),
    "snapshots:",
    ...keys.flatMap((key) => [`  '${key}':${snapshots[key].length ? "" : " {}"}`, ...(snapshots[key].length ? ["    dependencies:", ...snapshots[key].map((dep) => `      ${dep}`)] : [])]),
    "",
  ].join("\n");
}

/** The stage's packages: shared@1.0.0 as WORK has it, the rest only here (@electron-webauthn/types@1.4.0 is a newer patch than WORK would pick). */
export const STAGE_SNAPSHOTS = {
  "@cursor/sdk@1.0.0": ["shared: 1.0.0"],
  "@bufbuild/protobuf@2.0.1": [],
  "electron-webauthn@1.3.1": ["'@electron-webauthn/types': 1.4.0"],
  "@electron-webauthn/types@1.4.0": [],
  "shared@1.0.0": [],
};

export const STAGE_LOCK = stageLockfile(STAGED, STAGE_SNAPSHOTS);

/** npm's package.json of each version the fixtures have beyond upstream's lockfile, by name and version. */
export const NPM = {
  vuln: { "1.0.1": { dependencies: { newdep: "3.0.0" } } },
  newdep: { "3.0.0": {} },
  "@cursor/sdk": { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
  "@bufbuild/protobuf": { "2.0.1": {} },
  "electron-webauthn": { "1.3.1": { dependencies: { "@electron-webauthn/types": "^1.3.1" } } },
  "@electron-webauthn/types": { "1.4.0": {} },
};

/** lib/gates.mjs npmMeta over NPM. */
export const npmMeta = async (name) => (NPM[name] ? { versions: NPM[name] } : null);
