# T3 Blackout

Builds [T3 Code](https://github.com/pingdotgg/t3code) from upstream source with every
phone-home to T3 and third-party analytics removed, on macOS and Linux. It rebuilds daily
from the newest upstream release, and on demand from the app's update button.

Runtime network enforcement is deliberately not part of this. Sandbox the agents with
your own tooling (e.g. [OpenShell](https://docs.nvidia.com/openshell/about/how-it-works.md));
Codex's and Claude Code's own sandboxes work normally.

## How it works

1. **Strip rules** (`lib/rules.mjs`). Small, anchored source edits applied to each
   upstream checkout. They remove:
   - PostHog analytics and OTLP export
   - T3 Connect, Clerk and the relay
   - the model-manifest and LiteLLM fetches
   - npm version polling and Google favicon lookups
   - the Electron auto-updater (replaced; see Updates)

   They also give the app its own name, bundle ID and data directory. Each rule states
   how many times its anchor must match; if upstream moves the code, the update
   **aborts** and the installed build stays.
2. **Boot environment** (`lib/files/boot-env.cjs`). This runs first in the app. It
   switches T3's telemetry and updater off a second time, and Claude Code's telemetry,
   error reporting and other non-essential traffic for every CLI the app starts. It also
   points the app at `~/.t3blackout`.
3. **Content-Security-Policy.** The UI can only talk to loopback, so remote images, CDN
   icons and anything upstream adds to the page fail into their existing fallbacks.
4. **Build verification.** The desktop app is typechecked, so the injected updater still
   matches upstream's interfaces. The build output, including the packaged app, is
   scanned for known telemetry endpoints and keys.
5. **Smoke test** (`lib/smoke.mjs`). The new server boots with a network tripwire
   preloaded (`lib/files/tripwire.cjs`), an empty `HOME` (no harness credentials) and a
   minimal `PATH`.
   - **What it catches:** the tripwire blocks and records every non-loopback connection
     and DNS lookup from Node.
   - **Pass condition:** the server must answer with the CSP in place and make **zero**
     attempts in 20 s.
   - **Control:** unstripped upstream trips it within seconds (PostHog, GitHub).

   A new phone-home added upstream fails the update here, before any rule knows about
   it.

## Updates

Every update is a full rebuild from upstream source through the steps above. Nothing
prebuilt is ever downloaded.

- **Daily, at 04:00.** It builds the newest release on your update track. If T3 Blackout
  is closed, the new build is installed right away. If it's open, the build waits, and the
  update button in the sidebar offers a restart into it.
- **Update button (sidebar, app menu, Settings → About).** "Check for updates" fetches
  upstream's tags. If there's a newer release, the button shows it with upstream's commit
  titles as release notes. Clicking it builds the release; the progress ring tracks the
  build. When the build is done, click again to restart into it.
- **Only checks you start touch the network.** The app's automatic checks (at startup
  and every 4 minutes) only read local state: a build waiting from the daily run, or a
  newer tag the daily run already fetched.
- **Update track.** Settings → Update track (Nightly or Stable) applies to both the
  button and the daily run. The app shows upstream's real version, e.g.
  `0.1.1-nightly.20261017.3238`. Nightly builds use upstream's nightly icon.
- **A failed build** leaves the installed app alone. You get a notification with the
  reason, and the full log is in `state/t3blackout.log`.

## Install

Each machine builds its own copy from the same upstream tag.

```sh
gh repo clone bmjcoding/t3blackout && cd t3blackout   # any path works
./install.sh
```

`install.sh` is safe to rerun. It installs what's missing, builds, verifies,
smoke-tests and installs the app, then schedules the daily update at 04:00
(`T3BLACKOUT_UPDATE_HOUR` to change it).

**macOS** (Apple silicon or Intel):

- **You need:** Homebrew, the Xcode Command Line Tools, and the 1Password app with
  **Settings → Developer → Integrate with 1Password CLI** turned on.
- **Installs:** git, node, pnpm, Rust and the 1Password CLI with Homebrew.
- **Signing:** sets up the shared signing certificate (see below). Run it from
  Terminal so the 1Password prompt names Terminal.
- **App:** `~/Applications/T3 Blackout.app`, updated by a launchd agent.

**Linux** (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL; x64 or arm64):

- **System packages:** build tools and libsecret, with pacman, apt or dnf.
- **Into your home directory, so distro versions don't matter:**
  - Node 24: official tarball, checksum-verified.
  - pnpm: in `~/.local`.
  - Rust: via rustup.
- **Ubuntu 23.10+:** adds a one-line AppArmor profile so Electron's own sandbox can
  start under Ubuntu's user-namespace restriction.
- **Signing:** none. Linux keyrings don't tie access to an app's signature.
- **App:** extracted to `~/.local/share/t3blackout/app`, so it doesn't need FUSE. It
  appears in your launcher as "T3 Blackout" and is updated by a systemd user timer.

## Commands

```sh
bin/t3blackout update            # newest release on your track → strip → build → verify → smoke → install
bin/t3blackout update --channel nightly|preview|stable   # or --ref <tag|sha>
bin/t3blackout poll              # is there a newer release? (--offline: don't fetch)
bin/t3blackout check             # dry-run the rules against latest upstream (no build)
bin/t3blackout smoke             # re-run the zero-egress smoke test on the last build
bin/t3blackout launch            # open the app, installing a waiting build first
bin/t3blackout status | rollback
bin/t3blackout schedule --hour 4 | unschedule
bin/t3blackout signing init|import|status --vault Personal   # macOS only
```

The app keeps its state in `~/.t3blackout` and never touches the official app's `~/.t3`.
It also has its own:

- bundle ID,
- Chromium profile,
- Keychain Safe Storage item,
- runtime name.

So both apps can be installed side by side.

## Signing and Keychain prompts (macOS)

macOS ties Keychain "Always Allow" grants to an app's signature. Ad-hoc signatures change
with every build, so each update would ask again. Instead, every build is signed with
**T3 Blackout Local Signing**, a self-signed certificate:

- It was created once and stored in 1Password (Personal vault, "T3 Blackout code signing").
- Each Mac imports it into `state/signing.keychain-db`. That file is separate from your
  login keychain; its random password is in `state/signing.keychain-pass`, mode 600.
- Each Mac trusts it for code signing only.
- After you click "Always Allow" once per Mac, updates don't prompt again.

If signing isn't set up, `update` falls back to ad-hoc signing and logs a warning.
Trusting this certificate doesn't get anything past Gatekeeper. It only makes `codesign`
treat it as a valid identity on that Mac.

## What you give up

- **No remote environments or T3 Connect yet.** The UI's CSP limits it to loopback, so
  connecting to T3 on another machine needs that machine added (see Planned). Relay
  and mobile pairing through T3's servers are gone.
- **Remote images in chat don't render.** GitHub images still work (the server fetches
  them). Link favicons show a generic icon.
- **Updates take a minute or two.** Each one is a local build, not a download.
- **No provider CLI update nudges.** That check talks only to npm and GitHub. Turn it
  back on in Settings if you want it.
- **The model list is the one bundled in each build.** Daily rebuilds keep it at most
  about a day behind upstream.
- **Cost estimates are unaffected.** `update` downloads the LiteLLM pricing table and
  seeds the app's cache; the app never fetches it.

## When an update fails

`state/t3blackout.log` says why, and you get a desktop notification. The installed build
is untouched, and the update button offers the release again so you can retry. The usual
causes are:

- **A rule no longer matches.** Upstream changed that code. Update the anchor in
  `lib/rules.mjs` (`bin/t3blackout check` iterates quickly).
- **The smoke test saw outbound traffic.** Upstream added a new network call. The host
  is in the error. Add a rule that disables it.
- **The desktop typecheck failed.** Upstream changed the updater interface that
  `lib/files/BlackoutUpdater.ts` implements. Update that file to match.

## Planned

- **Peers (machine-to-machine).** A list of your machines' hostnames, compiled into the
  UI's CSP, so remote environments can reach exactly those hosts.
- **Runtime egress enforcement** through OpenShell or similar, outside this repo.

## Limits, stated plainly

- **Network isn't enforced at runtime.** T3's own code is verified silent on every
  update. Harness CLIs (Claude Code, Codex…) talk to their providers directly; Claude
  Code's non-essential traffic is switched off by environment variable, and what the
  agents themselves reach is up to their sandboxes or yours.
- **The smoke test sees Node networking only.** It can't see native code or other
  programs. That's fine for T3's own code, which is JavaScript, but it isn't a
  general egress monitor.
- **Unsigned upstream, signed locally.** Both apps register the `t3code://` URL scheme,
  so with the official app installed the OS picks one for deep links.
- **Linux testing so far is in containers.** Ubuntu 24.04, Rocky 9 and Fedora 44 ran on
  arm64; Arch ran on x86-64 under emulation as the stand-in for Omarchy. Each went from a
  bare image through install, build, scan, smoke test and install. Not yet exercised on
  real hardware:
  - opening the app,
  - the systemd timer firing (the unit files pass `systemd-analyze verify`),
  - Ubuntu's AppArmor profile,
  - real RHEL's `subscription-manager` step.
- **Upstream trust.** You're still running upstream's code and its npm dependency tree.
  Dependency install scripts are limited to upstream's pnpm `allowBuilds` list and the
  lockfile pins exact versions. This removes their telemetry; it doesn't audit
  everything else.
