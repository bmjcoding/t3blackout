# T3 Blackout

Builds [T3 Code](https://github.com/pingdotgg/t3code) from upstream source with every
phone-home removed, and runs it inside a fail-closed egress sandbox. The only traffic
that leaves the machine goes to hosts you list: by default the coding harnesses
(Anthropic, OpenAI, Google) and GitHub.

## How it works

Four independent layers, so a miss in one is caught by the next:

1. **Strip rules** (`lib/rules.mjs`). Small, anchored source edits applied to each
   upstream checkout: PostHog analytics, OTLP export, T3 Connect/Clerk/relay, the
   model-manifest and LiteLLM fetches, npm version polling, Google favicon lookups,
   the Electron auto-updater. Each rule states how many times its anchor must match.
   If upstream moves the code, the update **aborts** and the installed build stays.
2. **Build verification.** The built `.app` (including `app.asar`) is scanned for known
   telemetry endpoints and keys.
3. **Smoke test.** The built server boots inside the sandbox behind a deny-everything
   proxy, with an empty `HOME` (no harness credentials) and a minimal `PATH`. It must
   answer with the CSP in place and make **zero** outbound attempts in 20 s. Under the
   same test, unstripped upstream tries PostHog and GitHub within seconds. A new
   phone-home added upstream fails the update here, even before any rule knows
   about it.
4. **Runtime sandbox.**
   - `sandbox/t3blackout.sb` (macOS Seatbelt) lets the app and every process it spawns
     (Claude Code, Codex, git, shells…) reach only loopback. DNS is blocked too.
   - `egress/proxy.mjs` is the only way off the machine. It allows destinations in
     `egress/allowlist.txt` and logs and refuses everything else.
   - A strict Content-Security-Policy restricts the UI to loopback.
   - The boot guard inside the app refuses to start outside the sandbox. A
     double-clicked app relaunches itself through `t3blackout launch`. To detect the
     sandbox, the guard tries to read `sandbox/canary`. The profile denies exactly
     that file, so only the t3blackout sandbox returns `EPERM`. A network probe isn't
     enough: VPN and filter extensions (NordVPN Threat Protection on this Mac) also
     answer connections with `EPERM`.

The build itself also runs sandboxed, so dependency postinstall scripts can only reach
`egress/build-allowlist.txt` (npm, GitHub, Electron headers, crates.io).

## Commands

```sh
bin/t3blackout update            # newest nightly → strip → build → verify → smoke → install
bin/t3blackout update --channel preview|stable   # or --ref <tag|sha>
bin/t3blackout check             # dry-run the rules against latest upstream (no build)
bin/t3blackout launch            # start the proxy + T3 Blackout.app inside the sandbox
bin/t3blackout serve             # server-only: sandboxed server, UI in your own browser
bin/t3blackout denials           # what the app tried to reach and was refused
bin/t3blackout smoke             # re-run the zero-egress smoke test on the installed app
bin/t3blackout status | rollback
bin/t3blackout schedule --hour 4 # daily auto-update via launchd (unschedule to remove)
bin/t3blackout signing init|import|status --vault Personal   # shared signing cert (1Password)
bin/t3blackout uninstall         # remove both LaunchAgents (keeps app and data)
```

The app installs to `~/Applications/T3 Blackout.app`, and its state lives in `~/.t3blackout`.
It never reads or writes the official app's `~/.t3`. It has its own bundle ID, Chromium
profile, Keychain Safe Storage item and runtime name, so both apps can be installed side
by side.

Opening the app from Finder or the Dock works too. The app sees it's outside the sandbox
and asks launchd to start `dev.t3blackout.launch`, an inert LaunchAgent that `update`
installs. That agent runs `t3blackout launch` and quits. The guard's decisions are
logged to `~/.t3blackout/guard.log`.

## Setting up another Mac

Each Mac builds its own copy from the same upstream tag. Run these on each new Mac:

```sh
# Prerequisites: Xcode CLT, Homebrew node + pnpm, Rust, 1Password app with
# Settings → Developer → "Integrate with 1Password CLI" turned on.
brew install --cask 1password-cli
# Copy or clone this repo, at any path.
bin/t3blackout signing import --vault Personal   # 1Password approval + one macOS password prompt
bin/t3blackout update                            # build, verify, smoke-test, install
bin/t3blackout schedule --hour 4                 # optional: daily auto-update
```

## Signing and Keychain prompts

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

- **Agents' network access is limited to the allowlist.** `pip install`, `cargo`,
  `brew`, `go get`, docker pulls and `curl` to arbitrary sites fail until you add the
  host. npm, GitHub and the model APIs work out of the box. Check
  `bin/t3blackout denials`, add the host, and it takes effect immediately.
- **No remote environments or T3 Connect.** Controlling T3 on another Mac over
  Tailscale or LAN is blocked by the loopback-only sandbox and the CSP. Relay and mobile
  pairing through T3's servers are gone.
- **Remote images in chat don't render.** GitHub images still work (the server fetches
  them through the allowlisted GitHub hosts). Link favicons show a generic icon.
- **No provider CLI update nudges.** That check talks only to npm and GitHub. Turn it
  back on in Settings if you want it. Claude Code doesn't self-update inside the
  sandbox; it still updates when you run `claude` in a normal terminal.
- **The model list is the one bundled in each build.** Daily rebuilds keep it at most
  about a day behind upstream.
- **Cost estimates are unaffected.** `update` downloads the LiteLLM pricing table
  through the build proxy and seeds the app's cache; the app never fetches it.

## Changing what's allowed

Edit `egress/allowlist.txt`. The proxy reloads it on save. Use `bin/t3blackout denials` to
see what was refused. Only ports 80 and 443 are allowed unless you add an explicit
`host:port` entry (`github.com:22` is one, for git over SSH through the proxy).

## When an update fails

`state/t3blackout.log` says why, and you also get a macOS notification. The installed
build is untouched. The usual causes are:

- **A rule no longer matches.** Upstream changed that code. Update the anchor in
  `lib/rules.mjs` (`bin/t3blackout check` iterates quickly).
- **The smoke test saw outbound traffic.** Upstream added a new network call. The
  host is in the error. Add a rule that disables it.
- **The build hit a denied host.** Check `state/egress-build.jsonl`. Add the host to
  `build-allowlist.txt` only if it's a legitimate toolchain download.

## Limits, stated plainly

- **Harness traffic is allowed by design, and a hostname allowlist can't filter what
  goes inside it.** Telemetry a harness sends to the same host as its API (e.g.
  `api.anthropic.com`) passes through. Separate telemetry hosts (Datadog, Statsig,
  Sentry, `*.oaiusercontent.com`) are refused, and the launcher sets Claude Code's
  `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
- **`launch` runs Electron with `--no-sandbox`.** macOS won't nest Seatbelt profiles,
  so Chromium's per-process renderer sandbox can't initialize inside ours. Egress
  stays fail-closed for every process, but a compromised renderer could read your
  files (not send them anywhere unlisted). The UI only loads local, CSP-locked
  content, and the preview browser can only reach allowlisted hosts. If you want
  Chromium's sandbox too, use `serve` and a normal browser.
- **Network only.** The profile doesn't restrict the filesystem; agents need your
  repos.
- **`sandbox-exec` is deprecated by Apple.** It still works, and Chromium and Claude
  Code rely on Seatbelt, but a future macOS could remove the CLI.
- **Two exemptions from the sandbox.** `/bin/ps` and `/usr/bin/top` are setuid, which
  Seatbelt won't exec, so they run unsandboxed. Both only read the process table.
- **Unsigned build.** It's ad-hoc signed locally. Both apps register the `t3code://`
  URL scheme, so with the official app installed macOS picks one for deep links.
- **Upstream trust.** You're still running upstream's code and its npm dependency
  tree. This removes their telemetry; it doesn't audit everything else.
