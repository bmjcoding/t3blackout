# Two Macs: a desktop Mac and an always-on agent host

The **desktop Mac** runs the T3 Blackout app you work in. Coding agents run on the
**always-on host Mac**, each in its own standard macOS account with its own T3
server, which the desktop reaches as an SSH environment over Tailscale. Optionally,
a **standby lane** on the desktop Mac (one more agent account, reached through a
loopback-only SSH server) keeps you working when the host is down.

```
desktop Mac ──SSH over Tailscale, port 22──▶ agent-claude@t3b-host    (host: T3 server + provider CLIs)
            └─SSH to 127.0.0.1, port 2222──▶ agent-standby (same Mac) (optional standby lane)
```

This guide takes two freshly wiped Macs with nothing installed to a working,
verified setup, in the order the steps depend on each other. The names below are
examples; use your own consistently.

| In this guide | What it is |
|---|---|
| `t3b-host` | The always-on host Mac's Tailscale machine name (MagicDNS) |
| `t3b-desktop` | The desktop Mac's Tailscale machine name |
| `agent-claude` | An agent account on the host (add more the same way) |
| `agent-standby` | The standby lane's agent account on the desktop Mac |
| your admin account | The account you set each Mac up from; on the desktop Mac, your daily account |
| `~/.ssh/t3blackout.pub` | The public half of the SSH key you log in to agent accounts with |

**Order:** 0 (only when rebuilding) → 1 on both Macs → 2 → 3 on the host → 4 on
the desktop Mac → 5 → 6 → 7. Set up the host first: the desktop's SSH steps need it
running.

## 0. Before you wipe a Mac you're rebuilding

- **Tailnet Lock.** If it's on and the Mac is a signing node, make sure you hold a
  disablement secret (saved when you enabled it) somewhere that isn't on these Macs,
  or keep another signing node running and rebuild one signing Mac at a time:
  sign and add the replacement from the surviving signer before you wipe the next
  one (section 6). Wiping every signing node with no disablement secret leaves a
  tailnet you can't add the new Macs to.
- **Threads.** Each server keeps its threads in its own account's `~/.t3blackout`,
  tied to that server's identity (`userdata/environment-id`). Back up every account
  whose history you want (your own account for the desktop's Local environment,
  each agent account for its SSH environment) with the app quit and the agent
  servers stopped (switch their environments off). Restore each backup into the
  same kind of account it came from: an agent's history into an agent account on
  the host, your Local environment's into your own account on the desktop Mac.
- **Tokens.** The old Macs held a GitHub CLI login and provider tokens (`claude
  setup-token`, Codex). Plan to revoke them once the new Macs are signed in.
- **Host keys change.** A rebuilt host has new SSH host keys; section 5 covers
  trusting the new ones.

## 1. Both Macs: base system

Do these on each Mac, from your admin account.

1. **macOS** up to date. Turn on **FileVault** (System Settings → Privacy & Security)
   and keep the recovery key in your password manager.
2. **Xcode Command Line Tools:** `xcode-select --install`. This also provides `git`,
   which must be **2.45 or later**: `git --version` (Command Line Tools 26.6 ship
   2.50.1). If it's older, `install.sh` installs Homebrew's git, which comes first on
   the `PATH` Homebrew's installer sets up (next step), and stops if an older git
   still comes first. Full Xcode is optional for T3 Blackout itself: Xcode 26+ gives
   the app icon its Liquid Glass rendering, and Xcode is how you create the Apple
   Development signing certificate on the first Mac (README, "Signing and Keychain
   prompts"). iOS Simulators need it on whichever Mac runs them (5.3).
3. **Homebrew** from <https://brew.sh>. Run the two `echo … >> ~/.zprofile` / `eval`
   lines its installer prints, then open a new Terminal window and check
   `brew --version`. Homebrew must be on your `PATH` before `install.sh` runs: the
   scheduled updater keeps the `PATH` that `install.sh` ran with.
4. **Node and npm:**

   ```sh
   brew install node
   node --version      # 24.22.1 or later on 24.x, or 26.12.1 or later (install.sh refuses older)
   command -v npm      # /opt/homebrew/bin/npm (Apple silicon) or /usr/local/bin/npm (Intel)
   ```

   Builds, the evaluator and self-update call `npm` (device-tool dependency checks),
   so it must be on that same `PATH`.
5. **1Password** app, signed in. In its Settings → Developer, turn on **Integrate
   with 1Password CLI** and **Use the SSH agent**. `install.sh` installs the 1Password
   CLI (`op`) and uses it for the shared code-signing certificate.
6. **Pick the key agent accounts accept** and save its public half on both Macs as
   `~/.ssh/t3blackout.pub` (create `~/.ssh` with `mkdir -m 700 ~/.ssh` if it doesn't
   exist): in 1Password, open the SSH key item and download its public key. 1Password
   syncs the private key to both Macs, so the desktop and the host can both log in
   with it.
7. **Point OpenSSH at the 1Password agent, and at that one key.** Turning the agent on
   doesn't make `ssh` use it. And an SSH server stops after six offered keys
   (`MaxAuthTries`), so with several keys in the agent a login can fail before
   reaching the right one. Put this in `~/.ssh/config` now, before the first login
   (use your host's name in place of `t3b-host`; `localhost`, `127.0.0.1` and `::1`
   cover the logins on the host itself and the standby lane):

   ```
   # The key agent accounts accept, and only it, for the machines T3 Blackout logs in to.
   Host t3b-host localhost 127.0.0.1 ::1
     IdentityFile ~/.ssh/t3blackout.pub
     IdentitiesOnly yes

   Host *
     IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
   ```

   `IdentityFile` names the public key; the private key stays in 1Password, which
   offers the matching one. Check it:
   `SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ssh-add -l`
   lists your keys, and `ssh -G agent-claude@t3b-host | grep -E '^identit'` shows
   `identitiesonly yes` and `identityfile ~/.ssh/t3blackout.pub`. (Another agent, or a
   key file, works too; pass its public key to the account script with `--key`.)
8. **Google Chrome** (or Chromium) in `/Applications` on the desktop Mac. Preview and
   the before/after screenshots in every build report use it; Safari can't. Without
   it, builds still install, with no screenshots, and Preview says Chrome is missing.
   The host doesn't need it.
9. **Optional:** the GitHub CLI (`brew install gh`, `gh auth login`), only in your
   own account and only if you push to a fork. The HTTPS clone below needs no login.
   Never sign `gh` in inside agent accounts (section 3.6).
10. **No HTTPS-inspecting security software.** The app's runtime doesn't trust
    system-installed root certificates, so a tool that decrypts and re-signs HTTPS
    breaks npm checks, the preview browser and provider traffic. Trusting its root
    would only hide the interception.

## 2. Tailscale

### 2.1 The policy (admin console, before any Mac joins)

A new tailnet's policy lets every device reach every other device. Adding narrow
rules next to that changes nothing, so **replace the whole policy file** (admin
console → Access controls → edit the file) with this one. Delete every existing
`acls`, `grants` and `ssh` entry, including the default allow-all rule. Any other
device in the tailnet gets no access at all under this policy until you add a
grant for it.

```jsonc
{
  // T3 Blackout: the desktop Mac may open SSH (port 22) on the always-on host.
  // Nothing else is allowed. No "ssh" section: T3's SSH environments use the
  // host's own OpenSSH, not Tailscale SSH.
  "tagOwners": {
    "tag:t3b-host":    ["autogroup:admin"],
    "tag:t3b-desktop": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["tag:t3b-desktop"], "dst": ["tag:t3b-host"], "ip": ["tcp:22"] }
  ],
  "tests": [
    { "src": "tag:t3b-desktop", "accept": ["tag:t3b-host:22"], "deny": ["tag:t3b-host:80", "tag:t3b-host:443"] },
    { "src": "tag:t3b-host", "deny": ["tag:t3b-desktop:22", "tag:t3b-desktop:2222"] }
  ]
}
```

The console refuses to save the policy if a test fails. Tagging a device replaces
its user ownership with the tag. If you'd rather keep the desktop Mac as your own
user device, replace `tag:t3b-desktop` in the grant and the tests with your login
name (then every device you sign in can reach the host's port 22, still only with
an authorized key).

### 2.2 The host: the open-source `tailscaled`, as a system daemon

The host runs Tailscale's open-source daemon, which starts at boot before anyone
logs in. The GUI app variants don't serve an unattended host.

First delete any old machine named `t3b-host` in the admin console (Machines), or
the new one is named `t3b-host-1`. Then, on the host (Apple silicon paths; on Intel,
`/usr/local/bin`):

```sh
brew install tailscale
sudo /opt/homebrew/bin/tailscaled install-system-daemon    # copies tailscaled to /usr/local/bin, adds a LaunchDaemon
```

**Opt out of client log uploads** (Tailscale's documented switch for this variant is
`tailscaled --no-logs-no-support`; `install-system-daemon` takes no flags, so add it
to the LaunchDaemon it wrote):

```sh
sudo /usr/libexec/PlistBuddy -c 'Add :ProgramArguments: string --no-logs-no-support' /Library/LaunchDaemons/com.tailscale.tailscaled.plist
sudo launchctl bootout system/com.tailscale.tailscaled
sudo launchctl bootstrap system /Library/LaunchDaemons/com.tailscale.tailscaled.plist
ps -ax -o args= | grep '[t]ailscaled'       # shows: /usr/local/bin/tailscaled --no-logs-no-support
```

**Join, tagged, with the name you want:**

```sh
sudo /opt/homebrew/bin/tailscale up --advertise-tags=tag:t3b-host --hostname=t3b-host
```

Open the URL it prints and approve the device. A device whose first sign-in is
tagged gets key expiry disabled; check it anyway: admin console → Machines →
`t3b-host` must show **Expiry disabled** (otherwise … → Disable key expiry). An
expiring key would cut the unattended host off. Changing tags later doesn't change
expiry until the device re-authenticates.

This daemon doesn't change the host's DNS settings, so the host itself doesn't
resolve MagicDNS names (it doesn't need to; it's only ever connected to). To update
Tailscale later: `brew upgrade tailscale`, rerun `install-system-daemon` (it
rewrites the plist), then add `--no-logs-no-support` again as above.

### 2.3 The desktop Mac: the Tailscale app

Install the Tailscale app (tailscale.com/download, or the Mac App Store) and sign
in. In the admin console: rename the machine `t3b-desktop` (… → Edit machine name),
apply `tag:t3b-desktop` (… → Edit tags), and check MagicDNS is on (DNS page). Key
expiry on a laptop you use every day is fine either way: an expired key only asks
you to sign in again.

**The `tailscale` command.** The app doesn't put one on your `PATH`, and this guide
uses it (`tailscale status`, `tailscale lock`):

- **Standalone app** (tailscale.com/download): in the Tailscale app, **Settings → CLI
  integration → Show me how → Install Now**, with your admin password. It installs
  `/usr/local/bin/tailscale` (macOS 13 or later).
- **Mac App Store app:** add
  `alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"` to
  `~/.zshrc` and open a new Terminal window.

Check: `tailscale status` lists this Mac.

Tailscale documents no log opt-out for its app variants yet, so the desktop Mac's
client keeps uploading its diagnostic logs.

Once the host's SSH is on (section 3.3), check the route from the desktop Mac:
`nc -z -G 5 t3b-host 22` succeeds. If it fails, `tailscale status` shows the host's
`100.x` address; `nc -z -G 5 <100.x address> 22` succeeding means only name
resolution is wrong.

## 3. The always-on host Mac

### 3.1 Power, restarts and FileVault

- **Never sleep:** `sudo pmset -a sleep 0 disksleep 0 womp 1`, and on a desktop Mac
  also `sudo pmset -a autorestart 1` (start after a power failure). `pmset -g` shows
  `sleep 0`. A laptop host stays on power with its lid open; a closed lid sleeps it.
  The display may sleep.
- **FileVault restarts:** after any restart the disk stays locked until someone
  unlocks it, and neither Tailscale nor your SSH setup runs until then. For a restart
  you start yourself, use `sudo fdesetup authrestart`, which unlocks the next boot
  once. Otherwise plan on unlocking it at the Mac.
- **FileVault unlock over SSH (macOS 26 or later, Apple silicon).** With Remote Login
  on, a locked Mac runs a minimal SSH server of Apple's from the system volume at
  startup (`man apple_ssh_and_filevault`). It only unlocks the disk and then
  disconnects; it opens no shell. But it isn't the SSH server section 3.3 configures,
  which lives on the locked disk:
  - it takes a **password**, never a key, for **any account that can unlock the disk**
    (`sudo fdesetup list`). Remote Login's access list and the key-only settings are
    on the locked disk too, so they don't apply: Apple's source accepts any user name
    there and checks the password against FileVault;
  - it's reachable from your **local network** only (Tailscale isn't running yet).

  Apple documents no switch for it apart from turning Remote Login off, which the
  host can't do. So keep the list of accounts that can unlock the disk short and
  their passwords strong:

  ```sh
  sudo fdesetup list                        # accounts that can unlock this disk
  sudo fdesetup remove -user agent-claude   # only if an agent account is listed
  ```

  Agent accounts never need to unlock the disk: they're only ever reached over SSH
  after it's unlocked. Repeated wrong passwords lock the unlock out for a while.
- **macOS updates:** set them to download but not install automatically
  (System Settings → General → Software Update → Automatic updates), and install
  them yourself with a restart you can follow up on.
- **A restart test** comes once everything is connected (section 7): Remote Login
  and the updater aren't set up yet.

### 3.2 Clone and install

Clone somewhere outside `~/Documents`, `~/Desktop` and `~/Downloads`: the updater
runs as a LaunchDaemon, and macOS privacy controls block daemons from those folders.

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/bmjcoding/t3blackout.git
cd t3blackout
./install.sh --role host
```

Run it as yourself, not with `sudo`; it asks for your password when it needs it.
It:

- installs whatever is missing or too old (git older than 2.45, Node, Rust, the
  1Password CLI) with Homebrew, and pnpm 12.14.0 from npm tarballs checked against
  pinned digests;
- sets up the shared code-signing certificate from 1Password (approve the 1Password
  prompts; on the first Mac, see README "Signing and Keychain prompts");
- creates the unprivileged build account `_t3blackout` and makes your home private
  (`chmod go-rwx`), so builds and agent accounts can't read it;
- builds the release `pin.json` pins and installs it to `/Applications/T3 Blackout.app`
  (the first build takes a while), without opening it;
- installs the hourly updater as a LaunchDaemon (`dev.t3blackout.update`) that runs
  as you with nobody logged in, and also runs whenever a server here asks for an
  update.

The host role needs an admin account (the app must go in `/Applications`, where
agent accounts look for it) and the default locations: `install.sh` stops if
`T3BLACKOUT_APPS` or `T3BLACKOUT_UPDATE_REQUESTS` points anywhere else.

Keep the clone's `origin` the HTTPS URL above (or `git@github.com:…`). Self-update
fetches only a github.com origin, over HTTPS: an origin that's an SSH host alias
(`git@github-work:…`) is never fetched, and the Mac never takes new commits or
pins (Troubleshooting).

Check it: `bin/t3blackout status` shows `role: host`, `schedule: hourly, and on
update requests (LaunchDaemon: runs with nobody logged in)`, `builds: as
_t3blackout`, the app in `/Applications` and the pinned nightly release. The role
and locations are saved in `state/install.json` (`state/` is readable only by you).
To change the role, rerun `./install.sh --role …`: `bin/t3blackout configure --role
…` alone saves it but leaves the scheduled job as it was until `bin/t3blackout
schedule` runs (a `ui` or `both` job is a LaunchAgent, which stops when you log out).

### 3.3 An agent account and Remote Login

```sh
sudo scripts/add-agent-account.sh agent-claude --key ~/.ssh/t3blackout.pub
```

macOS asks you to choose the new account's password; keep it in your password
manager (it's only for logging in at the screen). The script:

- creates `agent-claude` as a standard (non-admin) account if it doesn't exist, puts
  it in the group `t3blackout-agents`, and makes its home `0700` with no ACL entries
  but macOS's own `everyone deny delete` (it stops if your account can still open
  that home);
- authorizes exactly that one public key for it in
  `/etc/ssh/t3blackout/authorized_keys/agent-claude`, owned by root and rewritten on
  every run. Agent accounts' own `~/.ssh/authorized_keys` files are ignored, so an
  agent can't add keys. Your own account keeps its normal `~/.ssh/authorized_keys`;
- writes `/etc/ssh/sshd_config.d/010-t3blackout.conf`: password and keyboard-interactive
  logins off for everyone, root login off, and for `t3blackout-agents` only key
  logins and forwarding to this Mac's loopback (no agent, X11 or remote forwarding);
  it validates the file with `sshd -t` and puts the previous one back if sshd
  rejects it (creating missing host keys first);
- sets Remote Login's access list (the `com.apple.access_ssh` group that macOS
  checks for every SSH login) to exactly the members of `t3blackout-agents`. Your
  admin account and anyone else in the list are removed, nested groups such as
  "Administrators" included;
- installs the Claude token helper, root-owned, at
  `/usr/local/libexec/t3blackout/set-claude-token`, because agent accounts can't
  open your home or the clone in it;
- copies the pricing table the updater published, so cost estimates work in that
  account.

Then turn on **Remote Login**: System Settings → General → Sharing → Remote Login,
and in its ⓘ panel leave **Allow full disk access for remote users** off and choose
**Allow access for: Only these users**. System Settings can change that list when
you turn Remote Login on, so run the same `add-agent-account.sh` command again
afterwards, then check:

```sh
dscl . -read /Groups/com.apple.access_ssh GroupMembership   # only your agent accounts
dscl . -read /Groups/com.apple.access_ssh NestedGroups      # "No such key"
sudo sshd -T -C user=agent-claude,host=localhost,addr=127.0.0.1 |
  grep -E '^(authorizedkeysfile|passwordauthentication|allowtcpforwarding|permitopen) '
# authorizedkeysfile /etc/ssh/t3blackout/authorized_keys/%u
# passwordauthentication no
# allowtcpforwarding local
# permitopen 127.0.0.1:* localhost:* [::1]:*
```

Rerun the script whenever you've touched Remote Login's settings: it puts the list
back. Remote Login listens on every interface, so the host's key-only SSH is also
reachable from your local network (see "What this doesn't protect").

### 3.4 Log in as the agent

From your admin account on the host:

```sh
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done   # the host's fingerprints
ssh agent-claude@localhost
```

On the first connection `ssh` shows the host key's fingerprint; accept it only if it
matches the line for the same key type above. 1Password asks you to approve the
key's use. A password prompt or `Permission denied (publickey)` means the key
isn't reaching sshd (Troubleshooting).

### 3.5 Provider CLIs, inside the agent account

The agent account has none of your shell setup, and it can't write Homebrew's
global npm folder. Put the shared Homebrew tools and its own npm folder on its
`PATH` in `~/.zprofile` (the server reads `PATH` from the account's login shell),
and point npm's global installs at that folder in `~/.npmrc` (so the app's provider
updates use it too):

```sh
cat >> ~/.zprofile <<'EOF'
# T3 Blackout agent account: Homebrew's tools (read-only) and this account's own npm installs.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
EOF
exec zsh -l
npm config set prefix "$HOME/.npm-global"
npm install -g --before="$(date -v-3d +%Y-%m-%d)" --allow-scripts=@anthropic-ai/claude-code \
  @anthropic-ai/claude-code @openai/codex
```

- `--before` takes the newest versions at least 3 days old, the same minimum age the
  app's own provider updates use.
- `--allow-scripts=@anthropic-ai/claude-code` lets Claude Code's install script run,
  and only its: that script puts the native `claude` binary in place. npm 12 blocks
  install scripts it hasn't been told to allow, and without it `claude` only prints
  `Error: claude native binary not installed.` Codex has no install script. npm 11
  (Homebrew's today) accepts the same option. The app's own Claude Code updates pass
  it too.

Install only the CLIs this account should run, and install them with npm (or pnpm):
those are the installs the app's Update keeps to the 3-day minimum. For one installed
with its vendor's installer (Claude Code's `curl … | bash`) the app runs the vendor's
updater instead (`claude update`), and for Homebrew `brew upgrade`; neither waits 3
days. The app refuses to update one installed with bun, yarn, Volta or Vite+.

Check from a fresh session, from your admin account:

```sh
ssh agent-claude@localhost 'zsh -ilc "command -v node npm claude codex; claude --version; codex --version"'
```

`claude --version` must print a version. The CLIs' own updaters (`claude update`,
`codex update`, auto-updates) fetch their vendors' newest builds without the 3-day
minimum.

### 3.6 Provider sign-in

Still as `agent-claude` (in the SSH session from your admin account on the host):

- **Codex:** `codex login`. Open the URL it prints in the browser in your admin
  session on this same Mac; its callback goes to this Mac's loopback. If that
  doesn't complete, `codex login --device-auth` signs in with a code instead (device
  code sign-in has to be allowed in your ChatGPT account's or workspace's security
  settings). `codex login status` confirms it. Codex keeps its login in
  `~/.codex/auth.json`, which works over SSH.
- **Claude Code:** an SSH session can't unlock the login Keychain (`security` error
  36), where Claude Code normally keeps its login. Run `claude setup-token`, approve
  it in the browser, then run `/usr/local/libexec/t3blackout/set-claude-token` and
  paste the token at its hidden prompt. It's stored in `~/.t3blackout/server.env`
  (owner only, no ACL entries), which the SSH runner loads and refuses if anyone else
  can read it. Clear the terminal afterwards (⌘K) and don't paste the token anywhere
  else. The token lasts a year; run both commands again to replace it.
- **GitHub:** no `gh` login in agent accounts, or at most a fine-grained token
  limited to the repositories that agent works on, with no workflow permission.

Check: `ls -le ~/.t3blackout/server.env` shows `-rw-------` owned by the agent, with
no ACL lines.

### 3.7 More agent accounts

Repeat 3.3 (Remote Login stays on; each run reconciles the access list to every
agent account), then 3.4–3.6 for the new account. Agent accounts don't need to be
logged in at the screen: the servers start over SSH, and the updater needs no login.
The one possible exception is an account that runs iOS Simulators or Android
Emulators; 5.3 says how to tell.

## 4. The desktop Mac

### 4.1 Clone and install

Same prerequisites as section 1, then:

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/bmjcoding/t3blackout.git
cd t3blackout
./install.sh --role both      # or --role ui without the standby lane
```

`both` installs the desktop app to `/Applications` (shared with the standby
account) and the hourly updater as a LaunchAgent, which runs while you're logged
in. When the app is open, a new build waits and the update button offers a restart
into it. `bin/t3blackout status` shows `role: both` and `(LaunchAgent: while you're
logged in)`.

### 4.2 Restore your own threads (optional, before the first launch)

If you backed up your own `~/.t3blackout`, restore it now, before opening the app
for the first time and before the standby lane's server ever runs, into this
account's `~/.t3blackout` with your restore tooling. Then run
`bin/t3blackout status` once (it rewrites `~/.t3blackout/bin/t3blackout` for this
clone). Those threads belong to the desktop's Local environment; keep it on to see
them.

### 4.3 The standby lane (optional)

macOS's Remote Login can't be limited to loopback (launchd owns its listening
socket), so the standby lane gets its own SSH server and **Remote Login stays off on
the desktop Mac**:

```sh
sudo scripts/add-agent-account.sh agent-standby --loopback-only --key ~/.ssh/t3blackout.pub
```

Besides what 3.3 lists, `--loopback-only`:

- installs the LaunchDaemon `dev.t3blackout.sshd`, which runs Apple's `sshd -D -f
  /etc/ssh/t3blackout/sshd_config`: listening on `127.0.0.1` and `::1` port 2222 only,
  members of `t3blackout-agents` only, keys only, with its own host key;
- checks after starting it that nothing else listens on port 2222;
- restricts the key to `from="127.0.0.1,::1"`;
- records the standby sshd's host key in your `~/.ssh/known_hosts` for
  `[127.0.0.1]:2222`, `[localhost]:2222` and `[::1]:2222` (the app connects in batch
  mode and can't accept an unknown key);
- warns if Remote Login is on.

Check it:

```sh
sudo lsof -nP -iTCP:2222 -sTCP:LISTEN     # sshd on 127.0.0.1:2222 and [::1]:2222 only
nc -z -G 2 127.0.0.1 22                   # fails: Remote Login is off
ssh -p 2222 agent-standby@127.0.0.1 true  # no host key prompt, no password
```

From another machine, port 2222 on this Mac's LAN or Tailscale address must refuse
connections. Then do 3.5 and 3.6 for `agent-standby`, logging in with
`ssh -p 2222 agent-standby@127.0.0.1` (not `localhost` port 22: Remote Login is off
here) and opening sign-in URLs in your browser here. The check from a fresh session
in 3.5 becomes:

```sh
ssh -p 2222 agent-standby@127.0.0.1 'zsh -ilc "command -v node npm claude codex; claude --version; codex --version"'
```

With Remote Login off, the desktop Mac also has no FileVault unlock over SSH (3.1).

### 4.4 Open the app

`bin/t3blackout launch`, or open T3 Blackout from Applications. After the first
build signed with the shared certificate, macOS asks twice for the app's Keychain
item; click **Always Allow** both times.

## 5. Connect the desktop to the host

### 5.1 Trust the host's key

The app runs `ssh` in batch mode, so it can't accept a host key it hasn't seen. On
the host, list its fingerprints (`for f in /etc/ssh/ssh_host_*_key.pub; do
ssh-keygen -lf "$f"; done`). On the desktop Mac, connect once by hand to the exact
name you'll give the app:

```sh
ssh agent-claude@t3b-host true
```

Accept the key only if its fingerprint matches the host's line for the same key
type. The `Host t3b-host …` block from section 1 already makes `ssh` offer only the
agent accounts' key; the app reads the same `~/.ssh/config`.

### 5.2 Add the environments

In T3 Blackout: **Settings → Connections → Environments → Add environment → SSH**.

| Environment | SSH host or alias | Username | Port |
|---|---|---|---|
| Host | `t3b-host` | `agent-claude` | (empty: 22) |
| Standby lane | `127.0.0.1` | `agent-standby` | `2222` |

Adding it is the first pairing; there's no link to copy. The desktop connects over
SSH, starts the host's installed T3 Blackout server on the host's `127.0.0.1` in that
account, forwards its port to a local loopback port, then runs a second SSH command
that creates a one-time pairing credential and exchanges it for the credential it
keeps. 1Password asks you to approve T3 Blackout's use of the key the first time.

- **Only the installed build runs** (rule `ssh/runner-installed-blackout-only`):
  the remote never downloads a server. It looks for `T3BLACKOUT_APP`, then
  `/Applications/T3 Blackout.app`, then `~/Applications/T3 Blackout.app`.
- **Data stays separate:** each account's server keeps its data in its own
  `~/.t3blackout`, never `~/.t3` (rule `ssh/blackout-home`); the launch folder is
  `0700` because its log holds a one-time pairing link.
- **The server always asks for credentials:** loopback clients aren't trusted, so
  another account on the same Mac can't drive it.

Start a thread in each environment with Claude and with Codex. Turn **Local
environment** off (Settings → Connections) if the desktop Mac should run no agents
of its own; agents there run as you, with access to your home. Your restored threads
are in Local, so they're hidden while it's off.

### 5.3 Simulators and emulators (mobile apps)

The Device panel (in a project thread, the right panel → **Device**) shows a live
iOS Simulator or Android Emulator beside the thread, and agents drive the same device
(upstream's `docs/user/devices.md` has the full tour). **A simulator runs on the
machine of the environment the thread is in, in that environment's account:** the
host's agent account for a thread in the host's environment, your own account on
the desktop Mac for a Local thread. So run simulators where the project and its
agent are:

- **Projects on the host (the usual case): on the host, in the agent account.** The
  agent builds and installs the app on a simulator it can see, the simulator reaches
  Metro or any other dev server on the host's `localhost`, and you watch and tap it
  in the desktop's Device panel. Video and input travel over HTTP and WebSocket
  through the host's T3 server and the SSH environment's forwarded loopback port, so
  T3 Blackout's WebRTC block doesn't touch them and nothing but port 22 has to be
  open.
- **Projects in the Local environment: on the desktop Mac,** the same way through its
  local server. A standby-lane thread runs its simulators in `agent-standby` on the
  desktop Mac, set up like a host account below.
- **Not across machines.** A simulator on the desktop can't reach a dev server on the
  host through `localhost`, and upstream's SSH device hosts (Settings → Devices → Add
  source → Machine over SSH) would have the host's server SSH back into the desktop,
  which the Tailscale policy (2.1) refuses on purpose.
- **EAS Simulator** (Expo's cloud simulators) is the one source that streams over
  WebRTC. T3 Blackout lets only a hidden window of the app's own use UDP for it,
  straight to Expo's cloud; TURN over TCP or TLS isn't available, so on a network
  that blocks UDP an EAS device shows no video (README, "Device streams").

The panel's first-use setup starts the device hub and asks whether agents may
control devices (later: Settings → Devices, **Use devices** and **Agents can use
devices**). The hub's pinned, reviewed tools install into the account then, from npm
plus one prebuilt WebRTC library from GitHub, on Apple silicon only (README, How it
works).

**iOS on the host,** once, from your admin account:

```sh
# Install Xcode (App Store or developer.apple.com) into /Applications first.
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS      # the iOS Simulator runtime, shared by every account
```

Then check, for each agent account that should run simulators, that one boots from
an SSH session, the way that account's server starts it:

```sh
ssh agent-claude@localhost 'xcrun simctl list devices available'
ssh agent-claude@localhost 'xcrun simctl bootstatus "<a device name from the list>" -b && xcrun simctl shutdown all'
```

Each account has its own simulators. If the list has none, create one in that account
with a device type from `xcrun simctl list devicetypes` (`xcrun simctl create Phone
"<device type>"`). If the boot fails over SSH, log that agent account in at the
host's screen (then switch back to yours) and run the check again. If that fixes it,
keep the account logged in there, and log it in again after every restart of the
host (FileVault rules out automatic login).

**Android** goes in the account that runs the emulators: the host's agent account
for host threads, `agent-standby` for the standby lane, your own account on the
desktop Mac for Local threads. Neither `install.sh` nor the Device panel installs
it. The server only looks for an SDK: in the account's `~/Library/Android/sdk`, then
through `adb` on its `PATH`. It never sees an `ANDROID_HOME` set in `~/.zprofile` (a
server started over SSH takes only `PATH` and `JAVA_HOME` from the login shell; the
desktop's Local server gets `PATH` but not `JAVA_HOME`), so the SDK goes in that
folder.

- **Homebrew's `android-commandlinetools`, not Android Studio.** Android Studio's
  setup wizard, SDK Manager and Device Manager are windows that install into the
  account running them, so every agent account would need its own login at the
  screen; and an SDK in your admin account's home is closed to agent accounts (3.2
  makes that home private). The cask goes in once, into Homebrew's folder, which
  every account can read, and each account runs its `sdkmanager` over SSH to install
  its own SDK. The cask's default SDK root is inside Homebrew's folder, which agent
  accounts can't write, so each `sdkmanager` line below passes `--sdk_root`. (For
  your own account on the desktop Mac, Android Studio works too.)
- **Java 17.** `avdmanager`, which the device hub runs, and Homebrew's `sdkmanager`
  (Command-line Tools 22) are Java 17 programs, and React Native recommends JDK 17 for
  builds. Homebrew's `openjdk@17` isn't on the `PATH` by itself (keg-only), so each
  account sets `JAVA_HOME` and also puts the JDK's `bin` on its `PATH`, for the
  Local server.
- **One account per Mac runs emulators.** adb isn't separated by account: a Mac has
  one adb server, on port 5037, and it connects to every emulator on the Mac's
  loopback ports 5554–5585, whichever account started it.

From your admin account, once per Mac:

```sh
brew install --cask android-commandlinetools
brew install openjdk@17 ffmpeg      # ffmpeg (with libx264) is for emulator video
```

Then as the account that runs the emulators (`ssh agent-claude@localhost`, `ssh -p
2222 agent-standby@127.0.0.1`, or Terminal in your own account):

```sh
cat >> ~/.zprofile <<'EOF'
# Android: this account's own SDK, where T3 looks for it; JDK 17; the SDK's tools ahead of Homebrew's.
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"
EOF
exec zsh -l
sdkmanager --sdk_root="$ANDROID_HOME" --licenses    # read each license, answer y
sdkmanager --sdk_root="$ANDROID_HOME" "cmdline-tools;latest" "platform-tools" "emulator" \
  "platforms;android-36" "system-images;android-36;google_apis;arm64-v8a"
exec zsh -l
command -v sdkmanager avdmanager adb emulator        # each under ~/Library/Android/sdk
echo no | avdmanager create avd -n Pixel -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_8
```

- **API 36** (Android 16) is an example: install the platform your projects compile
  against and the image for it (`sdkmanager --sdk_root="$ANDROID_HOME" --list` shows
  them). Apple silicon needs an `arm64-v8a` image. Google APIs images allow `adb
  root`; Play Store images don't.
- The first `sdkmanager` is Homebrew's. Once `cmdline-tools;latest` is in, the
  account's own copy comes first. From Command-line Tools 23 on, `sdkmanager` hands
  its work to Google's new `android` command, and `--licenses` only prints that it's
  no longer needed; the package names stay the same.
- `-d pixel_8` is a profile from `avdmanager list device -c`; the `echo no` answers
  its custom hardware question. The virtual device goes in that account's
  `~/.android/avd`. The downloads come to about 2.5 GB per account.

Check from a fresh session, from your admin account (for the standby lane, `ssh -p
2222 agent-standby@127.0.0.1`). The boot uses the flags the device hub starts
emulators with:

```sh
ssh agent-claude@localhost zsh -l -s <<'EOF'
java -version 2>&1 | head -1                     # openjdk version "17…"
command -v adb emulator avdmanager               # each under ~/Library/Android/sdk
emulator -list-avds                              # Pixel
emulator -avd Pixel -no-audio -no-window -gpu auto -no-boot-anim >~/emulator-check.log 2>&1 &
for i in {1..90}; do [[ "$(adb shell getprop sys.boot_completed 2>/dev/null)" == 1* ]] && break; sleep 2; done
adb devices                                      # emulator-5554  device
adb emu kill; adb kill-server
EOF
```

If `adb devices` shows no `device` line, that account's `~/emulator-check.log` says
why (`ssh agent-claude@localhost cat emulator-check.log`). If the boot works only
while the account is logged in at the screen, the same login as for iOS applies.
After changing an account's tools, switch its environment off and on (for Local,
quit and reopen the app).

**Check it** from the desktop Mac: in a thread in the host's environment, open
**Device**, start a simulator, and tap it. The screen streams and answers.

## 6. Tailnet Lock (once both Macs are rebuilt)

Tailnet Lock makes every new device need a signature from one of your signing nodes,
so a compromised Tailscale account or coordination server can't add one.

1. On each Mac, `tailscale lock status` shows its Tailnet Lock key (on the desktop
   Mac, the CLI from section 2.3, or the app's Settings → Tailnet Lock).
2. Admin console → Settings → Device management → Tailnet Lock: choose both Macs as
   signing nodes (at least two are required) and copy the `tailscale lock init`
   command it gives you.
3. Run that command on one of the two Macs. It prints ten disablement secrets,
   shown only this once. Store them in your password manager (not only on these
   Macs). Without a secret or a surviving signer, a locked tailnet can't be recovered.
4. Check that `tailscale lock status` on both Macs says Tailnet Lock is enabled and
   that `nc -z -G 5 t3b-host 22` still succeeds from the desktop Mac.

Later, rebuilding one Mac: after it joins, sign it from the other with the
`tailscale lock sign nodekey:…` command `tailscale lock status` prints on the new
Mac, make the new Mac a signing node and remove the old one's key (Tailscale's
Tailnet Lock docs), and only then rebuild the other.

## 7. Verification checklist

| Where | Check | Expected |
|---|---|---|
| Both | `bin/t3blackout status` | the pinned nightly release installed, `builds: as _t3blackout`, Apple Development signing, the schedule line for the role |
| Host | `pmset -g` | `sleep 0` |
| Host | admin console → Machines | `t3b-host` tagged, Expiry disabled |
| Host | `ps -ax -o args= \| grep '[t]ailscaled'` | `--no-logs-no-support` |
| Host | `dscl . -read /Groups/com.apple.access_ssh GroupMembership` | only agent accounts |
| Host | `sudo sshd -T -C user=agent-claude,host=localhost,addr=127.0.0.1` | as in 3.3 |
| Host | `ssh agent-claude@localhost 'zsh -ilc "claude --version; codex --version"'` | both print a version |
| Host | `stat -f '%Sp' ~ /Users/agent-claude` (from your admin account) | `drwx------` for both |
| Host | `sudo ls -led /Users/agent-claude` | no ACL line but `0: group:everyone deny delete` |
| Host | `sudo fdesetup list` | your admin account; no agent accounts (3.1) |
| Desktop | `nc -z -G 2 127.0.0.1 22` | refused (Remote Login off) |
| Desktop | `sudo lsof -nP -iTCP:2222 -sTCP:LISTEN` | loopback only |
| Desktop | `ssh -p 2222 agent-standby@127.0.0.1 'zsh -ilc "claude --version; codex --version"'` | both print a version |
| Desktop | Settings → Connections → Environments | both environments Connected |
| Desktop | a thread per environment, Claude and Codex | answers |
| Host | 5.3's Android check, for the account that runs emulators (if you build Android apps) | `emulator-5554  device` |
| Desktop | in a host thread, **Device**, a simulator started and tapped (if you build mobile apps; 5.3) | streams and answers |
| Both | `tailscale lock status` | enabled, after section 6 |
| Both | the admin console's policy tests | pass |

Then, once, while you're at the host: **a restart test.** Run `sudo fdesetup
authrestart` there. From the desktop Mac, `nc -z -G 5 t3b-host 22` succeeds again
within a few minutes, and the host's environment reconnects (switch it off and on if
it doesn't on its own). The host's `bin/t3blackout status` still shows the
LaunchDaemon schedule line.

## How host updates arrive

- **Hourly:** each Mac's updater builds only when `pin.json` moved or the repo's own
  commit did (a signed T3 Blackout commit rebuilds the same release with it).
  Self-update first takes any new signed commits from the repo and checks any pin the
  evaluator signed (README, "Updates to T3 Blackout itself"), then the updater builds
  the pinned release. A pin whose new dependencies are under 3 days old is held: the
  log says "self-update held", and the Mac stays on the pin it has until they've aged.
- **Update everything** (in the app): for an SSH host it drops a request into the
  host's `/Users/Shared/t3blackout/update-requests`, which starts that host's updater
  (the build usually takes 15 to 20 minutes). The app shows the host as "update
  requested", not updated, and its toast says "Update requested on N servers". On the
  host, nobody is using the app there, so the new build installs as soon as it's
  built.
- **The running server keeps its build** until the next connection. To move to the
  new one, switch the environment off and on again (Settings → Connections →
  Environments, its switch): switching off stops the remote server, and the next
  start runs the installed build. A server started from a build that has since been
  replaced is also stopped when a connection starts (SIGTERM, then SIGKILL after 5
  seconds), but an automatic reconnect can reuse a live tunnel and stay on the old
  server. If the old server won't stop, the connection fails with "T3 Blackout server
  … still runs a build this host has replaced and did not stop; stop it (kill -9 …)
  and connect again"; do that as the agent account. Each account keeps one record per
  server in `~/.t3blackout/ssh-servers/` (its pid, start time and build, the server's
  command line and that of the runner starting it), so a reconnect while a server is
  still starting recognises it too, and stops it if its build was replaced.
- **By hand on a host:** as the admin account that installed it,
  `~/.t3blackout/bin/t3blackout update`.
- **On the desktop Mac,** a new build waits while the app is open; the standby lane
  runs the desktop's app, so it moves too after the app restarts into the new build
  and you switch the standby environment off and on. A waiting build made by another
  T3 Blackout commit than the clone's (an older one, when a self-update landed and
  its rebuild failed) isn't installed by a restart or `bin/t3blackout launch`; the
  next update rebuilds it.
- Machines install on their own schedules, so for a while the desktop and a host can
  be a build apart. Upstream's protocol check refuses only versions that can't talk
  to each other and says to update. If pairing fails (an HTTP 500) right after a
  host update, an old server is still running: switch the environment off and on.

## What this doesn't protect

- **Your local network.** Remote Login on the host listens on every interface, so
  machines on the same LAN can reach its SSH port. Tailscale's policy doesn't apply
  to LAN connections, and no firewall rules are added. Once the disk is unlocked,
  only agent accounts can log in there, only with an authorized key, never with a
  password.
- **The FileVault unlock at startup.** While the host's disk is locked after an
  unplanned restart (macOS 26 or later, Apple silicon), the same port on your LAN
  takes a password for any account that can unlock the disk, regardless of the
  settings above (3.1). It unlocks the disk and opens no session, but a guessed
  password there is that account's password. Keep `sudo fdesetup list` to your admin
  account and its password strong; with Remote Login off (the desktop Mac) there's no
  such unlock.
- **Agents in the same account.** Everything running as one agent account (its
  agents, the CLIs, their tools) can read that account's provider tokens and files.
  Accounts are separated by ordinary macOS permissions; the agents' network access
  is whatever their own sandboxes or yours allow.
- **Your SSH key.** Whoever can use it (your 1Password, or anything you approve in
  its agent) can log in to every agent account. Your admin account on each Mac has
  `sudo`, so compromising it compromises the Mac.
- **Vendor self-updaters.** `claude update`, `codex update` and the CLIs'
  auto-updates aren't held to the 3-day minimum, and neither is the app's Update for a
  CLI installed with its vendor's installer or Homebrew (3.5).
- **Tailscale.** Without Tailnet Lock, the coordination server could add a device to
  your tailnet. The desktop app variant uploads client logs.
- **Unattended restarts.** After a restart, the host is unreachable until FileVault
  is unlocked.
- **First real run.** The privileged parts of the account script (creating accounts,
  the group and access-list changes, the loopback sshd running as root with PAM),
  code signing from the host's LaunchDaemon, and replacing `/Applications/T3
  Blackout.app` from a background job were checked with stubs, scratch configs and
  unprivileged runs, not end to end on real Macs. The checks in section 7 are how
  you confirm them. If macOS's App Management protection blocks the swap, the
  update keeps the new build staged and the installed one running. Device streaming
  was measured against test streams, not real simulators in an agent account over
  real SSH; 5.3's checks confirm it. 5.3's Android steps follow Google's
  documentation and the tools' own files, and haven't been run on a Mac; whether an
  emulator boots for an account that isn't logged in at the screen is what its check
  finds out.
- The README's "Limits, stated plainly" covers the build and update pipeline.

## Troubleshooting

- **`Permission denied (publickey)` or `Too many authentication failures`:** `ssh -v
  agent-claude@t3b-host` shows which keys were offered. Usually `~/.ssh/config` lacks
  the `IdentityAgent` line or the `Host t3b-host localhost 127.0.0.1 ::1` block
  (section 1), 1Password is locked, or the account script authorized a different
  key: rerun it with `--key ~/.ssh/t3blackout.pub`.
- **`Host key verification failed` in the app, or `REMOTE HOST IDENTIFICATION HAS
  CHANGED` in Terminal:** the host was rebuilt (new keys) or this is the first
  connection. Remove the old entry (`ssh-keygen -R t3b-host`, plus its `100.x`
  address if you used it), then repeat 5.1 and compare fingerprints. For the
  standby lane, rerun its account script.
- **`Connection refused` on port 22:** Remote Login is off, or your account isn't
  allowed: rerun the account script and check the access list (3.3).
- **Timeouts:** the Mac isn't on the tailnet or the policy doesn't allow it.
  `tailscale status` on the desktop Mac; try the `100.x` address; check the policy
  tests and that both machines carry their tags.
- **The host is `t3b-host-1`:** the old machine still existed. Delete it in the
  admin console and rename the new one.
- **The host dropped off after weeks:** its key expired. Disable key expiry (2.2) and
  re-authenticate it.
- **"T3 Blackout is not installed on this host":** run `./install.sh --role host`
  there (the app must be in `/Applications`).
- **"…server.env must belong to you and be readable only by you":** run
  `/usr/local/libexec/t3blackout/set-claude-token` again as that account.
- **Claude says it isn't logged in over SSH:** no token in `server.env` (3.6); a
  Keychain login doesn't work over SSH.
- **A provider shows as not installed:** its CLI isn't on the login shell's `PATH`.
  Check with the `zsh -ilc` command in 3.5, fix `~/.zprofile`, then switch the
  environment off and on.
- **`Error: claude native binary not installed.`:** npm skipped Claude Code's install
  script (npm 12 does unless told to allow it). Rerun the `npm install -g …` line in
  3.5 as that account; it has `--allow-scripts=@anthropic-ai/claude-code`.
- **Settings won't update a provider, "…installed with bun/yarn/Volta/Vite+, which
  can't hold its dependencies to the 3-day minimum release age":** reinstall that CLI
  with npm as in 3.5.
- **An ACP Registry agent "isn't supported in T3 Blackout":** it ships only a prebuilt
  binary, and T3 Blackout installs agents only from npm or PyPI packages (npx, uvx).
- **A simulator won't boot in a host account, or the Device panel never shows one:**
  run the SSH boot check in 5.3 as that account. If it works only while the account
  is logged in at the host's screen, keep it logged in there.
- **"Android SDK was not found…" or "…missing from…"** (Platform-Tools, the
  Emulator, Command-line Tools (latest)) for an account whose SDK is installed: the
  server never sees `ANDROID_HOME`. Install the SDK in `~/Library/Android/sdk` with
  5.3's `sdkmanager` line (it includes `cmdline-tools;latest`), then switch the
  environment off and on.
- **"JAVA_HOME is not set and no 'java' command could be found"** (from `avdmanager`
  or `sdkmanager`): `openjdk@17` isn't installed, or that account's `~/.zprofile`
  lacks 5.3's `JAVA_HOME` and `PATH` lines.
- **An agent's iOS taps fail while it builds its test runner, with a Developer Tools
  authorization error:** a standard account can't answer that macOS prompt over SSH.
  From your admin account on that Mac: `sudo DevToolsSecurity -enable` and `sudo
  dseditgroup -o edit -a agent-claude -t user _developer`, then try again.
- **An EAS Simulator device shows no video:** the network blocks UDP, and T3
  Blackout has no TURN over TCP or TLS (5.3). Use a network that allows UDP. Local
  and host simulators don't depend on it.
- **"This host has no T3 Blackout update agent":** the host's request folder is
  missing; run `bin/t3blackout schedule` as the installing admin there.
- **The host doesn't update:** `bin/t3blackout status` (schedule line);
  `sudo launchctl print system/dev.t3blackout.update`; `state/t3blackout.log` and
  `state/update.out.log` in the clone. A clone inside `~/Documents`, `~/Desktop` or
  `~/Downloads` is blocked for the daemon: move it and rerun `./install.sh --role host`.
- **The standby sshd isn't listening:** `/var/log/dev.t3blackout.sshd.log`; rerun its
  account script.
- **"self-update refused" notification:** origin has commits that aren't signed by
  a key in `.allowed_signers`, or an evaluator pin the Mac couldn't verify.
  `state/t3blackout.log` says which.
- **"self-update held" in the log** (no notification): the evaluator's newest pin adds
  a dependency under 3 days old. The Mac keeps building the pin it has and takes the
  new one once the dependency has aged. Checking needs github.com, the npm registry
  and OSV.dev; "self-update skipped: couldn't …" means one wasn't reachable.
- **"self-update skipped: couldn't fetch (refusing to reach … its own git
  configuration sets …)"** in the log: the clone's own `.git/config` sets something
  that decides how git connects (a URL rewrite, `http.*`, `credential.*`, a proxy or
  transport program, `protocol.*.allow`, a partial clone). A plain `git clone` sets
  none. Remove what it names (`git config --unset-all <key>` in the clone); until
  then the Mac never takes new commits or pins (README, "Updates to T3 Blackout
  itself").
- **"self-update skipped: couldn't fetch (origin isn't a github.com repository URL,
  …)"** in the log: the clone's `origin` is an SSH host alias or another non-GitHub
  URL, which self-update never fetches. `git remote set-url origin
  https://github.com/<owner>/t3blackout.git` in the clone (an SSH alias for pushing
  can go in the push URL: `git remote set-url --push origin …`).
- **"T3 Blackout update not applied" after a restart, "the staged build was made with
  T3 Blackout …"** (or "staged build not installed" in the log after
  `bin/t3blackout launch`): the waiting build came from another T3 Blackout commit
  than the clone's. The installed build keeps running; `bin/t3blackout update` (or
  the next hourly run) rebuilds it.
- **`install.sh` stops with "git 2.45 or newer is required":** an older git comes
  first on your `PATH`. Put Homebrew's folder first (the `eval` line from section 1,
  step 3, in `~/.zprofile`), open a new Terminal window, check `git --version`, rerun.
- **Updates or `poll` fail with "… in the upstream mirror failed: unknown option:
  --no-lazy-fetch":** the git on the updater's `PATH` is older than 2.45 (say, the
  `PATH` changed since `install.sh` ran). `brew install git`, check `git --version`,
  then `~/.t3blackout/bin/t3blackout update`.
- **Every command stops with an error about `state/install.json`:** the file is
  unreadable or invalid. `bin/t3blackout configure --role host` (or `ui`, `both`)
  writes a new one; then `bin/t3blackout status`.
- **Every command stops with "… is this clone (…) or inside it" or "… isn't an
  absolute path"** (or similar): a location variable (`T3BLACKOUT_HOME`,
  `T3BLACKOUT_APPS`, …) in the environment can't be used. Unset it, or set it to an
  absolute path outside the clone, and rerun `./install.sh --role …`. An empty one
  counts as unset.
- **`status` shows `interrupted:`:** an install or rollback was cut off. The next
  `bin/t3blackout update` or `rollback` finishes or undoes it first. If that stops
  with "`state/activation.json` is damaged (…)" or "says its build went in, but
  nothing is installed", the journal is one this install can't trust. Compare the
  app folders (`/Applications/T3 Blackout.app` and the hidden `.T3 Blackout.previous`,
  `.outgoing`, `.new` and `.pending` copies beside it) with `state/current.json` by
  hand, so that `T3 Blackout.app` is the build that file names, then remove
  `state/activation.json`.

## Minimum versions and tokens

From the October 2026 incidents:

| What | Minimum | Why |
|---|---|---|
| Node (Homebrew, for `bin/t3blackout` and the CLIs) | 24.22.1 or 26.12.1 (`install.sh` refuses older) | Brotli decoder RCE (CVE-2026-111497, actively exploited) and TLS hostname bypasses; eMudhra trust-store fix |
| T3 Blackout's Electron | 44.10.0 (Node 24.22.1 inside) | The app's server runs on Electron's Node, here and on SSH hosts; the pin moves it, and the evaluator's fast lane takes such updates ahead of the age gate |
| Tailscale | 1.104.2 (Go 1.27.3) | Rejects the compromised eMudhra intermediate CAs ([TS-2026-013](https://tailscale.com/security-bulletins)) |

- **No GitHub tokens with `workflow` scope on agent accounts.** Stolen GitHub CLI
  tokens built LiteLLM's malicious release, and GhostAction used stolen tokens to push
  workflows that read repository secrets. Anyone who can push a workflow to this
  repository can read the evaluator's signing key. Your own account may keep
  `workflow` scope; rotate it when you rebuild a Mac.
- **If the evaluator key leaks,** the worst it can do is pin a real, newer upstream
  release whose new dependencies have aged or are accepted by the Mac's own security
  fast lane (a fix for an advisory open against the current pin, or a same-major
  Electron that takes in a Node.js security release or any new Chromium, from its
  usual publisher; README, "Security fast lane"): every Mac accepts only
  `pin.json`-only, forward-only evaluator commits, checks each one's tag against
  upstream with `git ls-remote`, works out its dependency age, fast lane, bytes and
  device-tool reviews again itself, then strips, typechecks, scans and smoke-tests
  the build itself. A commit you sign that rewrites `pin.json` replaces whatever it
  pinned. Rotate it anyway: a new key, the `T3BLACKOUT_EVALUATOR_SIGNING_KEY` secret,
  and its line in `.allowed_signers` in a commit the repository owner signs.
