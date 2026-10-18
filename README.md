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

   They also give the app its own name, bundle ID and data directory, plus its look: the
   T3 BLACKOUT wordmark (an SVG lettered after the Black Ops II logo), the Blackout and Blackout Smoke themes (with a Vignette or Dot glow pattern behind the chat, and a smoked-glass window on macOS), and
   redaction bars in place of upstream's nightly starfield. Each rule states
   how many times its anchor must match; if upstream moves the code, the update
   **aborts** and the installed build stays.
2. **Boot environment** (`lib/files/boot-env.ts`). This runs first in the app.
   - It switches T3's telemetry off a second time.
   - It switches off the agent CLIs' own analytics and crash reporting where a switch
     exists: Claude Code, Grok, Pi, Muse, and Bun's crash reporter (which OpenCode uses).
     Codex only takes launch flags, so a rule adds them to every Codex launch.
   - On Linux and Windows it turns off Electron's spellchecker, which would otherwise
     download dictionaries from Google.
   - It points the app at `~/.t3blackout`.
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

- **Daily, at 04:00.** It builds the newest release on your update track that is at least
  **48 hours old**. That trailing window gives a bad upstream release time to be noticed
  and pulled before it reaches your machines. If T3 Blackout is closed, the new build is
  installed right away. If it's open, the build waits, and the update button in the
  sidebar offers a restart into it. To change the window, set `T3BLACKOUT_SOAK_HOURS` or
  pass `--soak-hours`; `--ref` skips it.
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

### Separate build account

Every build runs upstream's dependency install scripts and build scripts. That's code
you haven't read, running unattended at 04:00. So `install.sh` creates an unprivileged
account, `_t3blackout`, and the fetch, build and smoke test run as it:

- **Where its files live:** `/private/var/t3blackout-build` on macOS,
  `/var/lib/t3blackout-build` on Linux. That holds the upstream mirror, the build
  checkout and its own pnpm store. It can't read your home folder, SSH keys or
  credentials.
- **How it's started:** through one sudo rule, `<you> ALL=(_t3blackout) NOPASSWD: ALL`.
  The rule only works in one direction: you can act as the build account, and it can't
  act as you or as root.
- **What it hands back:** an unsigned app. You scan it again, sign it and install it.
- **What it doesn't protect:** the app itself still runs as you, so this guards the build,
  not what upstream's code does at runtime.
- **Without sudo:** builds run as you, and `status` says so.

### Updates to T3 Blackout itself

Before building, the daily run fast-forwards this clone to origin's `main`. It only
does so if every new commit is signed by a key listed in `.allowed_signers`, checked
against that file as it is on the machine, not as the incoming commits would have it.
That's how a rule fix pushed from one machine reaches the others, without letting
someone who gets into the GitHub account push code that every machine runs.

- **The trusted key** is your SSH commit-signing key, which lives in 1Password.
- **Fetching** uses the GitHub CLI's stored login, so it never waits on an SSH-agent
  prompt.
- **Refusals:** unsigned or rewritten history is refused, and you get a notification.

## Install

Each machine builds its own copy from the same upstream tag.

```sh
gh repo clone bmjcoding/t3blackout && cd t3blackout   # any path works
./install.sh
```

`install.sh` is safe to rerun. It installs what's missing, sets up the build account
(sudo asks for your password once), builds, verifies, smoke-tests and installs the app,
then schedules the daily update at 04:00 (`T3BLACKOUT_UPDATE_HOUR` to change it).

**macOS** (Apple silicon or Intel):

- **You need:** Homebrew, the Xcode Command Line Tools, and the 1Password app with
  **Settings → Developer → Integrate with 1Password CLI** turned on.
- **Installs:** git, node, pnpm, Rust and the 1Password CLI with Homebrew.
- **Signing:** sets up the shared signing certificate (see below). Run it from
  Terminal so the 1Password prompt names Terminal.
- **App:** `~/Applications/T3 Blackout.app`, updated by a launchd agent.

**Linux** (Omarchy/Arch, Ubuntu/Debian, Fedora/RHEL; x64 or arm64):

- **System packages:** build tools and libsecret, with pacman, apt or dnf.
- **Node 24:** the official tarball, checksum-verified, into your home directory, so the
  distro's version doesn't matter. The build account gets its own copy of Node, pnpm and
  Rust (via rustup) in its own home.
- **Ubuntu 23.10+:** adds a one-line AppArmor profile so Electron's own sandbox can
  start under Ubuntu's user-namespace restriction.
- **Signing:** none. Linux keyrings don't tie access to an app's signature.
- **App:** extracted to `~/.local/share/t3blackout/app`, so it doesn't need FUSE. It
  appears in your launcher as "T3 Blackout" and is updated by a systemd user timer.

## Commands

```sh
bin/t3blackout update            # newest soaked release on your track → strip → build → verify → smoke → install
bin/t3blackout update --channel nightly|preview|stable   # or --ref <tag|sha>; --soak-hours N
bin/t3blackout poll              # is there a newer release? (--offline: don't fetch)
bin/t3blackout check             # dry-run the rules against latest upstream (no build)
bin/t3blackout smoke             # re-run the zero-egress smoke test on the last build
bin/t3blackout launch            # open the app, installing a waiting build first
bin/t3blackout status | rollback
bin/t3blackout schedule --hour 4 | unschedule
bin/t3blackout signing adopt|import|init|status --vault Personal   # macOS only
```

The app keeps its state in `~/.t3blackout` and never touches the official app's `~/.t3`.
It also has its own:

- bundle ID,
- Chromium profile,
- Keychain Safe Storage item,
- runtime name.

So both apps can be installed side by side.

## Skills

Every folder in [`skills/`](skills) ships with the app as an agent skill, invoked from
any provider's composer: `/explain <topic>` draws the topic as a page in the thread.

- On launch the app writes each skill to `~/.t3blackout/skills/<name>` and symlinks it into
  the skills folder of every agent harness you have installed: `~/.claude/skills` (Claude,
  Cursor), `~/.agents/skills` (Codex, Cursor, OpenCode, Muse, Copilot, Devin, goose, Auggie,
  Gemini CLI), `~/.gemini/config/skills` (Antigravity), `~/.grok/skills`, `~/.qwen/skills`
  and `~/.junie/skills`. A harness counts as installed when its home
  folder exists; one installed later is linked on the next launch or when you open
  **Settings → Skills**.
- It only ever adds or removes its own links. A skill of yours with the same name is
  left alone, and Settings shows it as skipped.
- **Settings → Skills** has a switch per skill. Off removes its links.
- A new skill is a folder with a `SKILL.md` whose frontmatter `name` matches the folder;
  `bin/t3blackout check` rejects one that doesn't.

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
2. Run `bin/t3blackout signing adopt`. It exports the certificate (macOS asks you to
   allow it), adds Apple's intermediate certificate, stores both in 1Password
   (Personal vault, "T3 Blackout code signing") and installs them into
   `state/signing.keychain-db`. That keychain is separate from your login keychain,
   and its random password is in `state/signing.keychain-pass` (mode 600).
3. Other Macs: `install.sh` (or `bin/t3blackout signing import`) fetches it from
   1Password.
4. After the first build signed with it, click **Always Allow** on both prompts (one for
   the app, one for its helper). That's once per Mac.

The certificate expires after a year: renew it in Xcode and run `signing adopt` again.
Without one, `signing init` creates a self-signed fallback, which works but prompts after
every update. Signing never contacts Apple, because no timestamp is requested.

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
  update. The agent CLIs talk to their providers directly. Their own analytics are
  switched off where they offer a switch, and what the agents reach is up to their
  sandboxes or yours. Two have no switch:
  - **Cursor:** its SDK runs inside T3's server and reports usage events to Cursor's API,
    the same host it needs for everything else.
  - **Antigravity:** telemetry is controlled only by your Google account's settings.
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
  This removes their telemetry; it doesn't audit everything else. What limits the damage:
  - Dependency install scripts are limited to upstream's pnpm `allowBuilds` list, and the
    lockfile pins exact versions.
  - Builds wait 48 hours and run as the separate build account.
  - The app you run is still upstream's code, running as you.
