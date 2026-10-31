# T3 Blackout

Builds [T3 Code](https://github.com/pingdotgg/t3code) from upstream source with every
phone-home to T3 and third-party analytics removed, on macOS and Linux. Each machine
checks hourly for a new release pinned in `pin.json` and rebuilds when the pin or this
repository moves, and on demand from the app's update button. A CI evaluator proposes
the pin (it holds back releases with new dependencies under 3 days old), but CI is only
advisory: each machine checks a pin again itself, from git, npm and this repository,
before it builds or installs anything.

Runtime network enforcement is deliberately not part of this. Sandbox the agents with
your own tooling (e.g. [OpenShell](https://docs.nvidia.com/openshell/about/how-it-works.md));
Codex's and Claude Code's own sandboxes work normally.

## How it works

1. **Strip rules** (`lib/rules.mjs`). Small, anchored source edits applied to each
   upstream checkout. They remove:
   - PostHog analytics and OTLP export
   - T3 Connect, Clerk and the relay
   - the model-manifest and LiteLLM fetches
   - the UI's 5-minute npm poll for new `t3` releases, and Google favicon lookups
   - the Electron auto-updater and upstream's stock server downloads (replaced; see Updates)
   - upstream text that points you at stock T3 (`npx t3 …`, `t3@latest`, t3.codes
     downloads, pingdotgg's GitHub releases, "update manually"), replaced with T3
     Blackout's own commands (`~/.t3blackout/bin/t3blackout update` and `rollback`,
     the `t3` command Settings → About installs) and this README. The triage playbook
     the app gives an agent is T3 Blackout's own: it no longer fetches upstream's
     newer copy to follow instead, and it names `t3blackout update`. The updater's
     "Read more" and release-history links open upstream's commit list
     (`github.com/pingdotgg/t3code/commits/v<version>`), never a release page with
     downloads. A last strict rule (`stock/no-stock-guidance`) fails the build if any
     such text is left, so new stock wording upstream adds holds updates at the last
     good pin until a rule replaces it.

   (Provider CLI version checks are kept on purpose; see Updates.) They also give the
   app its own name, bundle ID and data directory, plus its look: the Redacted app
   icon (Dock, Finder and the startup splash, on every track), and touches that follow
   whichever theme you pick: the T3 BLACKOUT wordmark (an SVG lettered after the Black
   Ops II logo), redaction bars in place of the nightly starfield, a ringed send
   button, button glow, a version stamp and accent text selection. Each has its own
   switch in Settings → Appearance → Interface. There are no Blackout themes; use
   upstream's, or add a custom theme to change the accent. Each rule states how many
   times its anchor must match. What happens when upstream moves that code depends on
   the rule:

   - **Strict rules** (privacy, identity, the updater, the CSP) stop the update, and the
     installed build stays. Every rule is strict unless `lib/features.mjs` says otherwise.
   - **Feature rules** (the look, the usage-limits fix, host update requests, the PDF
     preview, the update-track note) are grouped into features in `lib/features.mjs`.
     If one stops matching, or stops compiling, the build leaves that whole feature
     out, plus any feature that requires it, and installs anyway. Upstream's own code
     runs in its place until the rule is updated.

   Every build writes a report (`lib/drift.mjs`, `lib/looks.mjs`). It opens with
   screenshots: your installed build and the new one each boot offline with an empty
   profile and the default theme (Ink) in dark, headless Chrome photographs the same
   screens in both, and the report shows them side by side with what changed
   highlighted. For each feature left out, it lists the upstream commits and pull
   requests that touched its code, the diff with the lines the rule hooked into
   highlighted, and where those lines live now if upstream moved them. A strict
   failure gets its own report: which strict rules stopped the update and how to get
   updates going again. Open it from the version stamp's hover card or with
   `bin/t3blackout drift`. Beside it go the report's data and screenshots as files
   (`<version>.json`, `<version>/`), which `bin/t3blackout review` gathers for an agent to read.

   Before the rules run, every host that upstream's app source writes in a URL is
   checked against `lib/known-hosts.txt`. Hosts are read the way a URL parser reads
   them (lowercase, punycode, no userinfo or trailing dot), IP literals included. Names
   under the reserved `.invalid`, `.test`, `.localhost` and `.example` TLDs and
   loopback addresses are skipped; `example.com`, `example.net` and `example.org`
   aren't (they resolve), so each use is listed. An unlisted host aborts the update:
   it may be a new phone-home that no rule targets and that the smoke test never
   triggers. Look at what talks to it, then add a rule or list the host with a note.

   The device tools upstream pins (`apps/server/src/device/deviceToolVersions.json`) get
   the same treatment against `lib/known-device-tools.txt`. The app npm-installs them
   when device support is on, so their code never passes through the rules or the host
   scan; a version not listed there (or approved by the evaluator after review) aborts
   the update until someone has read it.
   - **Frozen closures.** Each tool version's dependency lockfile is kept in `pin.json`
     (`deviceToolLocks`, with its SHA-256), resolved as of the tool's own publish date.
     Every Mac checks it before building:
     - the root is the tool alone;
     - every entry is a plain `node_modules/<name>` folder (nested ones allowed; no
       `..`, absolute or odd parts), holding npm's own tarball with npm's integrity,
       at least 3 days old;
     - each folder holds what npm installs there for the tool: starting from the tool,
       every package's dependencies (optional, peer and `npm:` aliases included) are
       looked up as Node finds them and must be that package in that range. An entry
       nothing asks for fails the check, so a lockfile can't slip in a decoy.

     A kept lockfile never changes or disappears. The build bakes it into the app (rule
     `server/device-tools-frozen`), which installs it with `npm ci --ignore-scripts`,
     locally and over SSH: exactly those versions and hashes, or nothing.
   - **No install scripts.** Which packages in a closure need native files is read
     from the packages themselves: the build downloads every closure's tarballs,
     checks them against their integrity hashes, and looks for an install script or a
     `binding.gyp`. The lockfile's own flags can only add to that list. Each one found
     must be listed in `lib/native-assets.json` (a file the repository owner signs):
     the prebuilt archive it needs per platform (URL and SHA-256, plus the SHA-256 of
     each file taken from it), or none, with why. The app downloads the archive for
     its own platform, checks both hashes and writes only those files, only inside
     the tool's install folder: it refuses a package path that isn't a plain
     `node_modules` one and never follows a link on the way. Nothing is built from
     source. An unlisted one holds the build, and the message says what to add. A
     platform with no listed archive can't install that tool (today
     `node-datachannel`, which `expo-device-hub` needs, is listed for darwin-arm64 and
     linux-x64 only).
   - **A version without a lockfile** stops the build with "pin.json has no reviewed
     dependency lockfile for device tool …". The evaluator proposes one when it clears a
     tool; for a version you reviewed by hand, run `bin/t3blackout device-tool-lock
     --tool name@version` and commit `pin.json`, signed.
   - Installed tools carry a marker naming their closure and native files, so a build
     with a different closure reinstalls them once.
2. **Boot environment** (`lib/files/boot-env.ts`). This runs first in the app.
   - It switches T3's telemetry off a second time.
   - It switches off the agent CLIs' own analytics and crash reporting where a switch
     exists: Claude Code, Grok, Pi, Muse, and Bun's crash reporter (which OpenCode uses).
     Codex only takes launch flags, so a rule adds them to every Codex launch. Claude
     Code's switch (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) also stops its
     background auto-updater while T3 Blackout runs it.
   - On Linux and Windows it turns off Electron's spellchecker, which would otherwise
     download dictionaries from Google.
   - It points the app at `~/.t3blackout`.

   A server started without the desktop app (an SSH host) gets the same switches
   (rule `server/headless-telemetry-env`).
3. **Content-Security-Policy.** The UI can only talk to loopback, so remote images, CDN
   icons and anything upstream adds to the page fail into their existing fallbacks. One
   policy (`lib/files/t3blackoutCsp.ts`) is applied by the page itself, by the server's
   static responses and by the desktop's app protocol. Files the server serves from
   your projects get the same policy. Agent-written HTML, MCP apps, SVGs and downloads
   keep upstream's sandbox policy plus a second one with the same loopback-only reach
   (their inline scripts still run), so they can't load anything from outside either:
   no CDNs, no external APIs. Inline PDFs get no policy, because Chrome's PDF viewer
   breaks under one.

   A CSP doesn't cover WebRTC, so the boot environment closes that route too. Every
   web contents in the app may send WebRTC over UDP only through a proxy
   (`disable_non_proxied_udp`), and Chromium never proxies UDP, so none does. The
   app's own session (its windows, and the requests the desktop process makes through
   Electron's network stack) goes through a proxy that refuses every connection, on a
   loopback port the app holds itself so nothing else can answer there; WebRTC's TCP
   path follows it. Loopback never goes through a proxy, so the app's windows still
   reach the local server and forwarded SSH ports, and nothing else. If the proxy
   can't be set, the app quits. The preview browser has sessions of its own: it loses
   WebRTC over UDP but keeps everything else, TCP WebRTC included. Copy Image on an
   image in a preview-browser page fetches it again through that page's own session
   (rule `desktop/context-menu-image-session`), so it works there too.

   **Device streams.** iOS Simulators and Android Emulators, on this Mac or on an SSH
   host, don't use WebRTC: their video and input travel over HTTP and WebSocket
   through T3's own server connection (for an SSH environment, its forwarded loopback
   port), which the block above doesn't touch (docs/two-mac-setup.md, 5.3). Only EAS
   Simulator, Expo's cloud simulators, streams over WebRTC. For it, the app's own page,
   and only its top frame, may open one hidden window of the app's own (rules
   `desktop/webrtc-window*`). That window is a separate web contents, so it keeps
   Chromium's default WebRTC policy; it stays on `about:blank`, opens nothing and
   closes with the page that opened it. The device viewer makes its peer connections
   there, directly to Expo's cloud over UDP, with the STUN and TURN servers Expo
   provides. Anything else that asks for that window (an agent's preview, an MCP app)
   gets an ordinary blocked one, so those still can't use WebRTC. The hidden window
   shares the app's session, so its TCP still goes to the refusing proxy: TURN over
   TCP or TLS isn't available, and on a network that blocks UDP, EAS devices show no
   video.
4. **Build verification.** Every package the rules edit is typechecked, so the injected
   files still match upstream's interfaces. A type error in a file a feature added or
   edited leaves that feature out; any other type error stops the update. The build
   output, and the packaged app right after it's collected (`check --build` included),
   are scanned for known telemetry endpoints and keys.
   - **Dependency installs** are resolved first (lockfile only, scripts off), checked
     (minimum age, security overrides, origin and integrity) and only then installed
     frozen. pnpm's own lockfile verification is forced on (`--no-trust-lockfile`), so
     upstream can't turn it off.
   - **Install scripts** run only for the packages the desktop build needs (esbuild,
     msgpackr-extract, node-pty, sharp, @tsc-rs/typescript; rule
     `deps/desktop-build-scripts-only`). Everything else in upstream's `allowBuilds`
     list is switched off, the mobile app's included, and new entries upstream adds
     start off.
   - **Local sources** in upstream's lockfile (workspace projects, `link:` targets,
     `file:` folders and `file:` tarballs) must name a path inside upstream's checkout
     and outside every `node_modules` folder, and only workspace projects may link;
     the lockfile check refuses anything else. Before the install, the build checks
     each one on disk against the pinned commit's file list (`git ls-tree`): after
     symlinks are followed, it must be inside the checkout and be a folder (a file,
     for a tarball) that the commit tracks. A `file:` folder, whose files pnpm copies,
     may hold only files the commit tracks (its `node_modules` aside) and no symlinks.
   - **The staged production install** upstream's packager runs while staging the app
     (it has no lockfile of its own) goes through the same guard: rule
     `desktop/stage-install-guarded` routes both of upstream's `vp install --prod`
     calls to it, and a third call stops the build. The stage is no commit's tree, so
     its lockfile may install nothing from local folders: a workspace project, link or
     `file:` source other than the stage itself stops the build. While the packager
     runs, `vp`, `pnpm`, `npm` and `yarn` on its `PATH` are shims that refuse every
     command aimed at the stage except reading what's installed (`list`, `why`, a
     version). The guard records every file it installed (path, mode, SHA-256). After
     packaging, every installed package must be in the lockfile that was checked, and
     every recorded file must be there unchanged. Packaging may add only what it was
     seen to add: a `*.node` copy whose bytes match an installed file, and, for a
     package with a `binding.gyp`, files in its `build/` folder or in node-gyp's
     scratch folder (a new `name@version` folder in its pnpm store entry). Anything
     else (a changed, missing or new file, a new package or link) fails the build:
     "the staged install in … isn't what was installed from its checked lockfile:
     node_modules/… changed, went or appeared". The log reports a good one as `staged
     install …: N packages checked, M beyond WORK's lockfile`.
   - Each build runs in its own private `TMPDIR`.
5. **Smoke test** (`lib/smoke.mjs`). The newly built server boots with a network
   tripwire preloaded (`lib/files/tripwire.cjs`), an empty `HOME` (no harness
   credentials) and a minimal `PATH`.
   - **What it catches:** the tripwire blocks and records every non-loopback connection,
     DNS lookup and UDP send from Node, in the server, its workers and every Node
     process it starts. It always loads first: it goes at the front of `NODE_OPTIONS`
     and of each worker's options, so nothing preloaded runs before it. A network
     client it spawns (curl, ssh, nc, a git command that talks to a remote, …) is
     blocked unless it only asks for its version or help. It's recognised by the
     program that really runs, whatever name it's started under (links followed),
     directly, through wrappers (`env`, `env -S`, `exec`, `nohup`, `timeout`, …), in
     shell command lines, from sync calls and `process.execve`. Each command is looked
     up where whatever runs it would look: a wrapper's own search path and folder
     (`env -C`, `-P`, `-i`, `-u PATH`, `PATH=…`), a shell line's `PATH=… cmd`, the
     default search path for a child given no `PATH`, and the current folder for
     `process.execve`, which doesn't search. A wrapper used in a form the tripwire
     can't read is blocked too, and so is a shell line that changes how its commands
     are found (`cd`, a `PATH` change, `alias`, `hash`, `source`, `.`) or runs a
     command word that isn't plain (`$x`, `~`, a glob, quotes or escapes inside a
     word; `"$@"` and `$1`… are read as the line's own arguments). Each is logged as
     `(unreadable)`, which fails the smoke test.
   - **Pass condition:** the server must answer with the CSP in place and make **zero**
     attempts in 20 s.
   - **Control:** unstripped upstream trips it within seconds (PostHog, GitHub).

   It catches a phone-home on the server's startup path, before any rule knows about
   it. It covers only that: the built server (the build's `apps/server` output under
   the build's Node, not the packaged Electron app) for its first 20 seconds with an
   empty profile. The desktop's main process, code paths that need a stored
   configuration, a signed-in provider or someone using the app, anything that starts
   later, native code, interpreters such as python or perl, a network client copied
   (not linked) under another name, and other programs that open their own sockets
   are outside it. The host scan, the forbidden-string scan and the strip rules are
   the checks for those.

   The packaged server runs under the same tripwire when an update takes the build
   report's screenshots (on a Mac with Chrome; see Install). If the new build's packaged
   server tries to reach the network then, the update fails and nothing is installed.

## Updates

Every update is a full rebuild from upstream source through the steps above; no
prebuilt T3 app or server release is downloaded. The build still downloads what
upstream's build does: Electron's prebuilt runtime and npm packages, some of which
fetch prebuilt native binaries.

- **Which release: `pin.json`.** A GitHub Actions job (`.github/workflows/evaluate.yml`,
  hourly) runs `bin/t3blackout evaluate` on each new upstream nightly release, newest
  first, and proposes the newest one that passes every gate. Only the nightly track is
  evaluated. Every machine builds exactly the pinned release, so a desktop and the
  hosts it reaches over SSH converge on the same version; each installs on its own
  schedule, so for a while they can be a build apart. A release is held when it:
  - adds a dependency version published less than **3 days** ago
    (`T3BLACKOUT_MIN_AGE_DAYS`; a value that isn't a non-negative number stops the
    CLI rather than switching the gate off). Upstream's own code isn't held back, only
    new third-party packages, which is where a hijacked release does its damage;
  - resolves a dependency from anywhere but the npm registry or upstream's own
    checkout (its workspace packages and local folders, never inside `node_modules`,
    which the build then checks against the pinned commit), unless that exact entry
    and its integrity are listed in `lib/known-resolutions.txt` (a file the owner
    signs; empty today), or gives a version it already had a different tarball or
    integrity. A dependency is its name and version plus where it was fetched from and
    its integrity hash, so a swapped tarball is a substitution and fails;
  - pins a device tool version that is under 3 days old, lacks npm provenance its
    predecessor had, reaches a network host or analytics library its predecessor
    didn't, has no reviewed dependency lockfile, or whose dependency closure brings a
    package under 3 days old or one that fails the same scan (`lib/gates.mjs`,
    `lib/device-tools.mjs`);
  - breaks a strict rule, names an unknown network host, fails to typecheck, leaks a
    forbidden endpoint, or makes any network call in the offline smoke test.

  **Each Mac is the authority.** CI's results are advisory. Before a Mac takes a pin
  the evaluator signed, it works out the gates above again from upstream's git, npm,
  OSV and this repository (see Updates to T3 Blackout itself), against the pin it
  already trusts, and then strips, typechecks, scans and smoke-tests the release itself
  before installing it. A forged CI result or a stolen evaluator key can at worst hold
  an update or make it fail there; it can't install code nobody checked.

  **Security fast lane** (`lib/fastlane.mjs`): a young dependency version skips the 3
  days when it fixes an advisory open against the pinned release (OSV lists it as the
  fix and no longer flags it) and stays in the vulnerable version's release line, or
  is a newer Electron of the same major whose embedded Node crosses a Node.js security
  release or whose Chromium version changes at all (Electron needs no open advisory).
  It must look like the usual publisher shipped it, judged against the versions of
  that package the pinned release already uses that are at least 3 days old (with
  none, there's no fast lane): the npm account that published it published
  one of those, and it declares the repository they declare. Those versions come only
  from the pinned release's own lockfile and the owner's overrides, never from what
  CI hands over. **A publisher change never gets the fast lane,** a switch to npm
  trusted publishing included: that version waits the 3 days like any other. If
  those versions carried npm provenance, the candidate's must name this exact tarball
  (package URL and SHA-512) and come from that repository, at a tag, the default
  branch or a `vN.x` branch. Provenance is only read, never verified (its Sigstore
  signatures aren't checked), so it can take a version out of the fast lane but never
  put one in. Verified provenance wouldn't be enough anyway: a modified workflow
  published malware with valid provenance in Oct 2026.

  **Security overrides** (`lib/overrides.json`, rule `deps/security-overrides`): for an
  advisory upstream hasn't fixed, an exact vulnerable version is replaced with the
  lowest same-major version that fixes it, vetted for publisher and provenance. Every
  build applies them through pnpm's `overrides` (and raises matching catalog entries),
  resolves the lockfile with scripts off, and checks the result against upstream's own
  lockfile: the same importers, the same version, dependencies and bytes for every
  package no override touches, no overridden version left, and every override's fix
  present wherever the build still reaches the version it replaces (a version only an
  overridden parent pulled in goes with that parent, whose fix decides what it needs
  instead); anything else the re-resolution added must be at least 3 days old and
  within the ranges npm declares for it. Only then does it install. Overrides are a
  repo file, so changing one needs the repository owner's signature; drop an entry
  once upstream ships the fix. Advisories with no same-major fix stay open as issues.

  **Alerts:** after the commit job, a third job checks the pin actually on `main`
  against OSV.dev, plus Electron's embedded Node and Chromium. It covers everything a
  build of that pin installs, and counts what the evaluate job hands over only once
  it has checked it:
  - **the lockfile the evaluate job resolved** (overrides applied, ~2,000 packages),
    checked as the commit job checks it: against upstream's own lockfile, and what
    the overrides brought in against npm. If it's missing or doesn't check out,
    upstream's lockfile with the overrides applied stands in;
  - **each device tool's frozen closure** from `pin.json`;
  - **the staged production install,** from a stage record: the staged lockfiles,
    bound to the upstream commit, this repository's build code (every file under
    `lib/` and `bin/`) and the platform. A record counts only if it stages exactly
    what upstream's packager stages at that commit (read from upstream's source: the
    server's and the desktop's external package lists, catalog ranges, fff's native
    binaries), each within its range, with the integrity hashes WORK's lockfile has,
    no version an override replaces, and each package's dependencies as WORK's
    lockfile or npm gives them. The next hourly run reuses the last run's record
    (`evaluate --stage-from`) if it passes the same check, and otherwise builds the
    pinned release again, so any commit that changes `lib/` or `bin/` costs one
    rebuild. If upstream restructures those package lists, the coverage issue says
    so, and `stagedDependencies` in `lib/inventory.mjs` needs updating.

  An evaluation that fails or times out still gets an advisory check, from upstream's
  lockfile with the overrides plus the device tools, with what it couldn't cover
  listed: each evaluate step has its own time limit under the job's 120 minutes (the
  evaluation itself 90), the evaluation writes each lockfile and stage record as soon
  as it has it (`--resolved`), and its artifact is uploaded whatever happened.

  High, critical, unrated and malicious-package advisories open
  one issue per package and channel, `[security] <package> (<channel>)`, labeled
  `security` (GitHub emails and pushes it); a new advisory for a package that already
  has one is a comment on it. Moderate and low ones go in `[security] Moderate and low
  advisories (<channel>)`, edited in place. CVSS 3.x and 2.0 vectors are scored; an
  advisory with only a CVSS 4.0 vector counts as unrated, so it alerts. Issues close
  themselves once the pin no longer has them, but none closes while part of the
  release couldn't be checked: `[security] Advisory coverage incomplete (<channel>)`
  says what's missing. When every newer release is held, `Upstream <channel> releases
  held` says why. It closes only when the pin the commit job pushed is the one on
  `main`, or upstream has nothing newer (`bin/t3blackout releases`, read from upstream
  itself); the evaluate job's exit code can open it, never close it. The automation
  only touches issues its bot opened with its marker.

  **The job is split** so the signing key never shares a runner with upstream code:
  `evaluate` builds and smoke-tests with a read-only token (plus `actions: read`, to
  fetch the last run's stage records) and no secrets, and its pin is only a proposal.
  `commit`, on a fresh runner that runs no upstream or npm code, re-derives every gate
  it can from git, npm and OSV (`bin/t3blackout pin-check --candidate`,
  `lib/pincheck.mjs`) before anything is signed: the pin is valid, only the evaluated
  channel moves, and only forward; each tag names its pinned commit upstream (`git
  ls-remote`); every newly approved device tool is pinned by that release, has a
  reviewed dependency lockfile that checks out, and passes review (its code and its
  closure), with no lockfile for a tool the release doesn't pin; the dependency age
  gate and the same fast lane; the resolved lockfile fits upstream's own as above; and
  the strip rules applied to upstream's source as text leave out what the evaluation
  said. The key and push token exist only in the final sign-and-push step. `alerts`
  only touches issues. The evaluator signs its commits with its own key, and
  self-update accepts that key only for commits that move `pin.json` forward to a real
  upstream release, and only after the Mac has checked them (see Updates to T3
  Blackout itself). The evaluator can't write the first `pin.json` or a channel's
  first pin. Anything else (rules, known hosts, signers, native assets) still needs
  the repository owner's signature. `evaluate --ref <tag>` evaluates one release by
  hand, for a hotfix worth taking now. Another track needs a first pin in a commit the
  owner signs (`bin/t3blackout evaluate --channel stable --baseline <tag> --write`,
  run locally); until then every machine refuses it.
- **Hourly check.** Each machine's updater runs hourly and builds only when the pin
  moved or this repository did (a build is the upstream commit plus the T3 Blackout
  commit that stripped it, so a signed commit here, even one that only changes docs,
  rebuilds the same release with it), so fixes the evaluator pins arrive within the
  hour; the update button builds on demand in between. `bin/t3blackout schedule --day
  daily` (or a weekday, and `--hour`) changes it. "Update everything" on a desktop also
  asks each SSH host's updater to build (rule `server/self-update-requests-host-build`)
  and reports those hosts as "update requested", not updated; the host's server runs
  the new build from its next connection (docs/two-mac-setup.md, "How host updates
  arrive"). If T3 Blackout is closed, the new build is installed right away. If it's
  open, the build waits, and the update button in the sidebar offers a restart into it.
- **Provider CLI updates** (Settings → Providers, rule `provider/updates-minimum-age`)
  are held to the same 3 days only where the installer can enforce it on the whole
  install:
  - **npm and pnpm** install exactly the version the check reported (the newest at
    least 3 days old): npm with `--before` 3 days ago, pnpm with its minimum release
    age and `strict`, so neither takes anything younger.
  - **bun, yarn, Volta and Vite+** can't hold a provider's dependencies to a minimum
    age, so T3 Blackout doesn't update a provider installed with them: Settings says
    so and asks you to update it with npm or pnpm, or its own updater.
  - **Not held back:** a provider installed with its vendor's own installer is updated
    by that updater (a natively installed Claude Code: `claude update`), and a Homebrew
    install by `brew upgrade`. Both install the vendor's or Homebrew's newest build.
    So do the vendors' own updaters you run yourself (`claude update`, `codex update`)
    and the CLIs' auto-updates.
- **ACP Registry agents** install only as npm or PyPI packages (npx, uvx), held to the
  same 3 days (npm `--before`, uv `--exclude-newer`; rule
  `acp-registry/installs-minimum-age`). An agent that ships only a prebuilt binary is
  "not supported in T3 Blackout": binaries are never downloaded, reused from an earlier
  download, or put on the terminal's `PATH` (rule `acp-registry/no-prebuilt-binaries`).
- **Tracks without a pin are refused.** With a `pin.json`, a track it doesn't pin
  (today: preview and stable) isn't built unless you pass `--unpinned`, which then
  builds that track's newest release at least 48 hours old (`T3BLACKOUT_SOAK_HOURS`,
  `--soak-hours`) with none of the evaluator's gates. Without a `pin.json`, every track
  builds that way. `--unpinned` doesn't bypass a pin: a track `pin.json` pins always
  builds its pinned release. `--ref` builds anything.
- **Update button (sidebar, app menu, Settings → About).** "Check for updates" first
  takes any newer signed `pin.json` (and code) from the repository's `main` through
  self-update, then fetches upstream's tags. If there's a newer release, the button shows
  it with upstream's commit titles as release notes. Clicking it builds exactly the
  commit the check offered (`update --expect-sha`): if the approved release has moved
  since, it refuses and asks you to check again. The progress ring tracks the build.
  When it's done, click again to restart into it; the restart installs only the build
  the app announced (`apply --expect-sha --expect-blackout`), so a different one staged
  meanwhile stays staged. A waiting build made by another T3 Blackout commit than
  this clone's (say, an older one, before a self-update whose rebuild failed) is
  offered as a download, which rebuilds it, not as a restart. Nothing else installs
  it either: the app's restart leaves it staged ("update not applied: the staged
  build was made with T3 Blackout …; run `t3blackout update` to rebuild it"), and
  `launch` opens the installed build instead, logging "staged build not installed".
  The next update rebuilds it with this clone's rules.
- **Only update checks you start touch the network.** The app's automatic checks for a
  T3 Blackout update (at startup and every 4 minutes) only read local state: a build
  waiting from the scheduled run, or a newer tag the scheduled run already fetched.
  The automatic provider CLI version checks are the exception (What you give up).
- **Update track.** The app shows upstream's real version, e.g.
  `0.1.1-nightly.20261017.3238`. Settings → Update track doesn't switch tracks: it
  explains that each track builds the release `pin.json` pins and that
  `t3blackout update --channel <track>` on each Mac moves it, which is refused for a
  track `pin.json` doesn't pin.
- **A release a strict rule can't handle isn't installed.** The evaluator pins only a
  release its strict rules apply to, so a machine following the pin doesn't meet one;
  if a strict rule fails anyway, the update stops and the installed build stays.
  On a track built without a pin (no `pin.json`, or `--unpinned` on a track it doesn't
  pin), the update runs the rules first and falls back to the newest release (up to 5
  back) that still works; if none does, it stays on the installed build and says why.
- **Review before you restart.** While a build waits, the version stamp's card offers
  **Preview** and **What changed**.
  - **Preview** (`bin/t3blackout preview`, `lib/preview.mjs`) opens the waiting build in a
    Chrome window of its own (Chrome or Chromium must be installed; Safari can't),
    running against a copy of your profile: your projects, threads and settings,
    without your secrets. On macOS its server runs in a sandbox (`sandbox-exec`).
    - It can reach localhost and nothing else, not even DNS.
    - It can write only to its copy. It reads your projects' files but can't change them.
    - The agent CLIs show as installed but have no credentials, so nothing can be sent.
    - Closing the window stops it and deletes the copy.
    - If it can't open, the app says why (no Chrome, the CLI's error, an early exit),
      and after 3 minutes that it's still starting.
    - On Linux, which has no sandbox for it yet, the preview gets an empty profile instead.
  - **`bin/t3blackout review`** gathers the build's report and every upstream commit
    since your build, for an agent to read. Ask it:
    - what changed that you'd notice, and where to look for it in the preview;
    - for each feature left out, whether to re-hook it, retire it or wait.
  - If you decide to change a rule, the same agent edits it, checks it, and rebuilds the
    waiting build.
- **A build with features left out** installs like any other. The notification and the
  update's release notes name what was left out, and the version stamp shows a hollow
  dot until a build has everything again.
- **A failed build** leaves the installed app alone. You get a notification with the
  reason, and the full log is in `state/t3blackout.log` (readable only by you). A
  build that's verified but can't be swapped in stays staged for the next run.

### Separate build account

Every build runs upstream's build scripts and the install scripts of the dependencies
the desktop build needs. That's code you haven't read, running unattended. So
`install.sh` creates an unprivileged account, `_t3blackout`, and the fetch, build and
smoke test run as it:

- **Where its files live:** `/private/var/t3blackout-build` on macOS,
  `/var/lib/t3blackout-build` on Linux. That holds the upstream mirror, the build
  checkout and its own pnpm store. `install.sh` makes your home private
  (`chmod go-rwx`) if it could read it, so it can't read your home folder, SSH keys or
  credentials. Each build gets a private `TMPDIR` inside it.
- **How it's started:** through one sudo rule, `<you> ALL=(_t3blackout) NOPASSWD: ALL`.
  The rule only works in one direction: you can act as the build account, and it can't
  act as you or as root.
- **What it hands back:** an unsigned app. You scan it again, sign it and install it.
- **What it doesn't protect:** the app itself still runs as you, so this guards the build,
  not what upstream's code does at runtime.
- **Without sudo:** builds run as you, and `status` says so.

### Updates to T3 Blackout itself

Before building, every update fast-forwards this clone to origin's `main`, under the
update lock. It only does so if every new commit carries exactly one SSH signature from
a principal listed in `.allowed_signers`, checked against that file as it is on the
machine, not as the incoming commits would have it. GPG and X.509 signatures are
refused outright. It reads the fetched commit once and fast-forwards to exactly that
commit, so another fetch can't swap in commits nobody verified. That's how a rule fix
pushed from one machine reaches the others, without letting someone who gets into the
GitHub account push code that every machine runs.

- **The trusted keys** are the repository owner's SSH commit-signing key and the
  evaluator's key (`t3blackout-evaluator`), held as a GitHub Actions secret. An
  evaluator-signed commit is accepted only if it has one parent, changes `pin.json` and
  nothing else, follows an existing pin (it can't write the first one, or a channel's
  first), leaves a valid pin of canonical release tags, moves no channel back
  (`lib/pin.mjs`), and approves device tools or their lockfiles only alongside a
  forward move. Then the machine works out its gates again itself, in order, each
  commit against the pin before it (the one this clone already trusts):
  - each channel it moves names the commit its tag points at upstream (`git
    ls-remote`, annotated tags resolved);
  - every device tool it approves is pinned by the release it moves to and, with its
    reviewed lockfile and dependency closure, passes review here;
  - every dependency version the new release adds over the trusted pin's release is at
    least 3 days old, keeps its bytes and has the registry's integrity, unless the fast
    lane, worked out from the trusted release's own lockfile, the owner's overrides,
    OSV and npm, waives it as a security fix.

  The trusted pin's release is fetched by its commit, not its tag, so upstream moving
  or deleting that old tag later doesn't hold anything; only the releases being moved
  to are checked by tag.

  A dependency that's too young **holds** the update: `state/t3blackout.log` says
  "self-update held" and names it, there's no notification, the update continues on
  the pin this clone already has, and the next run tries again. Nothing later on
  `main`, owner commits included, is taken until it has aged, unless the owner
  replaces the pin (next bullet). Checking evaluator commits needs github.com (HTTPS)
  and the npm registry, and OSV.dev for the fast lane, plus Electron's and Node.js's
  release lists for a young Electron; without github.com, npm or those lists,
  self-update skips that run, and without OSV a young dependency is held rather than
  waived. A leaked evaluator key can at most pin a real, newer upstream release whose
  new dependencies have aged or are accepted by the machine's own security fast lane
  ("Security fast lane" above; for Electron that includes any same-major release that
  changes Chromium, however new), which every machine still strips, typechecks, scans
  and smoke-tests itself.
- **The owner can always override the evaluator.** A later commit the owner signs that
  rewrites `pin.json` vouches for the evaluator commits before it, so it unblocks any
  pin that's held or refused by those gates. The shape rules above are the exception:
  an evaluator commit that breaks one (a merge, a change outside `pin.json`, an
  invalid or backward pin, a first pin, approvals without a forward move) is refused
  outright, and self-update stays refused until that commit is no longer on `main`.
- **Fetching:** origin must be one github.com repository URL (`https://github.com/…`,
  `git@github.com:…` or `ssh://git@github.com/…`). Whatever its form, it's fetched
  over HTTPS (with the GitHub CLI's stored login when there is one), so it never waits
  on an SSH-agent prompt. Its URL is read as the clone's own `.git/config` writes it,
  so no `insteadOf` rule, global, local or in the environment, can change which
  repository is fetched. Nothing else is fetched: an origin that isn't a github.com
  URL, an SSH host alias such as `git@github-work:…` included, makes self-update skip
  every run ("couldn't fetch (origin isn't a github.com repository URL, …)"). The
  setup guide's HTTPS clone is right; to push through an SSH alias, put it in the push
  URL (below). Every git call against github.com, for this repository or upstream
  (`ls-remote`, clones, fetches and the blob fetches a partial clone makes later),
  goes through `lib/git.mjs`:
  - HTTPS only (`GIT_ALLOW_PROTOCOL`, which a repository's own `protocol.*.allow`
    can't widen);
  - the machine's global and system git configuration ignored (`url.*.insteadOf`
    rewrites, credential helpers, `core.sshCommand`, proxies, `includeIf`), and
    every `GIT_*` variable dropped;
  - nothing that can prompt;
  - a deadline on each call: listing 1 minute, reading the mirror 5, fetching 15,
    cloning 30.
- **The clone's own git configuration** can't be switched off the same way, so it's
  checked before each fetch. Its `.git/config` (and anything it includes) must not set
  URL rewrites (`url.*.insteadOf`), `http.*`, `credential.*`, proxies, transport
  programs (`core.sshCommand`, `remote.*.uploadpack`, …), `protocol.*.allow` or a
  partial clone, or self-update is skipped every run: `state/t3blackout.log` says
  "self-update skipped: couldn't fetch (refusing to reach https://github.com/… from …:
  its own git configuration sets …)". A plain `git clone` sets none of these; remove
  what it names (`git config --unset-all <key>` in the clone). To push from a clone
  over SSH, give it a push URL (`git remote set-url --push origin
  git@github.com:<owner>/t3blackout.git`, or your SSH host alias in place of
  `github.com`) or an SSH `origin` on github.com itself; a `pushInsteadOf` rule in the
  clone counts as a rewrite. Rewrites in your global `~/.gitconfig` are ignored, not
  refused. The upstream mirror gets the same check, and its `origin` must be exactly
  upstream and its only remote.
- **The upstream mirror belongs to the build account** (when there is one). Only that
  account fetches into it or reads file contents from it. Every other read of the
  mirror (tags, versions, commit titles: what `poll` and the app's update checks read
  as you) runs with lazy fetching off (`git --no-lazy-fetch`), so a mirror the build
  account controls can't make your account fetch from it or start a transport program.
  That option needs **git 2.45 or later**; with an older git every read of the mirror
  fails (Install).
- **Refusals:** unsigned or rewritten history is refused, and you get a notification.

### Checks on every change

- **`ci.yml`** (every push and pull request): the repo's tests, `bash -n`/`sh -n` and
  shellcheck on the scripts and the SSH runner as the remote shell gets it, actionlint,
  every action pinned to a full commit SHA (each workflow is parsed as YAML; one the
  check can't read fails it), `pin.json` and `lib/overrides.json` valid, `pin-check`
  (every pinned tag still names its commit upstream), and the strip rules applied to
  the pinned commit.
- **`build.yml`** (changes under `bin/`, `lib/`, `test/stripped/` or to `pin.json`):
  builds each pinned channel the change affects with `check --build` (typecheck,
  package, staged-install guard, forbidden-endpoint scans, smoke test), runs the tests
  in `test/stripped/` inside the stripped checkout, and syntax-checks the SSH runner as
  upstream's `tunnel.ts` renders it. A commit that changes only `pin.json` builds the
  channels it moved (all of them if device tools changed); any other change builds
  every pinned channel. Read-only token, no secrets. The evaluator's own pin commits
  don't start it, or `ci.yml`: they're pushed with the workflow's token, and GitHub
  starts no workflows for those pushes. Its evaluate job already built that release.
- **`evaluate.yml`** (hourly): the evaluator, commit and alert jobs above.

The jobs that build (`build.yml`, and `evaluate.yml`'s evaluate job) first install
`libsecret-1-dev` and `imagemagick` with apt: upstream's Linux packager checks for
them before it starts, and the runner image doesn't have them.

Every CI result is advisory: each Mac checks and builds a pin itself before
installing it.

## Install

Each machine builds its own copy of the release in `pin.json`.

```sh
git clone https://github.com/bmjcoding/t3blackout.git && cd t3blackout
./install.sh                 # the desktop app (--role ui)
./install.sh --role host     # an always-on Mac agents run on, reached over SSH (docs/two-mac-setup.md)
./install.sh --role both     # the desktop app plus a local standby lane
```

Any path works, except that a `--role host` clone must be outside `~/Documents`,
`~/Desktop` and `~/Downloads` (macOS blocks the host's LaunchDaemon from those).

Run `install.sh` as yourself, not with sudo; it refuses root and asks for your
password when it needs it. It's safe to rerun. It installs what's missing (and refuses
a Node without the Oct 2026 security fixes), sets up the build account (sudo asks for
your password once), saves the role and install locations in `state/install.json`
(`bin/t3blackout configure`), builds, verifies, smoke-tests and installs the app, then
schedules the update check: hourly, building only when the pin or this repository
moved, and whenever a server on the machine asks for an update
(`T3BLACKOUT_UPDATE_DAY=daily|monday...` and `T3BLACKOUT_UPDATE_HOUR` change it). For
`host` and `both`, add each agent account afterwards with `sudo
scripts/add-agent-account.sh <name> [--loopback-only] [--key FILE]`; the full two-Mac
walkthrough is docs/two-mac-setup.md.

- **`host` and `both` need an admin account** (the app goes in `/Applications`, where
  agent accounts find it) and the default locations: they refuse a
  `T3BLACKOUT_APPS` other than `/Applications` and a `T3BLACKOUT_UPDATE_REQUESTS`
  other than `/Users/Shared/t3blackout/update-requests`, because agent accounts,
  which never see your settings, use those paths.
- **Changing the role:** rerun `./install.sh --role <new role>`. `bin/t3blackout
  configure --role` only saves the role; the scheduled job (a LaunchAgent for `ui` and
  `both`, a LaunchDaemon for `host`) changes with the next `bin/t3blackout schedule`,
  which `install.sh` runs.
- **Locations** (`T3BLACKOUT_HOME`, `T3BLACKOUT_APPS`, `T3BLACKOUT_UPDATE_REQUESTS`,
  `XDG_DATA_HOME`, `XDG_CONFIG_HOME`): an empty value counts as unset. A relative
  path, or a `T3BLACKOUT_HOME` that is this clone or inside it (symlinks and letter
  case don't hide it), stops every command, `configure` included, which says why;
  set it to an absolute path outside the clone, or unset it, and rerun `install.sh`.
- **`state/`** is readable only by you (mode 700): the log, the records, the lock and
  `state/install.json`. If `install.json` is there but unreadable or invalid, every
  command stops and says so; `bin/t3blackout configure --role ui|host|both` writes a
  new one.
- **git 2.45 or later** (for `git --no-lazy-fetch`; Updates to T3 Blackout itself).
  `install.sh` checks the git on its `PATH`. On macOS it installs Homebrew's when
  that one is missing or older, and stops if an older one still comes first ("git
  2.45 or newer is required (found …). Run: brew install git, and put … first on
  PATH"); on Linux it stops and says how to get a newer one.

**macOS** (Apple silicon or Intel):

- **You need:** the Xcode Command Line Tools, Homebrew on your `PATH` (the scheduled
  update keeps the `PATH` `install.sh` ran with, and needs `node`, `npm` and `git` on
  it), and the 1Password app with **Settings → Developer → Integrate with 1Password
  CLI** turned on. For Preview and the build reports' screenshots, Google Chrome or
  Chromium in `/Applications`; without it, builds install with no screenshots.
- **git:** the Command Line Tools' git is enough if it's 2.45 or later (Command Line
  Tools 26.6 ship 2.50.1). If it's older, `install.sh` runs `brew install git`:
  Homebrew's folder comes before `/usr/bin` on the `PATH` its installer sets up, so
  its git wins.
- **Installs:** with Homebrew, whichever of git, Node and Rust is missing (or, for git
  and Node, too old), and the 1Password CLI; pnpm 12.14.0 from npm tarballs checked
  against pinned SHA-512 digests, with no install scripts.
- **Signing:** sets up the shared signing certificate (see below) from the 1Password
  vault `Personal`, or the one `T3BLACKOUT_VAULT` names. Run it from Terminal so the
  1Password prompt names Terminal.
- **App:** `/Applications/T3 Blackout.app` when you're an admin, so every account on the
  Mac (the agent accounts SSH starts servers in) runs the same build; otherwise
  `~/Applications`. Updated by a LaunchAgent that runs while you're logged in (`ui`,
  `both`), or for `host` by a LaunchDaemon that runs as you with nobody logged in.

**Linux** (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL; x64 or arm64; `--role ui` only):

- **System packages:** build tools, libsecret, pkg-config, ImageMagick and Python,
  with pacman, apt or dnf, and git if there's none. **Its git must be 2.45 or later.**
  Arch, Fedora 44, Rocky 9, Debian 13 and Ubuntu 26.04 ship one; Ubuntu 24.04 (2.43)
  and Debian 12 (2.39) don't, so there `install.sh` stops after the system packages
  and Node ("… ships an older one; install a newer git (e.g. Ubuntu: the git-core
  PPA), then rerun ./install.sh"). Install a newer git, or move to a newer release,
  and rerun it.
- **Node 24:** the official tarball, checksum-verified, into your home directory, so the
  distro's version doesn't matter. The build account gets its own copy of Node, pinned
  pnpm and Rust 1.99.1 (from pinned, checksum-verified rustup 1.29.2) in its own home.
- **Ubuntu 23.10+:** adds a one-line AppArmor profile so Electron's own sandbox can
  start under Ubuntu's user-namespace restriction.
- **Signing:** none. Linux keyrings don't tie access to an app's signature.
- **App:** extracted to `~/.local/share/t3blackout/app`, so it doesn't need FUSE. It
  appears in your launcher as "T3 Blackout" and is updated by a systemd user timer,
  which runs while your user manager does: while you're logged in, or always after
  `loginctl enable-linger`.

## Commands

```sh
bin/t3blackout update                      # the pinned release on your track → strip → build → verify → smoke → install
bin/t3blackout update --channel nightly    # a given track: nightly, preview or stable (refused unless pin.json pins it)
bin/t3blackout update --channel stable --unpinned   # a track pin.json doesn't pin: its newest release 48h old, no evaluator gates
bin/t3blackout update --ref <tag-or-sha>   # build anything
bin/t3blackout update --expect-sha <sha>   # build only if the approved release is still <sha> (the app's download)
bin/t3blackout poll                        # is there a newer release? (takes a newer signed pin first)
bin/t3blackout poll --offline              # the same from local state only (the app's automatic checks)
bin/t3blackout check                       # dry-run the rules against the pinned release (--ref: any), no build
bin/t3blackout check --build               # also build, scan and smoke-test it, without installing
bin/t3blackout drift                       # open what upstream changed under the features a build left out
bin/t3blackout preview                     # try the waiting build in a sandboxed window
bin/t3blackout preview --installed         # the same for the build you run
bin/t3blackout review                      # gather the waiting build's report and upstream commits for an agent
bin/t3blackout smoke                       # re-run the zero-egress smoke test on the last build
bin/t3blackout launch                      # open the app, installing a waiting build first if this commit made it
bin/t3blackout status                      # installed build, pin and its gates, schedule, role, build account, signing
bin/t3blackout rollback                    # swap back to the previously installed build
bin/t3blackout schedule                    # hourly (the default)
bin/t3blackout schedule --day monday --hour 4   # or --day daily
bin/t3blackout unschedule
bin/t3blackout configure --role host       # save the role (ui, host or both) and install locations; install.sh runs it
                                           # (run schedule afterwards, or rerun install.sh, to move the scheduled job too)
bin/t3blackout signing status              # macOS; also: signing adopt, signing import, signing init (each takes --vault V)
```

`apply` is what the app runs to install a staged build once it has quit. CI runs these
(see Updates):

```sh
bin/t3blackout evaluate --channel nightly --build --write --report FILE --resolved DIR   # pick and pin the newest release that passes
                       [--stage-from DIR]  # reuse the last run's stage records (DIR: its --resolved) instead of rebuilding the pin
bin/t3blackout pin-check                   # every tag pin.json names still points at its commit upstream
bin/t3blackout pin-check --channel nightly --candidate FILE --resolved DIR --result FILE   # re-derive a candidate's gates before signing
bin/t3blackout advisories --channel nightly --resolved DIR --out FILE                      # advisories against the pin on main
bin/t3blackout releases --channel nightly [--out FILE]                                     # upstream releases newer than main's pin
```

For a device tool version you reviewed by hand (listed in `lib/known-device-tools.txt`):

```sh
bin/t3blackout device-tool-lock --tool name@version   # resolve, check and keep its dependency lockfile in pin.json; commit it, signed
```

The app keeps its state in `~/.t3blackout` and never touches the official app's `~/.t3`.
It also has its own:

- bundle ID,
- Chromium profile,
- Keychain Safe Storage item,
- runtime name.

So both apps can be installed side by side.

## Command path

Every `bin/t3blackout` command also writes `~/.t3blackout/bin/t3blackout`, so agents
and the app can run this clone's CLI by a fixed path. It's written through a rename,
so a link already there is replaced, never written through, and it's skipped while a
location is refused (Install) or when that path is the CLI itself.

## Signing and Keychain prompts (macOS)

T3 Blackout keeps its encryption key ("t3blackout Safe Storage") in your Keychain. macOS
lets the app read it without asking only when both of these match what you approved:

- **The app's code requirement.** This stays the same for any build signed with the
  same certificate.
- **Its "partition".** For an Apple-issued certificate this is your team ID, which stays
  the same across builds. For anything else it's that build's exact hash, so every
  update asks again.

So builds are signed with an **Apple Development certificate**. It's free with any
Apple ID, and only the first Mac needs Xcode:

1. In Xcode: Settings → Accounts → add your Apple ID → select "(Personal Team)" →
   Manage Certificates → + → Apple Development.
2. Run `bin/t3blackout signing adopt --vault Personal`. It exports the certificate
   (macOS asks you to allow it), adds Apple's intermediate certificate, stores both in
   1Password (item "T3 Blackout code signing", in the vault `--vault` names) and
   installs them into `state/signing.keychain-db`. That keychain is separate from your
   login keychain, and its random password is in `state/signing.keychain-pass` (mode
   600).
3. Other Macs: `install.sh` (or `bin/t3blackout signing import --vault Personal`)
   fetches it from 1Password.
4. After the first build signed with it, click **Always Allow** on both prompts (one for
   the app, one for its helper). That's once per Mac.

The certificate expires after a year: renew it in Xcode and run `signing adopt --vault
Personal` again. Without one, `signing init` creates a self-signed fallback, which works
but prompts after every update. Signing never contacts Apple, because no timestamp is
requested.

`signing adopt`, `import` and `init` take the vault only from `--vault`. Without it
they name no vault, and `op` uses its own default: it creates the item in your
built-in vault (Personal, Private or Employee). `T3BLACKOUT_VAULT` is read only by
`install.sh` (default `Personal`), which passes it on as `--vault`.

## What you give up

- **Remote environments over SSH only; no T3 Connect.** The UI's CSP limits it to
  loopback, which SSH environments use (the remote server's port is forwarded to a local
  one; docs/two-mac-setup.md). Relay and mobile pairing through T3's servers are gone.
- **Remote images in chat don't render.** GitHub images still work (the server fetches
  them). Link favicons show a generic icon.
- **Updates take a few minutes.** Each one is a local build, not a download.
- **Provider CLI updates come at least 3 days after release,** where the installer can
  hold them (Updates). To offer Update on a provider, each server checks automatically
  for the newest version at least 3 days old of each CLI it has installed: it asks
  npm's registry (Muse: Meta's release channel), never T3. Muse's channel gives no
  publish date, so a Muse version is reported only once that server has seen it on the
  channel for 3 days (recorded in
  `~/.t3blackout/userdata/blackout-muse-first-seen.json` in each account that runs a
  server; a version the channel moves to starts its own wait). These checks are an
  accepted exception to stripping outbound calls, kept so Update all works; they're on
  by default. Turn off **Settings → Maintenance → Provider update checks** to stop
  them; the bundled model list stays bundled either way.
- **Agent previews can't load outside resources.** Agent-written HTML and MCP apps get
  the loopback-only CSP too, so anything they pull from a CDN or an external API fails.
- **The app's windows reach nothing but loopback, WebRTC included** (How it works,
  Content-Security-Policy): no calls or peer connections to other machines from the
  app itself, with one exception, EAS Simulator's video, which needs UDP (Device
  streams). Local and SSH simulators and emulators stream through T3's server and
  aren't affected. The preview browser can't use WebRTC over UDP either (TCP still
  works).
- **The model list is the one bundled in each build.** Pinned rebuilds keep it at most
  as current as the pin.
- **Cost estimates keep working.** `update` downloads LiteLLM's pricing table (pinned
  to a commit) and seeds the app's cache. On a Mac with agent accounts it also
  publishes the table in `/Users/Shared/t3blackout`; the account script seeds it and
  each agent account's server copies newer ones on start. The app never fetches it.

## When an update fails

`state/t3blackout.log` says why, and you get a desktop notification. The installed build
is untouched, and the update button offers the release again so you can retry. The usual
causes are:

- **A strict rule no longer matches.** Upstream changed that code. `bin/t3blackout
  drift` shows how; update the anchor in `lib/rules.mjs` (`bin/t3blackout check`
  iterates quickly). Feature rules never fail an update; they're left out instead.
- **The smoke test saw outbound traffic.** Upstream added a new network call. The host
  is in the error. Add a rule that disables it.
- **The typecheck failed outside a feature.** Upstream changed an interface a strict
  file uses, such as the updater interface `lib/files/BlackoutUpdater.ts` implements.
  Update that file to match.
- **The packaged server reached out while it was photographed.** Same cause as above,
  seen in the packaged app (Smoke test). Nothing was installed.
- **A device tool has no reviewed lockfile, or an unlisted install script.** The error
  says which (`device-tool-lock`, `lib/native-assets.json`; How it works).
- **"The staged install in … isn't what was installed from its checked lockfile"**:
  something changed, removed or added files in the packager's staged install after
  the guard installed it, beyond what packaging is known to add (How it works, Build
  verification). If upstream changed how it packages, look at the files named and
  update `stageChanges` in `lib/stage-install.mjs`. "t3blackout refused … in the
  packager's stage" means upstream runs a new package-manager command there.
- **New stock-T3 wording upstream** (`stock/no-stock-guidance`): add a rule that
  replaces it, before `brand/name` in `lib/rules.mjs`.
- **Self-update was refused.** origin's `main` has a commit not signed by a key in
  `.allowed_signers`, or an evaluator pin the machine couldn't verify. The log names it.
- **Self-update was held** (only in the log): an evaluator pin adds a dependency under
  3 days old. The update runs on the pin you have, and the next run tries again.
- **Self-update was skipped** (only in the log): "couldn't fetch (refusing to reach …:
  its own git configuration sets …)" means the clone's `.git/config` sets something
  that decides how git connects (Updates to T3 Blackout itself); remove it. "couldn't
  fetch (origin isn't a github.com repository URL, …)" means origin is something else,
  an SSH host alias say: `git remote set-url origin
  https://github.com/<owner>/t3blackout.git` (keep an alias in the push URL). Other
  "couldn't …" lines mean github.com or the npm registry wasn't reachable that run.
- **"Update not applied: the staged build was made with T3 Blackout …"** (or
  "staged build not installed" in the log after `launch`): the waiting build was made
  by another T3 Blackout commit than this clone's. The installed build keeps running;
  `bin/t3blackout update` (or the next hourly run) rebuilds it with this clone's rules.
- **Every read of the upstream mirror fails** with "… in the upstream mirror failed:
  unknown option: --no-lazy-fetch": the `git` on this machine's `PATH` is older than
  2.45. Install a newer one (Install), then rerun the update.
- **An install or rollback was cut off.** `status` shows an `interrupted:` line; the
  next update or rollback finishes it, or puts the previous build back, before it does
  anything else. A journal (`state/activation.json`) that names app folders this
  install doesn't use (say, after `T3BLACKOUT_APPS` changed in between), says its build
  went in with nothing installed, or is damaged stops update and rollback until you
  compare the app folders with `state/current.json` by hand and remove it; the error
  says so.

## When the app won't start

The app's startup error suggests these Terminal commands and links here:

- **Go back a build:** `~/.t3blackout/bin/t3blackout rollback` swaps in the build that
  was installed before this one. When the startup dialog offers it, its **Copy
  rollback command** button copies that line.
- **Rebuild the release you're on:** quit the app, then `~/.t3blackout/bin/t3blackout
  update --force`, as the startup error says. Plain `update` builds only when there's
  a newer pin or a newer T3 Blackout commit. If the app is still running, the build
  waits; `bin/t3blackout launch` installs it and opens the app.
- `state/t3blackout.log` in the clone has the last update's log.

## Planned

- **The T3 phone app,** built from upstream's mobile app with the same rules, pairing
  directly to a host over Tailscale.
- **Runtime egress enforcement** through OpenShell or similar, outside this repo.

## Limits, stated plainly

- **Network isn't enforced at runtime.** T3's own code is checked for phone-homes on
  every update, within the limits below. The agent CLIs talk to their providers
  directly. Their own analytics are switched off where they offer a switch, and what
  the agents reach is up to their sandboxes or yours. Two have no switch:
  - **Cursor:** its SDK runs inside T3's server and reports usage events to Cursor's API,
    the same host it needs for everything else.
  - **Antigravity:** telemetry is controlled only by your Google account's settings.
- **The smoke test covers startup only.** The built server's first 20 seconds with an
  empty profile, Node networking only (and the known network clients it starts). It
  runs the build's `apps/server` output under the build's Node, not the packaged
  Electron app. It doesn't exercise the desktop's main process, a stored
  configuration, a signed-in provider, anything you do in the app, or anything that
  starts later. The tripwire can't see native code, interpreters such as python or
  perl, a network client copied (not linked) under another name, or any other program
  that opens its own sockets. The packaged server runs under the tripwire only while
  an update takes screenshots, which needs Chrome: on a Mac without it (a host,
  usually) the packaged server isn't booted before it's installed, and CI never boots
  it.
- **The tripwire reads shell lines heuristically.** It isn't a full shell parser: it
  follows the forms it knows and refuses (logs as `(unreadable)`, failing the smoke
  test) a line it can't read, so a new upstream shell line can hold an update until
  the tripwire learns it. It doesn't read a script file run without `-c`, or a login
  shell's startup files.
- **The scans read literal text.** The host scan and the forbidden-string scan can't
  see a name assembled at runtime (for `${region}.example.org` the host scan checks
  only the domain written after the expression) or content inside compressed files.
- **Not every provider update is age-gated.** The vendors' own updaters (`claude
  update`, `codex update`, the CLIs' auto-updates when you run a CLI yourself) install
  their vendors' newest builds, and so does Settings' Update for a provider installed
  with its vendor's installer (a native Claude Code runs `claude update`) or with
  Homebrew (`brew upgrade`). Only npm and pnpm installs are held to 3 days; bun, yarn,
  Volta and Vite+ installs aren't updated from Settings at all.
- **The automatic provider version checks stay on** (What you give up): an accepted
  exception, limited to versions at least 3 days old.
- **Device tools:** a fix to a device tool's dependency reaches you only when upstream
  pins a tool version that includes it, since each version's closure is frozen. A tool
  whose native files `lib/native-assets.json` doesn't list for a platform can't be
  installed there.
- **Prebuilt pieces still come from upstream's build:** Electron's runtime and the
  native binaries some npm packages fetch (only the desktop build's packages run
  install scripts). Their versions are pinned by upstream's lockfile; they aren't
  built here. Upstream's managed Codex install downloads a Codex release whose version
  and SHA-256 upstream's source pins.
- **An install script can still run inside the build account.** The staged-install
  shims see package managers started through `PATH`. One the packager starts by its
  absolute path still runs, lifecycle scripts included; the build then refuses the
  result (the staged files no longer match what the guard installed), so nothing is
  installed, but the script has run as the build account. Stopping that needs an OS
  sandbox around the packager.
- **The staged-install check has edges.**
  - The guard's record of what it installed lives in the build's private temp folder,
    where the packager runs, so a deliberately malicious packager could rewrite the
    record along with the files.
  - It checks the stage folders after packaging, not the packed `app.asar` (which the
    forbidden-endpoint scan reads).
  - What node-gyp writes into a native package's `build/` and scratch folders isn't
    byte-checked: it's compiler output, different on every build.
- **The local-source check reads contents only for `file:` folders.** Every local
  source must be a folder or file the pinned commit tracks (How it works, Build
  verification), but only a `file:` folder, which pnpm copies, is checked for files
  the commit doesn't have. A linked workspace folder may hold untracked files (build
  output, the files the strip rules inject), and tracked files' bytes aren't hashed
  against the commit: that rests on the build checking out the pinned commit with
  `--force` and cleaning the checkout first.
- **The fast lane trusts npm's registry metadata, and Electron's and Node.js's release
  lists.** Who published a version, the repository it declares and whether it has
  attestations come from the registry and aren't verified, so a registry that lies
  (stripping attestations from the earlier versions and the candidate alike) passes
  that part. Which Node and Chromium an Electron embeds, and which Node releases were
  security releases, come from releases.electronjs.org and nodejs.org as published.
  The fast lane waives the 3-day wait in two cases, each only for a version from its
  usual publisher (Updates, "Security fast lane"):
  - a version that fixes an advisory open against the pinned release: OSV names a
    fix in the release line of both the vulnerable version and the candidate, the
    candidate is at or past it, and OSV no longer flags the candidate for it;
  - a newer Electron of the same major whose embedded Node crosses a Node.js security
    release, or whose Chromium version differs at all. This case needs no advisory: a
    same-publisher Electron an hour old that moves Chromium is waived.

  Every other gate still applies.
- **Advisory alerts (CI) have two gaps.**
  - A forged stage record that is consistent in every respect but picks other
    versions inside the allowed ranges passes: only resolving again could tell, and
    the alert job doesn't run npm's resolver.
  - The alert job checks the linux-x64 staged install CI builds. The Macs install a
    darwin one, whose native packages differ (fff's binaries), so those aren't
    checked for advisories. Each Mac still checks its own staged install when it
    builds.
- **Self-update needs GitHub to still serve the trusted pin's commit.** It's fetched by
  commit id. If upstream's history ever loses it there, self-update skips every run
  that brings an evaluator pin, until the owner signs a commit that rewrites
  `pin.json`.
- **Electron and WebRTC.** The app sets its refusing proxy asynchronously at startup
  (in effect 27–32 ms after Electron is ready, measured), long before an agent's
  preview or an MCP app can load. Whether such a frame's `<link rel=dns-prefetch>`
  makes Chromium resolve a name locally hasn't been measured (a CSP doesn't cover it).
  The preview browser keeps WebRTC over TCP. The app's own page (not an agent's
  preview or an MCP app) can make WebRTC connections over UDP through its hidden
  device window; upstream uses that only for EAS Simulator. **EAS Simulator video
  needs UDP:** TURN over TCP or TLS isn't available (that window's TCP goes to the
  refusing proxy like the rest of the app's session), so on a network that blocks UDP,
  EAS devices show no video. Allowing it would mean letting the whole session,
  untrusted frames included, reach those relays.
- **The update lock's handoff** to the rerun after a self-update (on fd 3, named by
  `T3BLACKOUT_LOCK_FD`): on macOS the rerun can check only that the descriptor it's
  handed is the lock file and that the lock is held, not that this descriptor holds it
  (only a process of yours could forge that). On Linux, if the rerun crashes, a
  process it started that inherited the descriptor holds the lock until it exits.
- **Two-Mac setup:**
  - The host's key-only SSH (macOS Remote Login) is reachable from your local
    network, not just over Tailscale; only agent accounts can log in there, with an
    authorized key.
  - After an unplanned restart of an encrypted host on macOS 26 or later, the same
    port offers macOS's own FileVault unlock, which takes a password for any account
    that can unlock the disk and ignores the key-only and agent-only settings
    (docs/two-mac-setup.md, 3.1).
  - The account script's privileged steps, the standby lane's sshd running as root
    with PAM, signing from the host's LaunchDaemon and swapping `/Applications/T3
    Blackout.app` from a background job were verified with stubs, scratch configs and
    unprivileged runs, not end to end on real Macs; the checklist in
    docs/two-mac-setup.md confirms them on yours. More in that guide's "What this
    doesn't protect".
  - Device streaming was measured in Electron against test streams, locally and
    through a forwarded loopback port, not with real simulators in an agent account
    over real SSH. Whether such an account must also be logged in at the host's
    screen to boot an iOS Simulator is what the check in docs/two-mac-setup.md, 5.3,
    tells you.
- **CI is advisory; the Macs are the authority.** A CI result only proposes a pin.
  Each Mac re-derives the gates and builds, scans and smoke-tests the release itself;
  a check CI skipped or got wrong is caught there, or the update is held.
- **Unsigned upstream, signed locally.** Both apps register the `t3code://` URL scheme,
  so with the official app installed the OS picks one for deep links.
- **Linux testing so far is in containers.** Ubuntu 24.04, Rocky 9 and Fedora 44 ran on
  arm64; Arch ran on x86-64 under emulation as the stand-in for Omarchy. Each went from a
  bare image through install, build, scan, smoke test and install, before git 2.45
  became a requirement: with its own git (2.43), Ubuntu 24.04 now stops in
  `install.sh` until a newer git is installed (Install). Not yet exercised on real
  hardware:
  - opening the app,
  - the systemd timer firing (the unit files pass `systemd-analyze verify`),
  - Ubuntu's AppArmor profile,
  - real RHEL's `subscription-manager` step.
- **Upstream trust.** You're still running upstream's code and its npm dependency tree.
  This removes their telemetry; it doesn't audit everything else. What limits the damage:
  - Dependency install scripts run only for the packages the desktop build needs, and
    every install runs from a lockfile that was checked first (origin, integrity,
    age). Device tools install with no install scripts at all.
  - New dependency versions wait 3 days (unless a vetted security fix), and builds run
    as the separate build account.
  - The app you run is still upstream's code, running as you.
