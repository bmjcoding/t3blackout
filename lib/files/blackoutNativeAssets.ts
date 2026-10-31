// t3blackout (lib/native-assets.mjs): device tools install with npm ci
// --ignore-scripts, so no package's install script downloads or builds anything.
// The native files such a script would have fetched come from
// lib/native-assets.json instead: this function downloads the archive reviewed
// for this platform, checks its SHA-256, and writes only the files listed for
// it, each checked again, where the package expects them, never outside the
// install folder (plain paths, real folders, no links followed). A package that
// needs a file this platform has no reviewed archive for fails the install.
//
// Plain JavaScript in a string: DeviceToolchain.ts runs it with node -e, and the
// SSH device host script embeds it, so both run the same code.
//
// (dir, assets, needs): the install folder; [{ path, package, platform, arch,
// url, sha256, files: { relativePath: sha256 } }]; [{ path, package }].
export const BLACKOUT_NATIVE_ASSETS_SOURCE = String.raw`async (dir, assets, needs) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const zlib = require('node:zlib');
  const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const glibc = process.platform !== 'linux' || Boolean(process.report && process.report.getReport().header.glibcVersionRuntime);
  const platform = glibc ? process.platform : 'linuxmusl';
  // The regular files in a tar archive, by path (ustar, with GNU and pax long names).
  const members = (tar) => {
    const found = new Map();
    let longName = null;
    for (let at = 0; at + 512 <= tar.length; ) {
      const header = tar.subarray(at, at + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
      const size = parseInt(field(124, 12).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length) throw new Error('a native archive is malformed');
      const body = tar.subarray(at + 512, at + 512 + size);
      const type = field(156, 1);
      const prefix = field(345, 155);
      const name = longName ?? (prefix ? prefix + '/' : '') + field(0, 100);
      longName = null;
      if (type === 'L') longName = body.toString('utf8').split('\0')[0];
      else if (type === 'x') {
        const record = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
        if (record) longName = record[1];
      } else if (type === '0' || type === '') found.set(name.replace(/^\.\//, ''), body);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return found;
  };
  // Every write stays inside dir, whatever the lock or manifest says: a package
  // folder by its plain node_modules path, a file by a plain relative path, and
  // only through real folders (a link, or a real path outside dir, fails).
  const refuse = (what) => {
    throw new Error('t3blackout refuses to write native files to ' + what + ': not a plain path inside the install folder');
  };
  const plain = (value) => {
    const parts = typeof value === 'string' ? value.split('/') : [];
    if (!parts.length || parts.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part))) refuse(JSON.stringify(value));
    return parts;
  };
  const packageFolder = (value) => {
    if (!/^node_modules\/(?:@[^/.][^/]*\/)?[^/.@][^/]*(?:\/node_modules\/(?:@[^/.][^/]*\/)?[^/.@][^/]*)*$/.test(String(value))) refuse(JSON.stringify(value));
    return plain(value);
  };
  let root = null;
  const write = (parts, content) => {
    root ??= fs.realpathSync(dir);
    let at = root;
    for (const part of parts.slice(0, -1)) {
      at = path.join(at, part);
      let stat = null;
      try {
        stat = fs.lstatSync(at);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!stat) fs.mkdirSync(at, { mode: 0o755 });
      else if (!stat.isDirectory()) refuse(at + ' (a link or a file)');
    }
    const real = fs.realpathSync(at);
    if (real !== root && !real.startsWith(root + path.sep)) refuse(at + ' (really ' + real + ')');
    // A fresh file renamed into place: a link already at the name is replaced, never followed.
    const temp = path.join(at, '.t3blackout-native-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(temp, content, { mode: 0o755, flag: 'wx' });
    fs.renameSync(temp, path.join(at, parts[parts.length - 1]));
  };
  for (const need of needs) {
    const asset = assets.find((candidate) => candidate.path === need.path && candidate.platform === platform && candidate.arch === process.arch);
    if (!asset) throw new Error('t3blackout has no reviewed native files of ' + need.package + ' for ' + platform + '-' + process.arch + ' (lib/native-assets.json), so it can\'t install here');
    const folder = packageFolder(need.path);
    for (const file of Object.keys(asset.files)) plain(file);
    const response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error('downloading ' + asset.url + ' failed (HTTP ' + response.status + ')');
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== asset.sha256) throw new Error(asset.url + " doesn't match the SHA-256 reviewed for it");
    const files = members(zlib.gunzipSync(archive));
    for (const [file, expected] of Object.entries(asset.files)) {
      const content = files.get(file);
      if (!content || sha256(content) !== expected) throw new Error(asset.url + ' has no ' + file + ' matching the SHA-256 reviewed for it');
      write([...folder, ...plain(file)], content);
    }
  }
}`;

/** A node -e script running it on argv: <dir> <assets JSON> <needs JSON>. */
export const BLACKOUT_NATIVE_ASSETS_SCRIPT =
  `(${BLACKOUT_NATIVE_ASSETS_SOURCE})(process.argv[1], JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))` +
  ".catch((error) => { console.error(error.message); process.exit(1); });";
