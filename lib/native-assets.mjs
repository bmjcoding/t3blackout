// Native files device tools need, which their install scripts would have
// downloaded. Device tools install with scripts off (lib/rules.mjs
// server/device-tools-frozen), so a package in a tool's closure that has an
// install script (read from the package itself, lib/device-tools.mjs
// installScriptPackages) must be listed in
// lib/native-assets.json, a file only you change: either the reviewed archives
// it needs per platform (URL, SHA-256, and the SHA-256 of each file taken from
// it) or none, with why. The app downloads the archive for its own platform,
// checks both hashes and writes only the listed files where the package
// expects them (lib/files/blackoutNativeAssets.ts). Nothing is ever built from source.

import * as fs from "node:fs";

const MANIFEST = new URL("./native-assets.json", import.meta.url);

const PLATFORMS = new Set(["darwin", "linux", "linuxmusl", "win32"]);
const ARCHES = new Set(["arm64", "x64", "arm", "ia32"]);
const HEX = /^[0-9a-f]{64}$/;
/** A relative path inside the package, in posix form: no `..`, no absolute path, nothing odd. */
const INSIDE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const NAME = "(?:@[a-z0-9][\\w.~-]*\\/)?[a-z0-9_][\\w.~-]*";
/** An npm package name, which is also what a package's folder in node_modules is called (an alias's too). */
export const PACKAGE_NAME = new RegExp(`^${NAME}$`, "i");
/**
 * A package's folder in an npm install: node_modules/<name>, or that under
 * another package's folder. Nothing else: no `..`, no absolute or odd parts.
 */
export const MODULE_PATH = new RegExp(`^node_modules/${NAME}(?:/node_modules/${NAME})*$`, "i");

/** Throws unless `manifest` is exactly the shape above; returns it. */
export function validateNativeAssets(manifest) {
  const fail = (why) => {
    throw new Error(`lib/native-assets.json is invalid: ${why}`);
  };
  if (!manifest || typeof manifest !== "object" || Object.keys(manifest).sort().join(",") !== "packages,version") fail("expected exactly { version, packages }");
  if (manifest.version !== 1) fail("version must be 1");
  for (const [pkg, entry] of Object.entries(manifest.packages ?? {})) {
    const at = pkg.lastIndexOf("@");
    if (at <= 0 || !pkg.slice(at + 1)) fail(`${pkg} isn't name@version`);
    if (!entry || Object.keys(entry).sort().join(",") !== "assets,why" || typeof entry.why !== "string" || !entry.why.trim()) fail(`${pkg}: expected { why, assets }`);
    if (!Array.isArray(entry.assets)) fail(`${pkg}: assets must be a list`);
    const seen = new Set();
    for (const asset of entry.assets) {
      if (!asset || Object.keys(asset).sort().join(",") !== "arch,files,platform,sha256,url") fail(`${pkg}: each asset is { platform, arch, url, sha256, files }`);
      if (!PLATFORMS.has(asset.platform) || !ARCHES.has(asset.arch)) fail(`${pkg}: unknown platform ${asset.platform}-${asset.arch}`);
      if (seen.has(`${asset.platform}-${asset.arch}`)) fail(`${pkg}: ${asset.platform}-${asset.arch} is listed twice`);
      seen.add(`${asset.platform}-${asset.arch}`);
      if (!/^https:\/\/[^\s/]+\/\S+\.(?:tar\.gz|tgz)$/.test(asset.url)) fail(`${pkg}: ${asset.url} isn't an https URL of a .tar.gz`);
      if (!HEX.test(asset.sha256)) fail(`${pkg}: sha256 must be 64 lowercase hex digits`);
      const files = Object.entries(asset.files ?? {});
      if (!files.length) fail(`${pkg}: an asset must name the files taken from it`);
      for (const [file, hash] of files) {
        if (!INSIDE.test(file)) fail(`${pkg}: ${file} isn't a plain path inside the package`);
        if (!HEX.test(hash)) fail(`${pkg}: ${file}'s sha256 must be 64 lowercase hex digits`);
      }
    }
  }
  return manifest;
}

/** lib/native-assets.json, validated. */
export const readNativeAssets = (file = MANIFEST) => validateNativeAssets(JSON.parse(fs.readFileSync(file, "utf8")));

/** The packages a package-lock.json's own hasInstallScript flags name, as [{ path, package }]. */
export function lockInstallScripts(lockText) {
  return Object.entries(JSON.parse(lockText).packages ?? {})
    .filter(([key, entry]) => key !== "" && entry?.hasInstallScript)
    .map(([key, entry]) => ({ path: key, package: `${entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}` }));
}

/**
 * What installing a device tool's closure with scripts off needs from
 * `manifest`. `scripted` is each package in it whose install script would have
 * run, as [{ path, package }] (the build reads that from the packages
 * themselves: lib/device-tools.mjs installScriptPackages), or a
 * package-lock.json's text, whose own flags say so (an early, offline hint).
 * Returns { needs: [{ path, package }], assets: [{ path, package, platform, arch,
 * url, sha256, files }] }, where `path` is the package's folder in the install
 * ("node_modules/x"). Throws, naming what to add to lib/native-assets.json, when
 * a package with an install script isn't listed, and on a folder that isn't a
 * plain one inside node_modules (the files would land elsewhere).
 */
export function nativeAssetsFor(scripted, manifest, tool = "the device tool") {
  const list = typeof scripted === "string" ? lockInstallScripts(scripted) : scripted;
  const needs = [];
  const assets = [];
  const missing = [];
  for (const { path, package: pkg } of list) {
    if (!MODULE_PATH.test(path)) throw new Error(`${tool}'s closure puts ${pkg} at ${path}, which isn't a plain folder inside its node_modules`);
    const listed = manifest.packages[pkg];
    if (!listed) {
      missing.push(pkg);
      continue;
    }
    if (!listed.assets.length) continue;
    needs.push({ path, package: pkg });
    for (const asset of listed.assets) assets.push({ path, package: pkg, ...asset });
  }
  if (missing.length) {
    throw new Error(
      `${tool}'s dependencies ${[...new Set(missing)].join(", ")} have install scripts, which device tool installs don't run. ` +
        "Read what each script fetches or builds, then list it in lib/native-assets.json (a commit you sign): " +
        'the prebuilt archives it needs per platform (url, sha256, and the sha256 of each file to take from it), or "assets": [] with why it needs none.',
    );
  }
  return { needs, assets };
}
